import type { EnvironmentId, ServerSelfUpdateCapability } from "@t3tools/contracts";
import { PeerOrigin, type PeerProbeResponse } from "@t3tools/contracts/j5";
import * as Schema from "effect/Schema";

/**
 * The client's side of peering: it is the one party connected to both servers,
 * so it introduces them. Each server ends up holding the credential the other
 * issued and the origin it reaches the other at. Nothing here talks to a
 * server; the caller supplies the two verbs and this sequences them.
 */

/** One server in an introduction. `origin` is where the *other* server reaches this one. */
export interface PeeringSide {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly origin: string;
}

export type PeeringStep = "issue-local" | "issue-remote" | "record-remote" | "record-local";

export interface PeeringStepOutcome {
  readonly step: PeeringStep;
  readonly status: "done" | "failed" | "skipped";
  readonly detail: string | null;
}

export interface PeeringOutcome {
  readonly ok: boolean;
  readonly steps: ReadonlyArray<PeeringStepOutcome>;
}

const PEERING_STEPS: ReadonlyArray<PeeringStep> = [
  "issue-local",
  "issue-remote",
  "record-remote",
  "record-local",
];

export const peeringStepTitle = (step: PeeringStep, local: PeeringSide, remote: PeeringSide) => {
  switch (step) {
    case "issue-local":
      return `Issue a credential on ${local.label} for ${remote.label}`;
    case "issue-remote":
      return `Issue a credential on ${remote.label} for ${local.label}`;
    case "record-remote":
      return `Record ${remote.label} on ${local.label}`;
    case "record-local":
      return `Record ${local.label} on ${remote.label}`;
  }
};

const isPeerOrigin = Schema.is(PeerOrigin);

/** The origin the client uses is only a hint; a trailing slash is the one thing safe to fix. */
export const defaultPeerOrigin = (httpBaseUrl: string | null): string =>
  httpBaseUrl === null ? "" : httpBaseUrl.replace(/\/+$/, "");

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

/** Names the trap the definition warns about: an address that works for this client but not between servers. */
export const peerOriginWarning = (origin: string): string | null => {
  if (origin.trim().length === 0) return null;
  try {
    const url = new URL(origin);
    return LOOPBACK_HOSTS.has(url.hostname)
      ? "This is a loopback address. It works for this client, but the other server cannot reach it; use the address that server can reach."
      : null;
  } catch {
    return null;
  }
};

export type PeeringReadiness =
  | { readonly kind: "missing-environment"; readonly message: string }
  | { readonly kind: "environment-disconnected"; readonly message: string }
  | { readonly kind: "read-only-environment"; readonly message: string }
  | { readonly kind: "invalid-origin"; readonly message: string }
  | { readonly kind: "ready" };

export const resolvePeeringReadiness = (input: {
  readonly otherLabel: string | null;
  readonly otherConnected: boolean;
  readonly otherCanManage: boolean;
  readonly localOrigin: string;
  readonly remoteOrigin: string;
}): PeeringReadiness => {
  if (input.otherLabel === null) {
    return { kind: "missing-environment", message: "Choose the environment to peer with." };
  }
  if (!input.otherConnected) {
    return {
      kind: "environment-disconnected",
      message: `Connect to ${input.otherLabel} first; peering needs both servers reachable from this client.`,
    };
  }
  if (!input.otherCanManage) {
    return {
      kind: "read-only-environment",
      message: `This connection to ${input.otherLabel} cannot manage access (it lacks access:write), so it cannot issue a peer credential there.`,
    };
  }
  if (!isPeerOrigin(input.localOrigin) || !isPeerOrigin(input.remoteOrigin)) {
    return {
      kind: "invalid-origin",
      message:
        "Each origin must be an http(s) address with no path, such as https://home.example:3773.",
    };
  }
  return { kind: "ready" };
};

const detailOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause);

/**
 * Each server issues a credential for the other, then records the other after proving it at the
 * origin; stops at the first failure and reports every step. Issuing revokes nothing (older
 * sessions retire when the newer credential is first presented), so a failed re-peering leaves
 * the existing link working and at most an unused credential under Connections.
 */
