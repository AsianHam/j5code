import {
  AuthProvidersManageScope,
  AuthOrchestrationOperateScope,
  J5_SKILL_CATALOG_WS_METHODS,
  SkillCatalogError,
  resolveProviderInstanceEnabled,
  type J5SkillCatalogRpcSchemas,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ServerConfig } from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { createSkillCatalogTool } from "./skillCatalogTool.ts";
import { deriveProviderInstanceConfigMap } from "../../provider/ProviderInstanceRegistryHydration.ts";
import { affectedSkillProviderIds, resolveSkillRoot } from "./skillRoots.ts";
import { canonicalSkillRoot } from "./skillFileSystem.ts";
import { refreshSkillProviders } from "./skillProviderRefresh.ts";

const METHODS = J5_SKILL_CATALOG_WS_METHODS;

/** Spread into `RPC_REQUIRED_SCOPES`; the upstream `satisfies` check still covers every tag. */
export const SKILL_CATALOG_RPC_SCOPES = {
  [METHODS.getSkillCatalogStatus]: AuthOrchestrationOperateScope,
  // Installing from a catalog is an Owner's (People and access AC20): only an Owner's level
  // gives Manage providers.
  [METHODS.applySkillCatalogGroups]: AuthProvidersManageScope,
  [METHODS.updateSkillCatalog]: AuthProvidersManageScope,
} as const;

type Input<K extends keyof typeof J5SkillCatalogRpcSchemas> =
  (typeof J5SkillCatalogRpcSchemas)[K]["input"]["Type"];

/** Handlers for `J5SkillCatalogRpcGroup`; spread once into the upstream handler object. */
export const makeSkillCatalogRpcHandlers = Effect.fn("j5.makeSkillCatalogRpcHandlers")(
  function* () {
    const config = yield* ServerConfig;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const providers = yield* ProviderRegistry;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // Provide the shared process runner here so the WebSocket layer gains no
    // new service requirement; only platform services stay in context.
    const processRunner = yield* ProcessRunner.ProcessRunner.pipe(
      Effect.provide(ProcessRunner.layer),
    );
    const catalogContext = Effect.fn("j5.skills.catalogContext")(function* () {
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError((cause) => new SkillCatalogError({ message: String(cause) })),
      );
      const configurations = deriveProviderInstanceConfigMap(settings);
      const instances = Object.entries(configurations).filter(
        ([, instance]) =>
          resolveProviderInstanceEnabled(instance) &&
          (instance.driver === "codex" || instance.driver === "claudeAgent"),
      );
      const roots = yield* Effect.forEach(
        instances,
        ([, instance]) =>
          resolveSkillRoot(instance, "user").pipe(
            Effect.provideService(Path.Path, path),
            Effect.flatMap((root) =>
              Effect.tryPromise({
                try: () => canonicalSkillRoot(root),
                catch: (cause) => new SkillCatalogError({ message: String(cause) }),
              }),
            ),
          ),
        { concurrency: 4 },
      );
      const targets = [...new Set(roots)];
      const affected = yield* affectedSkillProviderIds(
        yield* providers.getProviders,
        configurations,
        targets,
      ).pipe(Effect.provideService(Path.Path, path));
      return {
        tool: createSkillCatalogTool({
          stateDir: config.stateDir,
          targets,
          fs,
          path,
          processRunner,
        }),
        refresh: refreshSkillProviders(providers, affected).pipe(Effect.ignoreCause({ log: true })),
      };
    });

    // Transport context, not a skill-management concept: reject a stale page's
    // request before invoking the tool, then run against the captured source
    // even if settings change mid-operation.
    const matchingSource = Effect.fn("j5.skillCatalog.matchingSource")(function* (
      expectedSource: string,
    ): Effect.fn.Return<string, SkillCatalogError> {
      const configured = yield* serverSettings.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new SkillCatalogError({ message: `Could not read server settings: ${String(cause)}` }),
        ),
      );
      if (expectedSource !== configured.skillCatalogSource) {
        return yield* new SkillCatalogError({
          reason: "source-changed",
          message: "Skill catalog source changed. Reload Settings → Skills and retry.",
        });
      }
      return configured.skillCatalogSource;
    });

    return {
      [METHODS.getSkillCatalogStatus]: Effect.fn("j5.skills.skillCatalogRpc.getSkillCatalogStatus")(
        function* (input: Input<"getSkillCatalogStatus">) {
          const source = yield* matchingSource(input.expectedSource);
          const { tool } = yield* catalogContext();
          return yield* tool.status({ source });
        },
      ),
      [METHODS.applySkillCatalogGroups]: Effect.fn(
        "j5.skills.skillCatalogRpc.applySkillCatalogGroups",
      )(function* (input: Input<"applySkillCatalogGroups">) {
        const source = yield* matchingSource(input.expectedSource);
        const { tool, refresh } = yield* catalogContext();
        // Partial failures can still change links. Preserve the apply result
        // while publishing fresh discovery to every connected client.
        return yield* tool
          .apply({
            source,
            groups: input.groups,
            ...(input.replacements ? { replacements: input.replacements } : {}),
          })
          .pipe(Effect.ensuring(refresh));
      }),
      [METHODS.updateSkillCatalog]: Effect.fn("j5.skills.skillCatalogRpc.updateSkillCatalog")(
        function* (input: Input<"updateSkillCatalog">) {
          const source = yield* matchingSource(input.expectedSource);
          const { tool, refresh } = yield* catalogContext();
          return yield* tool.update({ source }).pipe(Effect.ensuring(refresh));
        },
      ),
    };
  },
);
