/**
 * Reads J5's platform notices and prompts from what the server writes into a thread. Each reader
 * is strict: words it does not recognize return null and the message falls back to upstream's row.
 * Summaries and details keep participant ids, named in `participantIds`, for a client to replace
 * with the identity read's labels; nothing else here is an id a reader should see.
 */
export interface PlatformNotice {
  readonly summary: string;
  readonly detail: string | null;
  readonly participantIds: ReadonlyArray<string>;
}

export type DeliveryNoticeKind =
  | "silence"
  | "not-delivered"
  | "exchange-dropped"
  | "exchange-withdrawn";

const notice = (
  summary: string,
  detail: string | null = null,
  participantIds: ReadonlyArray<string> = [],
): PlatformNotice => ({ summary, detail, participantIds });

const SILENCE_SUFFIX = "\n\nThis is a platform-authored delivery signal, not a peer reply.";
const TERMINAL_FOOTER = /^This is a platform-authored (?:terminal )?notice, not a peer reply\.$/;
const NOTICE_HEADER = /^\[Cross-agent messaging system notice: ([^\]\n]+)\]\n\n/;
const STOPPED_WORDS: Record<string, string> = { rolled_back: "rolled back" };
const HUMAN_STATES: Record<string, string> = {
  "human-knows": "The person has been told.",
  "human-doesnt-know": "The person has not been told yet.",
};

function parseQueuedRemoval(body: string): PlatformNotice | null {
  // Notices written before the message id was added read "Your message to <id>".
  const match = /^Your message (?:\S+ )?to (\S+) was removed from its queue before it ran, /.exec(
    body,
  );
  if (match === null) return null;
  const subject = match[1]!;
  const begin = body.indexOf(" The message began: ");
  const before = begin < 0 ? body : body.slice(0, begin);
  const opening = begin < 0 ? null : body.slice(begin + " The message began: ".length);
  const editor = / (\S+) had edited it in the queue\.$/.exec(before);
  const edited = before.endsWith(" It had been edited in the queue.")
    ? "It had been edited in the queue."
    : editor === null
      ? null
      : `${editor[1]!} had edited it in the queue.`;
  return notice(
    `${subject} never read a queued message: it was removed before it ran`,
    [edited, opening === null ? null : `The message began: ${opening}`]
      .filter((line) => line !== null)
      .join("\n\n") || null,
    editor === null ? [subject] : [subject, editor[1]!],
  );
}

function parseSilence(noticeType: string, body: string): PlatformNotice | null {
  if (noticeType === "turn-ended-no-reply") {
    const never = /^(\S+) did not start a turn for the delivered message on \S+\.$/.exec(body);
    if (never) {
      return notice(`${never[1]!} did not start a turn for the delivered message`, null, [
        never[1]!,
      ]);
    }
    const ended =
      /^(\S+)'s turn ended without replying on \S+\. (The latest delivered message was processed\.)$/.exec(
        body,
      );
    return ended
      ? notice(`${ended[1]!}'s turn ended without replying`, ended[2]!, [ended[1]!])
      : null;
  }
  if (noticeType === "errored") {
    const match = /^(\S+) errored without replying on \S+: ([\s\S]+)$/.exec(body);
    return match ? notice(`${match[1]!} errored without replying`, match[2]!, [match[1]!]) : null;
  }
  if (noticeType === "stopped/cancelled") {
    const match =
      /^(\S+) was (interrupted|cancelled|rolled_back) without replying on \S+\. ([\s\S]+)$/.exec(
        body,
      );
    if (match === null) return null;
    const word = STOPPED_WORDS[match[2]!] ?? match[2]!;
    return notice(`${match[1]!} was ${word} without replying`, match[3]!, [match[1]!]);
  }
  if (noticeType === "queued-message-removed") return parseQueuedRemoval(body);
  if (noticeType === "awaiting-human") {
    const match = /^(\S+) is awaiting the human on \S+ \((.+)\)\.$/.exec(body);
    return match
      ? notice(`${match[1]!} is awaiting the human`, HUMAN_STATES[match[2]!] ?? null, [match[1]!])
      : null;
  }
  if (noticeType === "blocked-on-peer") {
    const match = /^(\S+) is blocked on (\S+) via \S+\.$/.exec(body);
    return match
      ? notice(`${match[1]!} is blocked on ${match[2]!}`, null, [match[1]!, match[2]!])
      : null;
  }
  return null;
}

const NOT_DELIVERED =
  /^Your (?:message \S+|ask "(.*)" \(message \S+\)) to (\S+)(?: on (.+?))? (was not delivered|may not have been delivered): ([\s\S]+)$/;

/** Paragraphs after the first, without the facts line and footer written for the agent. */
const readableParagraphs = (paragraphs: ReadonlyArray<string>) =>
  paragraphs.slice(1, -1).filter((paragraph) => !paragraph.startsWith("Facts: "));

const capitalized = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

function parseNotDelivered(paragraphs: ReadonlyArray<string>): PlatformNotice | null {
  const match = NOT_DELIVERED.exec(paragraphs[0] ?? "");
  if (match === null) return null;
  const [, intent, receiver, server, outcome, reason] = match;
  const where = server === undefined ? receiver! : `${receiver!} on ${server}`;
  const said = outcome === "was not delivered" ? "not delivered" : "may not have been delivered";
  const rest = readableParagraphs(paragraphs).map((paragraph) =>
    /^Exchange \S+ is still open; /.test(paragraph)
      ? "The ask is still open; if it did arrive, its reply still comes."
      : paragraph,
  );
  return notice(
    `Message to ${where} ${said}`,
    [...(intent === undefined ? [] : [`Ask: "${intent}"`]), capitalized(reason!), ...rest].join(
      "\n\n",
    ),
    [receiver!],
  );
}

