import {
  SHARING_DESCRIBE_PATH,
  SHARING_JOIN_PATH,
  isPersonName,
  type SharingLinkDescription,
} from "@t3tools/contracts/j5";
import { FolderCodeIcon } from "lucide-react";
import type { IconName } from "lucide-react/dynamic";
import {
  type ComponentProps,
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  PairingPendingSurface,
  PairingRouteSurface,
} from "../../components/auth/PairingRouteSurface";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { ProjectMonogram } from "../../components/ProjectMonogram";
import { StandalonePage, StandalonePageHeader } from "../../components/ui/standalone-page";
import {
  peekPairingTokenFromUrl,
  resolvePrimaryEnvironmentHttpUrl,
  stripPairingTokenFromUrl,
  submitServerAuthCredential,
} from "../../environments/primary";
import { APP_DISPLAY_NAME } from "../../branding";
import { projectIconColorClassName } from "../../projectIconColors";
import { pairThroughShareLink } from "./pairedThroughShareLink";
import { isMarkedShareLink, NAME_NOT_USABLE } from "./shareLink.logic";
import {
  invitationFor,
  DESCRIBE_TIMEOUT_MS,
  invitationList,
  joinPageState,
  type InvitationLine as ListedLine,
  type JoinPageState,
} from "./joinPage.logic";

// Loaded only for a project whose chosen icon is a named glyph, as upstream's own icon does.
const DynamicIcon = lazy(() =>
  import("lucide-react/dynamic").then((module) => ({ default: module.DynamicIcon })),
);

const post = (path: string, body: unknown, signal?: AbortSignal) =>
  fetch(resolvePrimaryEnvironmentHttpUrl(path), {
    method: "POST",
    ...(signal === undefined ? {} : { signal }),
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "include",
  });

const messageOf = (error: unknown) =>
  error instanceof Error && error.message.trim() !== "" ? error.message : "Pairing failed.";

/**
 * The pairing page for a link that may be a guest's. It asks the server what the link opens
 * before anything is spent, so a person sees who they are joining as and what they were invited
 * to (the page names no one who shared). A link the server says nothing about, an ordinary
 * pairing link among them, is handed to upstream's pairing page as it is.
 */
export function GuestAwarePairingSurface(props: ComponentProps<typeof PairingRouteSurface>) {
  const [secret] = useState(() => peekPairingTokenFromUrl());
  // Only a link J5 made is asked about. An ordinary pairing link goes to upstream's page at once
  // and its token is sent nowhere else.
  const [marked] = useState(() => isMarkedShareLink(window.location.href));
  const [state, setState] = useState<JoinPageState | null>(
    secret === null || !marked ? { kind: "upstream" } : null,
  );

  useEffect(() => {
    if (secret === null || !marked) return;
    let cancelled = false;
    void post(SHARING_DESCRIBE_PATH, { link: secret }, AbortSignal.timeout(DESCRIBE_TIMEOUT_MS))
      .then(async (response) => ({
        status: response.status as number | null,
        body: (await response.json().catch(() => null)) as unknown,
      }))
      .catch(() => ({ status: null, body: null }))
      .then((answer) => {
        if (cancelled) return;
        setState(joinPageState({ marked, ...answer }));
      });
    return () => {
      cancelled = true;
    };
  }, [marked, secret]);

  if (state === null) return <PairingPendingSurface />;
  if (state.kind === "upstream" || secret === null) return <PairingRouteSurface {...props} />;
  if (state.kind === "dead") {
    return (
      <StandalonePage tone="pairing">
        <StandalonePageHeader
          eyebrow={APP_DISPLAY_NAME}
          title="This link does not work"
          description="It may have been used, expired or revoked. Ask whoever sent it for a new one."
        />
      </StandalonePage>
    );
  }
  return state.description.kind === "open" ? (
    <JoinLinkSurface
      token={secret}
      description={state.description}
      onAuthenticated={props.onAuthenticated}
    />
  ) : (
    <NamedLinkSurface
      credential={secret}
      description={state.description}
      onAuthenticated={props.onAuthenticated}
    />
  );
}

function InvitationLine({ description }: { readonly description: SharingLinkDescription }) {
  const { before, title, after } = invitationFor(description);
  return (
    <>
      {before}
      {title === null ? null : <strong className="font-semibold text-foreground">{title}</strong>}
      {after}
    </>
  );
}

/**
 * A project's icon on the join page, which is drawn before anything is paired: the icon a person
 * chose, else the project's favicon through the server's signed link, else the default.
 */
