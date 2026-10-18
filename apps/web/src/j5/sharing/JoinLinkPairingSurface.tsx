import {
  J5_LINK_DESCRIBE_PATH,
  J5_LINK_JOIN_PATH,
  isMarkedShareLink,
  isPersonName,
  type LinkDescription,
} from "@t3tools/contracts/j5";
import { type ComponentProps, useEffect, useState } from "react";

import {
  PairingPendingSurface,
  PairingRouteSurface,
} from "../../components/auth/PairingRouteSurface";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { StandalonePage, StandalonePageHeader } from "../../components/ui/standalone-page";
import {
  peekPairingTokenFromUrl,
  resolvePrimaryEnvironmentHttpUrl,
  stripPairingTokenFromUrl,
  submitServerAuthCredential,
} from "../../environments/primary";
import { APP_DISPLAY_NAME } from "../../branding";
import { NAME_NOT_USABLE } from "./shareLink.logic";
import {
  ALREADY_YOURS,
  asYourselfWords,
  DESCRIBE_TIMEOUT_MS,
  invitationFor,
  joinPageState,
  joinRefusal,
  joinView,
  refusalWords,
  someoneElsesWords,
  type JoinPageState,
} from "./joinPage.logic";

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
 * The pairing page for a link that may be J5's (People and access AC42, design §4). It asks the
 * server what the link opens before anything is spent, so a person sees the server, what they
 * are invited to and at what level, and confirms or types their name. A link the server says
 * nothing about, an ordinary pairing link among them, is handed to upstream's pairing page.
 */
export function JoinLinkPairingSurface(props: ComponentProps<typeof PairingRouteSurface>) {
  const [token] = useState(() => peekPairingTokenFromUrl());
  // Only a link J5 made is asked about. An ordinary pairing link goes to upstream's page at once
  // and its token is sent nowhere else.
  const [marked] = useState(() => isMarkedShareLink(window.location.href));
  const [state, setState] = useState<JoinPageState | null>(
    token === null || !marked ? { kind: "upstream" } : null,
  );

  useEffect(() => {
    if (token === null || !marked) return;
    let cancelled = false;
    void post(J5_LINK_DESCRIBE_PATH, { token }, AbortSignal.timeout(DESCRIBE_TIMEOUT_MS))
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
  }, [marked, token]);

  if (state === null) return <PairingPendingSurface />;
  if (state.kind === "upstream" || token === null) return <PairingRouteSurface {...props} />;
  if (state.kind === "dead") return <DeadLink />;
  return (
    <JoinSurface
      token={token}
      description={state.description}
      onAuthenticated={props.onAuthenticated}
    />
  );
}

function DeadLink() {
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

function InvitationLine({ description }: { readonly description: LinkDescription }) {
  const words = invitationFor(description);
  return (
    <>
      {words.before}
      {words.title === null ? null : (
        <strong className="font-semibold text-foreground">{words.title}</strong>
      )}
      {words.level === null ? null : (
        <>
          {words.after}{" "}
          <span className="inline-flex rounded-md bg-accent px-1.5 text-xs text-foreground">
            {words.level}
          </span>
          .
        </>
      )}
      {words.viewerNote === null ? null : <> {words.viewerNote}</>}
    </>
  );
}

function JoinSurface({
  token,
  description,
  onAuthenticated,
}: {
  readonly token: string;
  readonly description: LinkDescription;
  readonly onAuthenticated: () => void;
}) {
  // A join refused for want of a name asks for one, whatever the description said.
  const [askName, setAskName] = useState(false);
  const described = joinView(description);
  const view: typeof described = askName
    ? { kind: "name", prefill: "", placeholder: null }
    : described;
  const [name, setName] = useState(view.kind === "name" ? view.prefill : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dead, setDead] = useState(false);
  const title = `Join ${description.serverName}`;

  const join = async () => {
    const typed = name.trim();
    if (view.kind === "name" && !isPersonName(typed)) {
      setError(NAME_NOT_USABLE);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await post(
        J5_LINK_JOIN_PATH,
        view.kind === "name" ? { token, name: typed } : { token },
      );
      const body = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        const refusal = joinRefusal(response.status, body);
        if (refusal === "dead") {
          setDead(true);
          return;
        }
        if (refusal === "invalid_request" && view.kind !== "name") setAskName(true);
        setError(
          refusal === null
            ? "The server could not let you in. Try again."
            : refusalWords(refusal, description),
        );
        return;
      }
      const result = body as { readonly kind?: unknown; readonly credential?: unknown };
      if (result.kind === "joined") {
        // Already paired: the app starts afresh, and the first screen shows what was added.
        window.location.replace("/");
        return;
      }
      if (result.kind !== "pair" || typeof result.credential !== "string") {
        setError("The server could not let you in. Try again.");
        return;
      }
      stripPairingTokenFromUrl();
      // The link may have been revoked between the join and the pairing it allowed; the server
      // then refuses the pairing, and the link no longer works.
      const paired = await submitServerAuthCredential(result.credential).then(
        () => true,
        () => false,
      );
      if (!paired) {
        setDead(true);
        return;
      }
      onAuthenticated();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  if (dead) return <DeadLink />;
  if (view.kind === "someone-elses" || view.kind === "already-yours") {
    return (
      <StandalonePage tone="pairing">
        <StandalonePageHeader
          eyebrow={APP_DISPLAY_NAME}
          title={title}
          description={view.kind === "already-yours" ? ALREADY_YOURS : someoneElsesWords(view.name)}
        />
      </StandalonePage>
    );
  }

  return (
    <StandalonePage tone="pairing">
      <StandalonePageHeader
        eyebrow={APP_DISPLAY_NAME}
        title={title}
        description={
          view.kind === "as-yourself" ? (
            asYourselfWords(description, view.name)
          ) : (
            <InvitationLine description={description} />
          )
        }
      />
      <form
        className="mt-6 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void join();
        }}
      >
        {view.kind === "name" ? (
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
              placeholder={view.placeholder ?? undefined}
              onChange={(event) => {
                setName(event.currentTarget.value);
                setError(null);
              }}
              value={name}
            />
          </div>
        ) : null}
        {error === null ? null : (
          <Alert variant="error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Button
          disabled={busy || (view.kind === "name" && name.trim() === "")}
          size="sm"
          type="submit"
        >
          {busy ? "Joining…" : view.kind === "as-yourself" ? "Continue" : "Join"}
        </Button>
      </form>
    </StandalonePage>
  );
}