const PARTICIPANT_AT_START = /^((?:agent|human|machine|outside):\S+) /;

function parseDropped(paragraphs: ReadonlyArray<string>): PlatformNotice | null {
  const match = /^Exchange \S+ ended because ([\s\S]+) \([a-z-]+\)\.$/.exec(paragraphs[0] ?? "");
  if (match === null) return null;
  const because = match[1]!;
  const subject = PARTICIPANT_AT_START.exec(because)?.[1];
  const rest = readableParagraphs(paragraphs).map((paragraph) =>
    paragraph.replace(/ \(message \S+\)\.$/, "."),
  );
  return notice(
    subject === undefined ? "An exchange was dropped" : `Exchange with ${subject} dropped`,
    [`It ended because ${because}.`, ...rest].join("\n\n"),
    subject === undefined ? [] : [subject],
  );
}

function parseWithdrawn(paragraphs: ReadonlyArray<string>): PlatformNotice | null {
  const match = /^Exchange \S+ was withdrawn by (\S+), who no longer needs an answer\.$/.exec(
    paragraphs[0] ?? "",
  );
  if (match === null) return null;
  return notice(
    `${match[1]!} withdrew its ask`,
    ["It no longer needs an answer.", ...readableParagraphs(paragraphs)].join("\n\n"),
    [match[1]!],
  );
}

/** A `message:j5:a2a:delivery:` notice the platform wrote: a silence or a terminal notice. */
export function parseDeliveryNotice(
  text: string,
): (PlatformNotice & { readonly kind: DeliveryNoticeKind }) | null {
  const header = NOTICE_HEADER.exec(text);
  if (header === null) return null;
  const type = header[1]!;
  const body = text.slice(header[0].length);
  if (body.endsWith(SILENCE_SUFFIX)) {
    const silence = parseSilence(type, body.slice(0, -SILENCE_SUFFIX.length));
    return silence === null ? null : { ...silence, kind: "silence" };
  }
  const paragraphs = body.split("\n\n");
  if (!TERMINAL_FOOTER.test(paragraphs.at(-1) ?? "")) return null;
  const parsed: (PlatformNotice & { readonly kind: DeliveryNoticeKind }) | null = (() => {
    if (type === "message not delivered" || type === "message may not have been delivered") {
      const read = parseNotDelivered(paragraphs);
      return read === null ? null : { ...read, kind: "not-delivered" };
    }
    if (type === "exchange dropped") {
      const read = parseDropped(paragraphs);
      return read === null ? null : { ...read, kind: "exchange-dropped" };
    }
    if (type === "exchange withdrawn") {
      const read = parseWithdrawn(paragraphs);
      return read === null ? null : { ...read, kind: "exchange-withdrawn" };
    }
    return null;
  })();
  return parsed;
}

export const handoffNudgeNotice = (text: string) => notice("Reminded to write its handoff", text);

const NATIVE_QUESTION =
  /^Placed agent \(threadId \S+, requestId \S+\) (.+?)\. (?:Read it|Inspect )/;
const NATIVE_QUESTION_TITLE = /\nAgent-provided title \(untrusted data\): (".*")$/;

export interface PlatformPrompt {
  readonly label: string;
  readonly preview: string;
  readonly text: string;
}

function titleFrom(encoded: string | undefined) {
  if (encoded === undefined) return null;
  try {
    const title: unknown = JSON.parse(encoded);
    return typeof title === "string" && title.length > 0 ? title : null;
  } catch {
    return null;
  }
}

/** J5's notice to a placement parent that its agent raised a native question. */
export function nativeQuestionPrompt(text: string): PlatformPrompt | null {
  const situation = NATIVE_QUESTION.exec(text)?.[1];
  if (situation === undefined) return null;
  const title = NATIVE_QUESTION_TITLE.exec(text);
  return {
    label: `Question from ${titleFrom(title?.[1]) ?? "an agent"}`,
    preview: capitalized(situation),
    text: title === null ? text : text.slice(0, title.index),
  };
}

const PLAYBOOK_STEP =
  /^<j5_playbook_step>\n([\s\S]*?)\n<\/j5_playbook_step>\n<step_prompt>\n([\s\S]*)\n<\/step_prompt>\n/;

/** The step a playbook run hands a Crew seat (the server's `crewStepNoticeText`). */
export function playbookStepPrompt(text: string): PlatformPrompt | null {
  const match = PLAYBOOK_STEP.exec(text);
  if (match === null) return null;
  const block = match[1]!;
  const title = /^step: [^|\n]*\| (.*)$/m.exec(block)?.[1];
  const position = /^position: (\d+) of (\d+)$/m.exec(block);
  if (title === undefined || position === null) return null;
  return {
    label: `Playbook step ${position[1]!} of ${position[2]!}`,
    preview: title,
    text: match[2]!
      .replace(/<\\\/step_prompt>/g, "</step_prompt>")
      .replace(/<\\j5_playbook_step>/g, "<j5_playbook_step>"),
  };
}