function JoinPageIcon({ line }: { readonly line: ListedLine }) {
  const [faviconFailed, setFaviconFailed] = useState(false);
  const className = "size-3.5 shrink-0";
  if (line.icon?.kind === "emoji") {
    return (
      <span aria-hidden className={`${className} text-xs leading-none`}>
        {line.icon.emoji}
      </span>
    );
  }
  if (line.icon?.kind === "monogram") {
    return <ProjectMonogram text={line.icon.text} color={line.icon.color} className={className} />;
  }
  if (line.icon?.kind === "lucide") {
    const fallback = () => <FolderCodeIcon aria-hidden className="size-full" />;
    return (
      <span
        aria-hidden
        className={`${className} inline-flex ${projectIconColorClassName(line.icon.color)}`}
      >
        <Suspense fallback={fallback()}>
          <DynamicIcon
            name={line.icon.name as IconName}
            className="size-full"
            fallback={fallback}
          />
        </Suspense>
      </span>
    );
  }
  if (line.icon === null && line.faviconUrl !== null && !faviconFailed) {
    return (
      <img
        alt=""
        className={`${className} rounded-sm`}
        src={resolvePrimaryEnvironmentHttpUrl(line.faviconUrl)}
        onError={() => setFaviconFailed(true)}
      />
    );
  }
  return <FolderCodeIcon aria-hidden className={`${className} text-muted-foreground`} />;
}

function InfoBox({ children }: { readonly children: ReactNode }) {
  return (
    <div className="mt-6 rounded-lg border border-border/70 bg-background/55 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
      {children}
    </div>
  );
}

function NamedLinkSurface({
  credential,
  description,
  onAuthenticated,
}: {
  readonly credential: string;
  readonly description: SharingLinkDescription;
  readonly onAuthenticated: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const list = invitationList(description);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    stripPairingTokenFromUrl();
    // The browser is remembered as a guest's only once the server has paired it as one.
    void pairThroughShareLink(credential, submitServerAuthCredential).then(
      onAuthenticated,
      (cause: unknown) => setError(messageOf(cause)),
    );
  }, [credential, onAuthenticated]);

  return (
    <StandalonePage tone="pairing">
      <StandalonePageHeader
        eyebrow={APP_DISPLAY_NAME}
        title={`Joining as ${description.personName ?? "a guest"}`}
        description={<InvitationLine description={description} />}
      />
      {list.lines.length > 0 ? (
        <ul className="mt-4 flex flex-col gap-1.5 text-sm">
          {list.lines.map((line, index) => (
            // Titles can repeat; the list is fixed for the life of the page.
            // oxlint-disable-next-line react/no-array-index-key -- a static list read once from the lookup
            <li key={index} className="flex min-w-0 items-center gap-2">
              <JoinPageIcon line={line} />
              <span className="min-w-0 truncate">{line.title}</span>
              {line.detail === null ? null : (
                <span className="shrink-0 text-muted-foreground">· {line.detail}</span>
              )}
            </li>
          ))}
          {list.more > 0 ? <li className="text-muted-foreground">and {list.more} more</li> : null}
        </ul>
      ) : null}
      {error === null ? (
        <InfoBox>
          {description.opens.length === 1 && description.opens[0]?.kind === "thread"
            ? "Pairing this browser. You will land on the thread in a moment."
            : "Pairing this browser. You will land on what is shared with you in a moment."}
        </InfoBox>
      ) : (
        <div className="mt-6 flex flex-col gap-3">
          <Alert variant="error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
          <div>
            <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
              Reload app
            </Button>
          </div>
        </div>
      )}
    </StandalonePage>
  );
}

function JoinLinkSurface({
  token,
  description,
  onAuthenticated,
}: {
  readonly token: string;
  readonly description: SharingLinkDescription;
  readonly onAuthenticated: () => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const join = async () => {
    const displayName = name.trim();
    if (!isPersonName(displayName)) {
      setError(NAME_NOT_USABLE);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await post(SHARING_JOIN_PATH, { token, displayName });
      const body = (await response.json().catch(() => null)) as {
        readonly credential?: unknown;
        readonly message?: unknown;
      } | null;
      if (!response.ok || typeof body?.credential !== "string") {
        setError(
          typeof body?.message === "string"
            ? body.message
            : "The server could not let you in. Try again.",
        );
        return;
      }
      stripPairingTokenFromUrl();
      await pairThroughShareLink(body.credential, submitServerAuthCredential);
      onAuthenticated();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <StandalonePage tone="pairing">
      <StandalonePageHeader
        eyebrow={APP_DISPLAY_NAME}
        title="Join a shared thread"
        description={<InvitationLine description={description} />}
      />
      <form
        className="mt-6 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void join();
        }}
      >
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="join-name">
            Your name
          </label>
          <Input
            id="join-name"
            autoComplete="name"
            autoFocus
            disabled={busy}
            maxLength={80}
            nativeInput
            onChange={(event) => setName(event.currentTarget.value)}
            value={name}
          />
        </div>
        {error === null ? null : (
          <Alert variant="error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Button disabled={busy || name.trim() === ""} size="sm" type="submit">
          {busy ? "Joining…" : "Join"}
        </Button>
      </form>
      <InfoBox>
        This link can be opened by several people. Each one joins on one device, and a member of the
        server can change your name or remove you.
      </InfoBox>
    </StandalonePage>
  );
}