export async function introducePeers(input: {
  readonly local: PeeringSide;
  readonly remote: PeeringSide;
  /** On `issuer`, mint the credential `holder` will present when it delivers to `issuer`. */
  readonly issue: (issuer: PeeringSide, holder: PeeringSide) => Promise<{ credential: string }>;
  /** On `recorder`, record `peer` at `peer.origin`, proving `credential` (the one `peer` issued to `recorder`). */
  readonly record: (
    recorder: PeeringSide,
    peer: PeeringSide,
    credential: string,
  ) => Promise<unknown>;
}): Promise<PeeringOutcome> {
  const steps: Array<PeeringStepOutcome> = [];
  const run = async <A>(step: PeeringStep, action: () => Promise<A>): Promise<A> => {
    try {
      const result = await action();
      steps.push({ step, status: "done", detail: null });
      return result;
    } catch (cause) {
      steps.push({ step, status: "failed", detail: detailOf(cause) });
      throw cause;
    }
  };
  try {
    const forRemote = await run("issue-local", () => input.issue(input.local, input.remote));
    const forLocal = await run("issue-remote", () => input.issue(input.remote, input.local));
    await run("record-remote", () => input.record(input.local, input.remote, forLocal.credential));
    await run("record-local", () => input.record(input.remote, input.local, forRemote.credential));
    return { ok: true, steps };
  } catch {
    for (const step of PEERING_STEPS) {
      if (!steps.some((outcome) => outcome.step === step)) {
        steps.push({ step, status: "skipped", detail: null });
      }
    }
    return { ok: false, steps };
  }
}

/*
 * Poll mode's check before peering: each server fetches the other's public identity at each
 * address it might be reached at, and a test counts only when the expected server answers. With
 * how each server is run, that recommends how messages travel each way; the client asks only
 * what the check could not settle.
 */

/** How a server is run, from its descriptor's self-update capability. */
export type PeeringRunMode = "service" | "desktop" | "by-hand";

export const peeringRunMode = (
  serverSelfUpdate: ServerSelfUpdateCapability | null | undefined,
): PeeringRunMode =>
  serverSelfUpdate === "boot-service"
    ? "service"
    : serverSelfUpdate === "desktop-managed"
      ? "desktop"
      : "by-hand";

/** One server's facts for the check, from the descriptor the client already holds. */
export interface PeeringServer {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly serverVersion: string;
  /** It publishes `j5PeerPoll`: poll mode and the reachability routes. */
  readonly supportsPoll: boolean;
  readonly runMode: PeeringRunMode;
}

/** What one server's attempt to reach the other found. */
export type PeeringReach =
  | { readonly kind: "reached"; readonly origin: string }
  | { readonly kind: "failed"; readonly errors: ReadonlyArray<string> }
  /**
   * Nothing could be tried: the other server's address list failed, with its
   * error, or held only loopback addresses, and error is null.
   */
  | { readonly kind: "untested"; readonly error: string | null };

/** The origins to try for a server: the one this client uses first, then what the server offers. */
export const peeringCandidates = (input: {
  readonly addresses: ReadonlyArray<string>;
  readonly clientUrl: string | null;
}): ReadonlyArray<string> => {
  const candidates = [
    ...(input.clientUrl === null ? [] : [defaultPeerOrigin(input.clientUrl)]),
    ...input.addresses,
  ].filter((origin) => isPeerOrigin(origin) && peerOriginWarning(origin) === null);
  return [...new Set(candidates)];
};

/** Who answered each probe decides the reach: a different server answering is a miss, and says who did. */
export const peeringReachFrom = (input: {
  readonly expected: Pick<PeeringServer, "environmentId" | "label">;
  readonly candidates: ReadonlyArray<string>;
  readonly probes: ReadonlyArray<PeerProbeResponse>;
  /** Why the expected server's own address list could not be read, if it could not. */
  readonly addressesError?: string | null;
}): PeeringReach => {
  const addressesError = input.addressesError ?? null;
  if (input.candidates.length === 0) return { kind: "untested", error: addressesError };
  const reached = input.candidates.find((origin) =>
    input.probes.some(
      (probe) =>
        probe.origin === origin &&
        probe.outcome === "reached" &&
        probe.environmentId === input.expected.environmentId,
    ),
  );
  if (reached !== undefined) return { kind: "reached", origin: reached };
  return {
    kind: "failed",
    errors: [
      ...(addressesError === null
        ? []
        : [`${input.expected.label} could not list its addresses: ${addressesError}`]),
      ...input.probes.map((probe) =>
        probe.outcome === "failed"
          ? probe.error
          : `${hostOf(probe.origin)}: ${probe.label} answered, not ${input.expected.label}`,
      ),
    ],
  };
};

