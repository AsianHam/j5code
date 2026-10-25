import {
  type LinkedPrompt,
  parseNewThreadLink,
  parseThreadLinkPrompt,
  promptLinkAppPath,
  promptLinkDeepLink,
  type PromptLinkResult,
} from "@t3tools/shared/promptLinks";

export interface PromptLinkPage {
  /** The path a J5 web app opens, such as `/new?prompt=…`. */
  readonly appPath: string;
  readonly deepLink: string;
  readonly prompt: LinkedPrompt | null;
  readonly details: ReadonlyArray<string>;
}

/** Reads a j5.codes prompt link, `/new?…` or `/<environment>/<thread>?prompt=…`, as the page shows it. */
export function readPromptLinkPage(href: string): PromptLinkResult<PromptLinkPage> {
  const url = new URL(href);
  // Static hosting serves the page at `/new/` as well as `/new`.
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  const appPath = promptLinkAppPath(url.href, url.origin);
  if (appPath === null) return { ok: false, error: "This link has no prompt." };
  const page = (prompt: LinkedPrompt | null, details: ReadonlyArray<string>) => ({
    ok: true as const,
    value: { appPath, deepLink: promptLinkDeepLink(appPath), prompt, details },
  });
  const { pathname, search } = new URL(appPath, url.origin);
  if (pathname !== "/new") {
    const prompt = parseThreadLinkPrompt(search);
    return prompt.ok ? page(prompt.value, ["Opens one of your threads."]) : prompt;
  }
  const link = parseNewThreadLink(search);
  if (!link.ok) return link;
  if (link.value.kind === "pull-request") {
    const { owner, name, number } = link.value.pullRequest;
    return page(link.value.prompt, [`Pull request ${owner}/${name}#${number}`]);
  }
  const { prompt, repository, provider, model } = link.value;
  return page(prompt, [
    repository ? `Repository ${repository.owner}/${repository.name}` : "No project",
    ...(provider ? [`Model ${model ? `${provider} ${model}` : provider}`] : []),
  ]);
}

// A bare address for this machine or one on the local network is usually served over http.
const PLAIN_HTTP_HOST =
  /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[\da-f:.]+\])(?::\d+)?(?:[/?#]|$)/i;

/** The link that opens the prompt on the person's own J5 server, or null for an address it cannot use. */
export function serverPromptLinkUrl(address: string, appPath: string): string | null {
  const trimmed = address.trim();
  if (trimmed.length === 0) return null;
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `${PLAIN_HTTP_HOST.test(trimmed) ? "http" : "https"}://${trimmed}`;
  if (!URL.canParse(withScheme)) return null;
  const server = new URL(withScheme);
  if (server.protocol !== "http:" && server.protocol !== "https:") return null;
  return new URL(appPath, server.origin).href;
}
