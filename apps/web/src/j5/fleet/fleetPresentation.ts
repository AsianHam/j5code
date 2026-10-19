import type { FleetDerivedFacts, FleetProblemSummary } from "@t3tools/client-runtime/j5/fleetFacts";
import type { J5ReadSource } from "@t3tools/client-runtime/j5/readSources";
import type { FleetProblem, FleetRuntimeFact } from "@t3tools/contracts/j5";
import { formatChatTimestampTooltip } from "../../timestampFormat";
import type { CrewSeatState } from "../crew/crewState";

export const fleetAgentKey = (environmentId: string, participantId: string) =>
  `${environmentId.length}:${environmentId}${participantId}`;

export const fleetProblemNotices = (summary: FleetProblemSummary): ReadonlyArray<string> => [
  ...(summary.incompleteSources
    ? [
        "Problem coverage is incomplete: some environments are unavailable or do not report Fleet facts.",
      ]
    : []),
  ...(summary.unmeasuredAgents > 0
    ? [
        `${summary.unmeasuredAgents} ${summary.unmeasuredAgents === 1 ? "agent" : "agents"} unmeasured.`,
      ]
    : []),
  ...(summary.incompleteSources || summary.unmeasuredAgents > 0
    ? ["Counts include current measured problems only."]
    : []),
];

export const fleetBadgeLabel = (summary: FleetProblemSummary) =>
  `Open fleet, ${summary.agentsWithProblems} ${summary.agentsWithProblems === 1 ? "agent has" : "agents have"} measured problems. ${fleetProblemNotices(summary).join(" ")}`.trim();

export const fleetSourceIsLive = (
  source: Pick<J5ReadSource<unknown>, "connected" | "status">,
  shellStatus: string,
) => source.connected && source.status === "ready" && shellStatus === "live";

export const fleetTime = (at: string | null | undefined) =>
  at == null ? "?" : formatChatTimestampTooltip(at, "locale") || "?";

export const fleetMinutes = (since: string, now: number) =>
  Math.max(0, Math.floor((now - Date.parse(since)) / 60_000));

export const fleetStatusLabel = (runtime: FleetRuntimeFact) => {
  if (runtime.state === "unknown") return "?";
  if (runtime.settled) return "Settled";
  switch (runtime.status) {
    case "working":
      return "Working";
    case "waiting":
      return "Waiting";
    case "approval":
      return "Approval";
    case "input":
      return "Input";
    case "failed":
      return "Failed";
    case "waiting-to-start":
      return "Waiting to start";
    case "idle":
      return `Idle since ${fleetTime(runtime.since)}`;
  }
};

export const fleetSeatState = (
  facts: FleetDerivedFacts | undefined,
  live: boolean,
): CrewSeatState => {
  if (!live || facts?.runtime.state !== "known") return "unknown";
  const { runtime } = facts;
  if (runtime.status === "failed") return "failed";
  if (runtime.status === "approval" || runtime.status === "input") return "needs-you";
  if (runtime.settled) return "settled";
  if (runtime.status === "idle") return "idle";
  return "running";
};

export const fleetProblemLabel = (problem: FleetProblem) => {
  switch (problem.kind) {
    case "failed-run":
      return `Latest run failed · ${problem.at === null ? "time unavailable" : fleetTime(problem.at)}`;
    case "dispatch-overdue":
      return `Run not dispatched · requested ${fleetTime(problem.at)}`;
    case "delivery-failed":
      return `Delivery failed · to ${problem.receiverName ?? problem.receiverId} · ${fleetTime(problem.at)} · ${problem.reason ?? "reason unavailable"}`;
  }
};

export const fleetCrewSummary = (
  keys: ReadonlyArray<string>,
  facts: ReadonlyMap<string, FleetDerivedFacts>,
  live: ReadonlyMap<string, boolean>,
) => {
  const counts = new Map<string, number>();
  for (const key of keys) {
    const runtime = facts.get(key)?.runtime;
    const label =
      live.get(key) !== true || runtime?.state !== "known"
        ? "unknown"
        : runtime.settled
          ? "settled"
          : runtime.status === "waiting-to-start"
            ? "waiting to start"
            : runtime.status;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => `${count} ${label}`).join(" · ");
};
