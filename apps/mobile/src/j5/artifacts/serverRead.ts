import { useEffect, useState } from "react";

export type Load<T> =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly value: T };

/** The last read that settled: which resource, at which pull-to-refresh count. */
export interface SettledRead<T> {
  readonly resource: string;
  readonly refresh: number;
  readonly load: Load<T>;
}

/**
 * A refresh of the same resource keeps showing its last body until the new one lands; any other
 * resource shows loading, so one artifact's body never sits under another's name.
 */
export function visibleRead<T>(
  settled: SettledRead<T> | null,
  resource: string | null,
  refresh: number,
): { readonly load: Load<T>; readonly refreshing: boolean } {
  if (resource === null || settled === null || settled.resource !== resource) {
    return { load: { status: "loading" }, refreshing: false };
  }
  if (settled.refresh === refresh) return { load: settled.load, refreshing: false };
  return {
    load: settled.load.status === "ready" ? settled.load : { status: "loading" },
    refreshing: true,
  };
}

/** One read from the server, again on each pull to refresh; a stale answer is dropped. */
export function useServerRead<T>(resource: string | null, read: () => Promise<T>) {
  const [refresh, setRefresh] = useState(0);
  const [settled, setSettled] = useState<SettledRead<T> | null>(null);
  // oxlint-disable-next-line t3code/react-effect-budget -- reads the artifact store on the server, which React can't derive.
  useEffect(() => {
    if (resource === null) return;
    let current = true;
    const settle = (load: Load<T>) => current && setSettled({ resource, refresh, load });
    read().then(
      (value) => settle({ status: "ready", value }),
      (error: unknown) =>
        settle({
          status: "error",
          message: error instanceof Error ? error.message : "Couldn't read artifacts.",
        }),
    );
    return () => {
      current = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `read` uses only the inputs `resource` names.
  }, [resource, refresh]);
  return {
    ...visibleRead(settled, resource, refresh),
    refresh: () => setRefresh((count) => count + 1),
  };
}
