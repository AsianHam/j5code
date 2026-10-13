import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import type { SupervisorConnectionState } from "../connection/model.ts";
import type { EnvironmentCatalogState } from "../state/connections.ts";
import { isJ5UnsupportedError } from "./http.ts";

/** Environment labels are noise until a read model actually spans more than one environment. */
export const spansMultipleEnvironments = (
  items: ReadonlyArray<{ readonly environmentId: EnvironmentId }>,
): boolean => new Set(items.map((item) => item.environmentId)).size > 1;

export interface J5ReadSource<A> {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly connected: boolean;
  readonly status: "loading" | "ready" | "offline" | "unsupported" | "error";
  readonly data: A | null;
  readonly error: string | null;
  readonly refreshing: boolean;
}

export interface J5ReadSources<A> {
  readonly isReady: boolean;
  readonly sources: ReadonlyArray<J5ReadSource<A>>;
}

export function resolveJ5ReadSource<A>(input: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly phase: SupervisorConnectionState["phase"];
  readonly supported?: boolean;
  readonly result: AsyncResult.AsyncResult<A, unknown>;
}): J5ReadSource<A> {
  const connected = input.phase === "connected";
  const data = Option.getOrNull(AsyncResult.value(input.result));
  const failure = input.result._tag === "Failure" ? Cause.squash(input.result.cause) : null;
  const unsupported = input.supported === false || isJ5UnsupportedError(failure);
  const status = unsupported
    ? "unsupported"
    : !connected
      ? input.phase === "connecting" || input.phase === "available"
        ? "loading"
        : "offline"
      : failure !== null
        ? "error"
        : data === null
          ? "loading"
          : "ready";
  return {
    environmentId: input.environmentId,
    environmentLabel: input.environmentLabel,
    connected,
    status,
    data: unsupported ? null : data,
    error:
      failure === null
        ? null
        : failure instanceof Error
          ? failure.message
          : "The environment request failed.",
    refreshing: connected && input.result.waiting,
  };
}

/** Merge read models through the existing catalog; each source keeps its own data and failure state. */
export function createJ5ReadSourcesAtom<A>(input: {
  readonly label: string;
  readonly capability: "j5ProjectLedger";
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly stateAtom: (
    id: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<SupervisorConnectionState, unknown>>;
  readonly configValueAtom: (id: EnvironmentId) => Atom.Atom<ServerConfig | null>;
  readonly queryAtom: (id: EnvironmentId) => Atom.Atom<AsyncResult.AsyncResult<A, unknown>>;
  /**
   * Whether the environment's connection is a guest's. A guest is shown nothing of a server's J5
   * read models (Shared server AC24), so its source reads as unsupported as soon as this is true,
   * whatever an earlier read answered, and is not asked again.
   */
  readonly guestAtom?: (id: EnvironmentId) => Atom.Atom<boolean>;
}): Atom.Atom<J5ReadSources<A>> {
  return Atom.make((get) => {
    const catalog = get(input.catalogValueAtom);
    const sources: Array<J5ReadSource<A>> = [];
    for (const [environmentId, entry] of catalog.entries) {
      const state = Option.getOrNull(AsyncResult.value(get(input.stateAtom(environmentId))));
      const supported =
        input.guestAtom !== undefined && get(input.guestAtom(environmentId))
          ? false
          : get(input.configValueAtom(environmentId))?.environment.capabilities[input.capability];
      sources.push(
        resolveJ5ReadSource({
          environmentId,
          environmentLabel: entry.target.label,
          phase: state?.phase ?? "available",
          ...(supported === undefined ? {} : { supported }),
          result:
            supported === false
              ? AsyncResult.initial<A, unknown>(false)
              : get(input.queryAtom(environmentId)),
        }),
      );
    }
    return { isReady: catalog.isReady, sources };
  }).pipe(Atom.withLabel(input.label));
}