const hostOf = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/**
 * Which way connections can go. `local-only`: only this server connects, so it polls the remote,
 * which stores its messages; `remote-only` is the reverse. `localOrigin` is where the remote
 * reaches this server; `remoteOrigin` where this server reaches the remote.
 */
export interface PeeringChoice {
  readonly connections: "both" | "local-only" | "remote-only";
  readonly localOrigin: string;
  readonly remoteOrigin: string;
}

/** The one thing the check could not settle: how messages get to a server that may be off, or untested. */
export interface PeeringQuestion {
  readonly toward: "local" | "remote";
  readonly reason: "desktop" | "by-hand" | "untested";
  /** Storing until that server polls: the default, because it works on any network. */
  readonly storeChoice: PeeringChoice;
  readonly directChoice: PeeringChoice;
  /** Sending directly needs an address the check could not prove. */
  readonly directNeedsAddress: boolean;
}

export type PeeringRecommendation =
  | { readonly kind: "too-old"; readonly server: PeeringServer }
  | { readonly kind: "no-route" }
  | {
      readonly kind: "setup";
      readonly choice: PeeringChoice;
      readonly question: PeeringQuestion | null;
    };

/** The recommended setup: it asks only what the check could not settle. */
export const recommendPeering = (input: {
  readonly local: PeeringServer;
  readonly remote: PeeringServer;
  readonly localToRemote: PeeringReach;
  readonly remoteToLocal: PeeringReach;
}): PeeringRecommendation => {
  if (!input.remote.supportsPoll) return { kind: "too-old", server: input.remote };
  if (!input.local.supportsPoll) return { kind: "too-old", server: input.local };
  const remoteOrigin = input.localToRemote.kind === "reached" ? input.localToRemote.origin : "";
  const localOrigin = input.remoteToLocal.kind === "reached" ? input.remoteToLocal.origin : "";
  const choice = (connections: PeeringChoice["connections"]): PeeringChoice => ({
    connections,
    localOrigin,
    remoteOrigin,
  });
  // Messages to a side are stored for it when that side is the one that polls.
  const storeToward = (toward: "local" | "remote") =>
    choice(toward === "local" ? "local-only" : "remote-only");
  const localReaches = input.localToRemote.kind === "reached";
  const remoteReaches = input.remoteToLocal.kind === "reached";

  if (localReaches && remoteReaches) {
    // Both can connect; a server that may be off is asked about, desktop first.
    // filter returns a new array, so sorting it in place touches nothing else.
    const asked = (["remote", "local"] as const)
      .map((side) => ({ side, runMode: input[side].runMode }))
      .filter((entry) => entry.runMode !== "service")
      .sort(
        (left, right) => Number(right.runMode === "desktop") - Number(left.runMode === "desktop"),
      )[0];
    if (asked === undefined) return { kind: "setup", choice: choice("both"), question: null };
    return {
      kind: "setup",
      choice: storeToward(asked.side),
      question: {
        toward: asked.side,
        reason: asked.runMode === "desktop" ? "desktop" : "by-hand",
        storeChoice: storeToward(asked.side),
        directChoice: choice("both"),
        directNeedsAddress: false,
      },
    };
  }
  // One side can connect: messages to it are stored until it polls. An untested
  // direction is asked about, with polling the default.
  for (const [poller, reaches, otherReach] of [
    ["local", localReaches, input.remoteToLocal],
    ["remote", remoteReaches, input.localToRemote],
  ] as const) {
    if (!reaches) continue;
    if (otherReach.kind === "failed") {
      return { kind: "setup", choice: storeToward(poller), question: null };
    }
    return {
      kind: "setup",
      choice: storeToward(poller),
      question: {
        toward: poller,
        reason: "untested",
        storeChoice: storeToward(poller),
        directChoice: choice("both"),
        directNeedsAddress: true,
      },
    };
  }
  return { kind: "no-route" };
};

/**
 * What the two servers record about a pair before it is peered. A record here is a peering this
 * server still holds, removed under Peer servers first; one held only by the other server is a
 * leftover, cleared there before pairing. A list that failed to read says nothing about its server.
 */
export const peeringRecords = (input: {
  readonly thisServer: string;
  readonly otherServer: string;
  /** This server's peers, and the other server's. */
  readonly here: ReadonlyArray<{ readonly environmentId: string }>;
  readonly there: ReadonlyArray<{ readonly environmentId: string }>;
}) => {
  const heldHere = input.here.some((peer) => peer.environmentId === input.otherServer);
  const leftover = !heldHere && input.there.some((peer) => peer.environmentId === input.thisServer);
  return { heldHere, leftover };
};

