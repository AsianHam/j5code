import type { ServerProviderSkill } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

// The same shapes upstream's discovery decodes, so both accept and reject the same files.
const InstalledPlugins = Schema.fromJsonString(
  Schema.Struct({ plugins: Schema.Record(Schema.String, Schema.Array(Schema.Unknown)) }),
);
const decodeInstallPath = Schema.decodeUnknownOption(
  Schema.Struct({ installPath: Schema.NonEmptyString }),
);
const PluginManifest = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.optional(Schema.NonEmptyString),
    skills: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  }),
);

/**
 * Upstream names a plugin skill by namespace (`tools:review`), but Settings → Skills links by
 * registry key (`tools@market`). Recover it as the first key, in upstream's sorted order, whose
 * installation holds the skill under that namespace; keys can share an installation.
 */
export const addClaudePluginIds = Effect.fn("addClaudePluginIds")(function* (
  skills: ReadonlyArray<ServerProviderSkill>,
  configDirPath: string,
  cwd: string | undefined,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  if (!skills.some((skill) => skill.name.includes(":"))) return skills;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const pluginDirectory = environment.CLAUDE_CODE_PLUGIN_CACHE_DIR;
  const pluginsPath = pluginDirectory
    ? path.resolve(cwd ?? ".", expandHomePath(pluginDirectory, home))
    : path.join(configDirPath, "plugins");
  const installed = yield* fileSystem
    .readFileString(path.join(pluginsPath, "installed_plugins.json"))
    .pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(InstalledPlugins)),
      Effect.orElseSucceed(() => undefined),
    );
  if (installed === undefined) return skills;
  const installs = Object.entries(installed.plugins)
    .sort()
    .flatMap(([pluginId, entries]) =>
      entries.flatMap((entry) =>
        Option.toArray(decodeInstallPath(entry)).map(({ installPath }) => ({
          pluginId,
          directory: path.resolve(cwd ?? ".", installPath),
        })),
      ),
    );
  const manifestNames = new Map<string, string | undefined>();
  const namespaceOf = Effect.fn("addClaudePluginIds.namespaceOf")(function* (
    pluginId: string,
    directory: string,
  ) {
    if (!manifestNames.has(directory)) {
      const manifest = yield* fileSystem
        .readFileString(path.join(directory, ".claude-plugin", "plugin.json"))
        .pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(PluginManifest)),
          Effect.orElseSucceed(() => undefined),
        );
      manifestNames.set(directory, manifest?.name);
    }
    return manifestNames.get(directory) ?? pluginId.split("@")[0];
  });
  return yield* Effect.forEach(skills, (skill) =>
    Effect.gen(function* () {
      if (!skill.name.includes(":")) return skill;
      for (const { pluginId, directory } of installs) {
        const relative = path.relative(directory, skill.path);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
          continue;
        if (skill.name.startsWith(`${yield* namespaceOf(pluginId, directory)}:`)) {
          return { ...skill, pluginId };
        }
      }
      return skill;
    }),
  );
});
