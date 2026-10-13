import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import { J5ActionError, J5_LEDGER_CAPABILITIES } from "@t3tools/contracts/j5";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  createJ5ReadSourcesAtom,
  resolveJ5ReadSource,
  spansMultipleEnvironments,
} from "./readSources.ts";

const source = {
  environmentId: EnvironmentId.make("remote"),
  environmentLabel: "Remote",
  phase: "connected" as const,
};

it("reports an independently loaded source as ready with its data", () => {
  const result = resolveJ5ReadSource({ ...source, result: AsyncResult.success(["remote-row"]) });
  expect(result).toMatchObject({ data: ["remote-row"], status: "ready", connected: true });
});

it("retains data but reports an outage or refresh failure instead of an empty successful source", () => {
  const success = AsyncResult.success(["cached-row"]);
  const offline = resolveJ5ReadSource({ ...source, phase: "offline", result: success });
  expect(offline).toMatchObject({ status: "offline", data: ["cached-row"], connected: false });
  const failed = resolveJ5ReadSource({
    ...source,
    result: AsyncResult.failure(
      Cause.fail(new J5ActionError({ code: "SqlError", message: "Unavailable" })),
      { previousSuccess: Option.some(success) },
    ),
  });
  expect(failed).toMatchObject({ status: "error", data: ["cached-row"], error: "Unavailable" });
});

it("keeps unsupported, authentication failure, and not-yet-connected states distinct", () => {
  expect(
    resolveJ5ReadSource({ ...source, supported: false, result: AsyncResult.initial(false) }).status,
  ).toBe("unsupported");
  expect(
    resolveJ5ReadSource({
      ...source,
      result: AsyncResult.failure(
        Cause.fail(new J5ActionError({ code: "A2ALocalOperatorNotFoundError", message: "Gone" })),
      ),
    }).status,
  ).toBe("error");
  expect(
    resolveJ5ReadSource({ ...source, phase: "connecting", result: AsyncResult.initial(false) })
      .status,
  ).toBe("loading");
});

it("shows environment labels only once items span more than one environment", () => {
  const alpha = { environmentId: EnvironmentId.make("alpha") };
  const bravo = { environmentId: EnvironmentId.make("bravo") };
  expect(spansMultipleEnvironments([])).toBe(false);
  expect(spansMultipleEnvironments([alpha, alpha])).toBe(false);
  expect(spansMultipleEnvironments([alpha, bravo])).toBe(true);
});

/** Reads one environment's source for a capability key, counting the reads it makes. */
const readSourceFor = (
  capabilities: Partial<Record<keyof typeof J5_LEDGER_CAPABILITIES, boolean>>,
  capability: keyof typeof J5_LEDGER_CAPABILITIES,
) => {
  const environmentId = source.environmentId;
  let routeCalls = 0;
  type Input = Parameters<typeof createJ5ReadSourcesAtom<ReadonlyArray<string>>>[0];
  const sources = createJ5ReadSourcesAtom<ReadonlyArray<string>>({
    label: "test:j5-read-sources",
    // The two older keys are the ones the client from before the re-key passed here.
    capability: capability as Input["capability"],
    catalogValueAtom: Atom.make({
      isReady: true,
      entries: new Map([[environmentId, { target: { label: "Remote" } }]]),
    }) as unknown as Input["catalogValueAtom"],
    stateAtom: () =>
      Atom.make(AsyncResult.success({ phase: "connected" })) as unknown as ReturnType<
        Input["stateAtom"]
      >,
    configValueAtom: () =>
      Atom.make({ environment: { capabilities } }) as unknown as ReturnType<
        Input["configValueAtom"]
      >,
    queryAtom: () =>
      Atom.make(() => {
        routeCalls += 1;
        return AsyncResult.success<ReadonlyArray<string>, unknown>(["row"]);
      }),
  });
  const [result] = AtomRegistry.make().get(sources).sources;
  return { status: result?.status, data: result?.data, routeCalls };
};

it("shows an older client's J5 views as unsupported against a project-keyed server, calling no route", () => {
  // Fleet read `j5Squadrons`; the Inbox, its count, Crew proposals and Crew runtime requests read
  // `j5HumanInbox`. Their routes changed shape, so that client must not reach them.
  for (const olderKey of ["j5Squadrons", "j5HumanInbox"] as const) {
    expect(readSourceFor(J5_LEDGER_CAPABILITIES, olderKey)).toEqual({
      status: "unsupported",
      data: null,
      routeCalls: 0,
    });
  }
  expect(readSourceFor(J5_LEDGER_CAPABILITIES, "j5ProjectLedger")).toEqual({
    status: "ready",
    data: ["row"],
    routeCalls: 1,
  });
});

it("shows a server with no J5 ledger as unsupported without reading it", () => {
  expect(readSourceFor({}, "j5ProjectLedger")).toEqual({
    status: "unsupported",
    data: null,
    routeCalls: 0,
  });
});

it("shows nothing from a server once its connection is known to be a guest's", () => {
  type Input = Parameters<typeof createJ5ReadSourcesAtom<ReadonlyArray<string>>>[0];
  const guest = Atom.make(false);
  let routeCalls = 0;
  const sources = createJ5ReadSourcesAtom<ReadonlyArray<string>>({
    label: "test:j5-read-sources-guest",
    capability: "j5ProjectLedger",
    catalogValueAtom: Atom.make({
      isReady: true,
      entries: new Map([[source.environmentId, { target: { label: "Remote" } }]]),
    }) as unknown as Input["catalogValueAtom"],
    stateAtom: () =>
      Atom.make(AsyncResult.success({ phase: "connected" })) as unknown as ReturnType<
        Input["stateAtom"]
      >,
    configValueAtom: () =>
      Atom.make({
        environment: { capabilities: { j5ProjectLedger: true } },
      }) as unknown as ReturnType<Input["configValueAtom"]>,
    // The read a guest's client sent before it knew: the server refused it.
    queryAtom: () =>
      Atom.make(() => {
        routeCalls += 1;
        return AsyncResult.failure<ReadonlyArray<string>, unknown>(
          Cause.fail(new J5ActionError({ code: "forbidden", message: "Not shared" })),
        );
      }),
    guestAtom: () => guest,
  });
  const registry = AtomRegistry.make();
  // Until the server says which kind the connection is, the read goes out as a member's would.
  expect(registry.get(sources).sources[0]).toMatchObject({ status: "error", error: "Not shared" });
  expect(routeCalls).toBe(1);
  registry.set(guest, true);
  // The refusal leaves no error behind, and a source that is unsupported is never asked again.
  expect(registry.get(sources).sources[0]).toMatchObject({
    status: "unsupported",
    data: null,
    error: null,
  });
  expect(routeCalls).toBe(1);
});