/**
 * How removing a peer is confirmed. `both`: this client removes both sides.
 * `ended`: the other server already removed its side, so this is the whole
 * break. `here-only`: the other server keeps its side, a choice the person is
 * warned about.
 */
export const removalConfirmation = (input: {
  /** This client can manage the other server now. */
  readonly otherManageable: boolean;
  /** The other server rejects the credential it issued: it ended the peering. */
  readonly ended: boolean;
}): "both" | "ended" | "here-only" =>
  input.otherManageable ? "both" : input.ended ? "ended" : "here-only";

/** How messages will travel, in the plain lines the dialog shows; they update as the choice changes. */
export const peeringLines = (
  choice: PeeringChoice,
  local: Pick<PeeringServer, "label">,
  remote: Pick<PeeringServer, "label">,
): ReadonlyArray<string> => {
  const direct = (from: string, to: string, origin: string) =>
    `${from} sends A2A messages to ${to} directly${origin.length > 0 ? `, at ${origin}` : ""}.`;
  const stored = (storer: string, poller: string) =>
    `${storer} stores A2A messages for ${poller} and waits for ${poller} to poll for them.`;
  switch (choice.connections) {
    case "both":
      return [
        direct(local.label, remote.label, choice.remoteOrigin),
        direct(remote.label, local.label, choice.localOrigin),
      ];
    case "local-only":
      return [direct(local.label, remote.label, ""), stored(remote.label, local.label)];
    case "remote-only":
      return [direct(remote.label, local.label, ""), stored(local.label, remote.label)];
  }
};

/** Every origin the choice needs is a valid peer origin, so the introduction can run. */
export const peeringChoiceReady = (choice: PeeringChoice): boolean =>
  (choice.connections === "remote-only" || isPeerOrigin(choice.remoteOrigin)) &&
  (choice.connections === "local-only" || isPeerOrigin(choice.localOrigin));

export type PollPeeringStep = "issue-store" | "record-poll";

export interface PollPeeringStepOutcome {
  readonly step: PollPeeringStep;
  readonly status: "done" | "failed" | "skipped";
  readonly detail: string | null;
}

export const pollPeeringStepTitle = (
  step: PollPeeringStep,
  poller: Pick<PeeringSide, "label">,
  storer: Pick<PeeringSide, "label">,
) =>
  step === "issue-store"
    ? `Issue a credential on ${storer.label} for ${poller.label} to poll with`
    : `Record ${storer.label} on ${poller.label} to poll`;

/**
 * Poll mode, in two steps: the server that can be reached issues a credential
 * marked for a poller, and the poller records it at the origin it reaches it at
 * and polls. The storing server records the poller when the poller first
 * presents the credential, so nothing is recorded there before it is proven.
 */
export async function introducePollingPeer(input: {
  readonly poller: PeeringSide;
  readonly storer: PeeringSide;
  /** On `storer`, mint the credential `poller` will poll with. */
  readonly issue: (storer: PeeringSide, poller: PeeringSide) => Promise<{ credential: string }>;
  /** On `poller`, record `storer` at `storer.origin` to poll, proving `credential` there. */
  readonly record: (
    poller: PeeringSide,
    storer: PeeringSide,
    credential: string,
  ) => Promise<unknown>;
}): Promise<{ readonly ok: boolean; readonly steps: ReadonlyArray<PollPeeringStepOutcome> }> {
  const steps: Array<PollPeeringStepOutcome> = [];
  try {
    const issued = await input.issue(input.storer, input.poller).catch((cause: unknown) => {
      steps.push({ step: "issue-store", status: "failed", detail: detailOf(cause) });
      throw cause;
    });
    steps.push({ step: "issue-store", status: "done", detail: null });
    await input.record(input.poller, input.storer, issued.credential).catch((cause: unknown) => {
      steps.push({ step: "record-poll", status: "failed", detail: detailOf(cause) });
      throw cause;
    });
    steps.push({ step: "record-poll", status: "done", detail: null });
    return { ok: true, steps };
  } catch {
    if (!steps.some((outcome) => outcome.step === "record-poll")) {
      steps.push({ step: "record-poll", status: "skipped", detail: null });
    }
    return { ok: false, steps };
  }
}
