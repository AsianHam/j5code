import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../../config.ts";
import * as ModelManifest from "../../provider/ModelManifest.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import { makeProviderRegistryMock } from "../../provider/testUtils/providerRegistryMock.ts";
import { refreshSkillProviders } from "./skillProviderRefresh.ts";

it.effect("refreshes only selected instances including pending workspace discovery", () =>
  Effect.gen(function* () {
    const snapshot = (id: string): ServerProvider => ({
      instanceId: ProviderInstanceId.make(id),
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-09-24T00:00:00Z",
      version: null,
      models: [],
      skills: [],
      slashCommands: [],
    });
    const selected = {
      ...snapshot("selected"),
      workspaceSnapshots: [
        { cwd: "/cached", checkedAt: "2026-09-24T00:00:00Z", skills: [], slashCommands: [] },
      ],
    };
    const calls: string[] = [];
    const registry = {
      ...makeProviderRegistryMock([selected, snapshot("unrelated")]),
      getPendingWorkspaceCwds: () => Effect.succeed(["/pending"]),
      refreshInstance: (id: ProviderInstanceId) =>
        Effect.sync(() => {
          calls.push(id);
          return [];
        }),
      refreshWorkspaceSnapshot: (input: {
        instanceId: ProviderInstanceId;
        cwd: string;
        force?: boolean;
      }) =>
        Effect.sync(() => {
          assert.isTrue(input.force);
          calls.push(`${input.instanceId}:${input.cwd}`);
          return [];
        }),
    };
    yield* refreshSkillProviders(registry, [selected.instanceId], ["/pending", "/selected"]);
    assert.deepStrictEqual(calls, [
      "selected",
      "selected:/pending",
      "selected:/cached",
      "selected:/selected",
    ]);
  }),
);

it.effect("records a failed discovery without hiding it from a post-update refresh", () =>
  Effect.gen(function* () {
    const driver = ProviderDriverKind.make("codex");
    const instanceId = ProviderInstanceId.make("codex");
    const provider = {
      instanceId,
      driver,
      status: "ready",
      enabled: true,
      installed: true,
      auth: { status: "authenticated" },
      checkedAt: "2026-10-24T00:00:00.000Z",
      version: "1.0.0",
      models: [],
      slashCommands: [],
      skills: [],
    } as const satisfies ServerProvider;
    const failRefresh = yield* Ref.make(false);
    const refresh = Ref.get(failRefresh).pipe(
      Effect.flatMap((fail) =>
        fail ? Effect.die(new Error("CLI unavailable")) : Effect.succeed(provider),
      ),
    );
    const instance: ProviderInstance = {
      instanceId,
      driverKind: driver,
      continuationIdentity: { driverKind: driver, continuationKey: "codex:instance:codex" },
      displayName: undefined,
      enabled: true,
      snapshot: {
        resolveMaintenance: () =>
          Effect.succeed(
            makeManualOnlyProviderMaintenanceCapabilities({ provider: driver, packageName: null }),
          ),
        getSnapshot: Effect.succeed(provider),
        refresh,
        streamChanges: Stream.empty,
        applyUsageLimits: () => Effect.void,
      },
      orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
      textGeneration: {} as ProviderInstance["textGeneration"],
    };
    const registryLayer = ProviderRegistry.layer.pipe(
      Layer.provide(
        Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
          getInstance: () => Effect.succeed(instance),
          listInstances: Effect.succeed([instance]),
          listUnavailable: Effect.succeed([]),
          streamChanges: Stream.empty,
          subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
        }),
      ),
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "j5-skill-discovery-" })),
      Layer.provide(ProviderLatestVersions.layer),
      Layer.provide(ModelManifest.layerTest),
      Layer.provide(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const registry = yield* ProviderRegistry.ProviderRegistry;
      yield* registry.refreshInstance(instanceId);
      yield* Ref.set(failRefresh, true);

      const [manual] = yield* registry.refreshInstance(instanceId);
      assert.strictEqual(manual?.status, "ready");
      assert.strictEqual(manual?.skillDiscoveryError, "Provider discovery failed.");

      assert.deepStrictEqual(yield* registry.refreshAfterUpdate(driver, instanceId), []);
      const [afterUpdate] = yield* registry.getProviders;
      assert.strictEqual(afterUpdate?.status, "error");
      assert.strictEqual(afterUpdate?.message, "Provider refresh failed after update.");
    }).pipe(Effect.provide(registryLayer));
  }),
);
