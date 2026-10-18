import { reachesServer } from "@t3tools/client-runtime/j5/sharing";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect } from "react";

import { useEnvironmentThreadRefs } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { environmentShell } from "../../state/shell";
import { useConnectionAccess } from "./access";

/**
 * Takes someone who reaches less than the whole server off a thread's address when the last
 * thing they reach is taken away while they have it open. Upstream leaves a missing thread's
 * address only when the server has another thread to show, so they were left on an empty page;
 * their first screen says nothing is shared (People and access AC30).
 */
export function LeftOnNothingRedirect() {
  const params = useParams({ strict: false }) as {
    readonly environmentId?: string;
    readonly threadId?: string;
  };
  const environmentId =
    params.threadId === undefined ? null : ((params.environmentId ?? null) as EnvironmentId | null);
  const access = useConnectionAccess(environmentId);
  const narrow = access !== null && !reachesServer(access);
  // Asked only for such a connection: anyone at server scope is never moved, so nothing is read.
  const narrowEnvironmentId = narrow ? environmentId : null;
  const shell = useEnvironmentQuery(
    narrowEnvironmentId === null ? null : environmentShell.stateAtom(narrowEnvironmentId),
  );
  const threadCount = useEnvironmentThreadRefs(narrowEnvironmentId).length;
  const navigate = useNavigate();
  const leftOnNothing = narrow && shell.data?.snapshot._tag === "Some" && threadCount === 0;
  useEffect(() => {
    if (leftOnNothing) void navigate({ to: "/", replace: true });
  }, [leftOnNothing, navigate]);
  return null;
}
