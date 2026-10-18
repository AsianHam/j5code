import * as NodeOS from "node:os";
import {
  ClaudeSettings,
  CodexSettings,
  SkillCatalogError,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ServerProvider,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { canonicalSkillRoot } from "./skillFileSystem.ts";
import { resolveClaudeConfigDirPath } from "../../provider/Drivers/ClaudeSkills.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";

const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);
const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);
const failure = (cause: unknown) => new SkillCatalogError({ message: String(cause) });

export const resolveSkillRoot = Effect.fn("j5.skills.resolveLinkRoot")(function* (
  instance: ProviderInstanceConfig,
  scope: "user" | "project",
  cwd?: string,
) {
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  if (instance.driver !== "codex" && instance.driver !== "claudeAgent")
    return yield* failure("Linking is supported only for Codex and Claude.");
  if (scope === "project") {
    if (!cwd) return yield* failure("Select an existing project for project scope.");
    return path.join(cwd, instance.driver === "codex" ? ".agents" : ".claude", "skills");
  }
  const environment = yield* mergeProviderInstanceEnvironment(instance.environment);
  if (instance.driver === "codex") {
    yield* decodeCodexSettings(instance.config ?? {}).pipe(Effect.mapError(failure));
    // CODEX_HOME (including shadow homes) does not change the user .agents root.
    const home =
      (platform === "win32" ? environment.USERPROFILE : environment.HOME) || NodeOS.homedir();
    return path.resolve(cwd ?? process.cwd(), home, ".agents", "skills");
  }
  const config = yield* decodeClaudeSettings(instance.config ?? {}).pipe(Effect.mapError(failure));
  return path.join(yield* resolveClaudeConfigDirPath(config, environment, cwd), "skills");
});

/** Include providers that read the same physical roots, including Cursor's shared scans. */
export const affectedSkillProviderIds = Effect.fn("j5.skills.affectedProviders")(function* (
  snapshots: ReadonlyArray<ServerProvider>,
  instances: ProviderInstanceConfigMap,
  targets: ReadonlyArray<string>,
  context?: { readonly scope: "user" | "project"; readonly cwd?: string | undefined },
) {
  const path = yield* Path.Path;
  const projectCwd = context?.scope === "project" ? context.cwd : undefined;
  const roots = new Set(
    yield* Effect.tryPromise({
      try: () => Promise.all(targets.map(canonicalSkillRoot)),
      catch: failure,
    }),
  );
  const affected = yield* Effect.forEach(
    snapshots.filter((snapshot) => snapshot.enabled),
    (snapshot) =>
      Effect.gen(function* () {
        const instance = instances[snapshot.instanceId];
        if (!instance) return [];
        const candidates = new Set<string>();
        const cwds = projectCwd
          ? [projectCwd]
          : [
              undefined,
              ...(snapshot.workspaceSnapshots ?? []).map((entry) => entry.cwd),
              ...(context?.cwd ? [context.cwd] : []),
            ];
        for (const cwd of cwds) {
          if (instance.driver === "codex" || instance.driver === "claudeAgent") {
            candidates.add(yield* resolveSkillRoot(instance, projectCwd ? "project" : "user", cwd));
          } else if (instance.driver === "cursor") {
            const env = yield* mergeProviderInstanceEnvironment(instance.environment);
            const base =
              projectCwd ?? (env.HOME?.trim() || env.USERPROFILE?.trim() || NodeOS.homedir());
            for (const directory of [".cursor", ".agents", ".codex", ".claude"])
              candidates.add(path.join(base, directory, "skills"));
          }
        }
        for (const skill of [
          ...snapshot.skills,
          ...(snapshot.workspaceSnapshots ?? []).flatMap((entry) => entry.skills),
        ]) {
          candidates.add(path.dirname(path.dirname(skill.path)));
        }
        const matches = yield* Effect.forEach(
          candidates,
          (candidate) =>
            Effect.tryPromise({ try: () => canonicalSkillRoot(candidate), catch: failure }).pipe(
              Effect.map((root) => roots.has(root)),
              Effect.orElseSucceed(() => false),
            ),
          { concurrency: 4 },
        );
        return matches.some(Boolean) ? [snapshot.instanceId] : [];
      }).pipe(Effect.orElseSucceed(() => [])),
    { concurrency: 4 },
  );
  return affected.flat();
});
