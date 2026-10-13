import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  J5_SHARING_WS_METHODS,
  type SharingConnectionAccess,
  type SharingConnectionKind,
  type SharingThreadLevel,
} from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { request } from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "../state/runtime.ts";

/**
 * What a shared server lets this connection do with a thread
 * (docs/j5/product/features/shared-server.md, AC12 and AC13). A member's connection is held to
 * nothing here. A guest's may write to a thread only where its level is Collaborate, so one
 * guest can read one thread and write to another on the same server. While the server has not
 * yet said which kind the connection is (`null`), nothing is withheld.
 */
export const sharingAllowsOperate = (input: {
  readonly connection: SharingConnectionKind | null;
  readonly level: SharingThreadLevel | null;
}): boolean => input.connection !== "guest" || input.level === "collaborate";

// One answer per connection: a session's kind is fixed when it is paired and never changes.
interface ConnectionKindAnswer {
  /** `null` until the server has answered. */
  kind: SharingConnectionKind | null;
  readonly ask: Effect.Effect<SharingConnectionAccess>;
}
const connectionKinds = new WeakMap<RpcSession, ConnectionKindAnswer>();

const connectionKindAnswer = Effect.gen(function* () {
  const supervisor = yield* EnvironmentSupervisor;
  const session = yield* SubscriptionRef.get(supervisor.session);
  if (Option.isNone(session)) return null;
  const known = connectionKinds.get(session.value);
  if (known !== undefined) return known;
  const answer: ConnectionKindAnswer = {
    kind: null,
    ask: yield* Effect.cached(
      request(J5_SHARING_WS_METHODS.getConnectionAccess, {}).pipe(
        // A server that cannot answer, such as one from before sharing, has no guests. It says
        // nothing of an owner's name either, so no one is asked for one.
        Effect.catchCause(() => Effect.succeed<SharingConnectionAccess>({ kind: "member" })),
        Effect.tap((access) =>
          Effect.sync(() => {
            answer.kind = access.kind;
          }),
        ),
        Effect.provideService(EnvironmentSupervisor, supervisor),
      ),
    ),
  };
  connectionKinds.set(session.value, answer);
  return answer;
});

/** What the server says of the environment's connection, asked once per connection. */
export const sharingConnectionAccess = Effect.gen(function* () {
  const answer = yield* connectionKindAnswer;
  return answer === null ? ({ kind: "member" } as SharingConnectionAccess) : yield* answer.ask;
});

/** Whether the environment's connection is a member's or a guest's, from the same one answer. */
export const sharingConnectionKind = Effect.map(sharingConnectionAccess, (access) => access.kind);

/**
 * Whether the connection is already known to be a guest's. It never waits for the server: a
 * member's requests are not held behind the question, which is asked in the background the first
 * time. Until the answer arrives a guest's connection reads as not known, so its first requests
 * go out and are refused by the server.
 */
export const sharingConnectionIsKnownGuest = Effect.gen(function* () {
  const answer = yield* connectionKindAnswer;
  if (answer === null) return false;
  if (answer.kind === null) yield* Effect.forkDetach(answer.ask);
  return answer.kind === "guest";
});

const threadKey = (environmentId: EnvironmentId, threadId: ThreadId | null) =>
  JSON.stringify([environmentId, threadId]);

/** Environment-scoped atoms for what a shared server grants this connection; web and mobile each build one. */
export function createSharingEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const connectionAccess = createEnvironmentQueryAtomFamily(runtime, {
    label: "j5:sharing:connection",
    staleTimeMs: Number.MAX_SAFE_INTEGER,
    execute: (_input: Record<string, never>) => sharingConnectionAccess,
  });
  // Only a guest's client opens this; the server sends the level again when a grant changes it.
  const threadAccess = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "j5:sharing:thread",
    tag: J5_SHARING_WS_METHODS.subscribeThreadAccess,
  });

  /** `null` until the server has answered for this connection. */
  const connectionKind = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): SharingConnectionKind | null =>
        Option.getOrNull(AsyncResult.value(get(connectionAccess({ environmentId, input: {} }))))
          ?.kind ?? null,
    ).pipe(Atom.withLabel(`j5:sharing:connection-kind:${environmentId}`)),
  );

  /**
   * The name of the person the server belongs to, as a member's connection was told it when it
   * connected: a name, `null` when none is set, and `undefined` while the server has not
   * answered, for a guest's connection, and for a server that does not say.
   */
  const ownerName = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): string | null | undefined => {
      const access = Option.getOrNull(
        AsyncResult.value(get(connectionAccess({ environmentId, input: {} }))),
      );
      return access?.kind === "member" ? access.ownerName : undefined;
    }).pipe(Atom.withLabel(`j5:sharing:owner-name:${environmentId}`)),
  );

  const threadOperable = Atom.family((key: string) => {
    const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, ThreadId | null];
    return Atom.make((get) => {
      const connection = get(connectionKind(environmentId));
      if (connection !== "guest") return sharingAllowsOperate({ connection, level: null });
      // A view with no thread on the server, such as a draft, is nothing a guest was granted.
      const level =
        threadId === null
          ? "none"
          : (Option.getOrNull(
              AsyncResult.value(get(threadAccess({ environmentId, input: { threadId } }))),
            )?.level ?? null);
      return sharingAllowsOperate({ connection, level });
    }).pipe(Atom.withLabel(`j5:sharing:thread-operable:${key}`));
  });

  /** Whether the connection is known to be a guest's; false until the server has said so. */
  const isGuest = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(connectionKind(environmentId)) === "guest").pipe(
      Atom.withLabel(`j5:sharing:is-guest:${environmentId}`),
    ),
  );

  return {
    connectionKind,
    ownerName,
    isGuest,
    /**
     * The same answer for code that is not rendering, such as a menu built when it is opened.
     * `permitted` is upstream's own server-wide answer, returned as it is for a connection that is
     * not a guest's. It reads what the thread's view already holds, and asks nothing.
     */
    readCanOperateThread: (
      registry: AtomRegistry.AtomRegistry,
      input: {
        readonly environmentId: EnvironmentId;
        readonly threadId: ThreadId | null;
        readonly permitted: boolean;
      },
    ): boolean =>
      input.permitted &&
      registry.get(threadOperable(threadKey(input.environmentId, input.threadId))),
    /** Whether sharing lets this connection write to the thread; upstream's permission is separate. */
    threadOperable: (environmentId: EnvironmentId, threadId: ThreadId | null) =>
      threadOperable(threadKey(environmentId, threadId)),
  };
}
