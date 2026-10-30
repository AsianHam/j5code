import type { J5ReadSources } from "@t3tools/client-runtime/j5/readSources";
import { EnvironmentId } from "@t3tools/contracts";
import type { FleetAgent, FleetResponse } from "@t3tools/contracts/j5";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const input = vi.hoisted(() => ({
  sources: undefined as unknown as Atom.Writable<J5ReadSources<FleetResponse>>,
  shell: undefined as unknown as (id: string) => Atom.Writable<{
    status: string;
    error: Option.Option<unknown>;
  }>,
}));
vi.mock("../state", async () => {
  const { Atom } = await import("effect/reactivity");
  input.sources = Atom.make<J5ReadSources<FleetResponse>>({ isReady: true, sources: [] });
  return { fleetSourcesAtom: input.sources };
});
vi.mock("../../state/shell", async () => {
  const { Atom } = await import("effect/reactivity");
  const Option = await import("effect/Option");
  input.shell = Atom.family((_id: string) =>
    Atom.make({ status: "live", error: Option.none<unknown>() }),
  );
  return { environmentShell: { stateValueAtom: input.shell } };
});
vi.mock("../../state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentThreadShells: { threadShellsAtom: Atom.make([]) } };
});

import { fleetAgentKey } from "./fleetPresentation";
import { fleetFactsAtom, fleetProblemSummaryAtom } from "./fleetState";

const at = "2026-10-26T10:00:00.000Z";
const origin = EnvironmentId.make("origin");
const receiver = EnvironmentId.make("receiver");
const key = fleetAgentKey(origin, "sender");
const ask = {
  exchangeId: "exchange",
  counterpartyId: "receiver-agent",
  counterpartyName: "Receiver",
  intent: "Review",
  openedAt: at,
};
const agent = (open = true): FleetAgent => ({
  participantId: "sender",
  threadId: null,
  displayName: "Sender",
  origin: "human",
  placementParentId: null,
  crew: null,
  openAsks: 0,
  facts: {
    asks: { owed: [], awaited: open ? [ask] : [] },
    problems: [],
    deliveryEnvironmentIds: [receiver],
  },
});
const sources = (
  options: {
    connected?: boolean;
    open?: boolean;
    mirrorOpen?: boolean;
    includeOrigin?: boolean;
    oldReceiver?: boolean;
  } = {},
): J5ReadSources<FleetResponse> => ({
  isReady: true,
  sources: [
    ...(options.includeOrigin === false
      ? []
      : [
          {
            environmentId: origin,
            environmentLabel: "Origin",
            connected: true,
            status: "ready" as const,
            error: null,
            refreshing: false,
            data: {
              asOf: at,
              remoteDeliveryAlarms: [],
              projects: [
                { id: "project", title: "Project", agents: [agent(options.open)], crews: [] },
              ],
            },
          },
        ]),
    {
      environmentId: receiver,
      environmentLabel: "Receiver",
      connected: options.connected ?? true,
      status: options.connected === false ? "offline" : "ready",
      error: null,
      refreshing: false,
      data: {
        asOf: at,
        projects: [],
        ...(options.oldReceiver === true
          ? {}
          : {
              remoteDeliveryAlarms: [
                {
                  originEnvironmentId: origin,
                  senderId: "sender",
                  problem: {
                    kind: "delivery-failed" as const,
                    messageId: "message",
                    receiverId: "receiver-agent",
                    receiverName: "Receiver",
                    at,
                    reason: "Thread delivery failed",
                    exchangeId: "exchange",
                    exchangeOpen: options.mirrorOpen ?? true,
                  },
                },
              ],
            }),
      },
    },
  ],
});

let registry: AtomRegistry.AtomRegistry;
let stop: () => void;
beforeEach(() => {
  registry = AtomRegistry.make();
  registry.set(input.sources, sources());
  stop = registry.mount(fleetFactsAtom);
});
afterEach(() => {
  stop();
  registry.dispose();
});

it("attaches a receiver's alarm to the origin row and honors either Exchange closure", () => {
  expect(registry.get(fleetFactsAtom).get(key)?.problems).toMatchObject([
    { kind: "delivery-failed", exchangeOpen: true },
  ]);
  expect(registry.get(fleetFactsAtom).get(key)?.problemsIncomplete).toBe(false);
  for (const closed of [{ open: false }, { mirrorOpen: false }]) {
    registry.set(input.sources, sources(closed));
    expect(registry.get(fleetFactsAtom).get(key)?.problems).toMatchObject([
      { kind: "delivery-failed", exchangeOpen: false },
    ]);
  }
});

it("drops cached receiver alarms on disconnect or a stale shell and recovers on reconnect", () => {
  registry.set(input.sources, sources({ connected: false }));
  expect(registry.get(fleetFactsAtom).get(key)?.problems).toEqual([]);
  expect(registry.get(fleetFactsAtom).get(key)?.problemsIncomplete).toBe(true);
  registry.set(input.sources, sources());
  expect(registry.get(fleetFactsAtom).get(key)?.problems).toHaveLength(1);
  registry.set(input.shell(receiver), { status: "cached", error: Option.none() });
  expect(registry.get(fleetFactsAtom).get(key)?.problems).toEqual([]);
  expect(registry.get(fleetFactsAtom).get(key)?.problemsIncomplete).toBe(true);
  registry.set(input.shell(receiver), { status: "live", error: Option.none() });
  expect(registry.get(fleetFactsAtom).get(key)?.problems).toHaveLength(1);
  expect(registry.get(fleetFactsAtom).get(key)?.problemsIncomplete).toBe(false);
});

it("qualifies old receiver reads and creates no phantom sender row", () => {
  registry.set(input.sources, sources({ oldReceiver: true }));
  expect(registry.get(fleetFactsAtom).get(key)?.problems).toEqual([]);
  expect(registry.get(fleetFactsAtom).get(key)?.problemsIncomplete).toBe(true);
  registry.set(input.sources, sources({ includeOrigin: false }));
  expect(registry.get(fleetFactsAtom).size).toBe(0);
});

it("updates badge eligibility and coverage through closure, disconnection, old reads and recovery", () => {
  const stopBadge = registry.mount(fleetProblemSummaryAtom);
  try {
    const badge = () => registry.get(fleetProblemSummaryAtom);
    expect(badge()).toMatchObject({ agentsWithProblems: 1, incompleteSources: false });
    registry.set(input.sources, sources({ open: false }));
    expect(badge()).toMatchObject({ agentsWithProblems: 0, incompleteSources: false });
    registry.set(input.sources, sources({ mirrorOpen: false }));
    expect(badge()).toMatchObject({ agentsWithProblems: 0, incompleteSources: false });
    registry.set(input.sources, sources({ connected: false }));
    expect(badge()).toMatchObject({ agentsWithProblems: 0, incompleteSources: true });
    registry.set(input.sources, sources({ oldReceiver: true }));
    expect(badge()).toMatchObject({ agentsWithProblems: 0, incompleteSources: true });
    registry.set(input.sources, sources());
    expect(badge()).toMatchObject({ agentsWithProblems: 1, incompleteSources: false });
    registry.set(input.sources, sources({ includeOrigin: false }));
    expect(badge().agentsWithProblems).toBe(0);
  } finally {
    stopBadge();
  }
});
