import type { ServerProviderSkill } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  claudeManagedSettingsPath,
  findRepositoryRoot,
  parseSkillFrontmatter,
} from "../../provider/Drivers/ClaudeSkills.ts";

const PluginInstallation = Schema.Struct({
  scope: Schema.Literals(["user", "project", "local", "managed"]),
  installPath: Schema.NonEmptyString,
  projectPath: Schema.optional(Schema.NonEmptyString),
});
const PluginRegistry = Schema.Struct({
  version: Schema.Literal(2),
  plugins: Schema.Record(Schema.String, Schema.Unknown),
});
const PluginManifest = Schema.Struct({
  name: Schema.optional(Schema.NonEmptyString),
  skills: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
});
const PluginSettings = Schema.Struct({
  enabledPlugins: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
});

const decodePluginJson = Schema.decodeUnknownEffect(fromLenientJson(Schema.Unknown));
const decodePluginRegistry = Schema.decodeUnknownEffect(PluginRegistry);
const decodePluginInstallation = Schema.decodeUnknownEffect(PluginInstallation);
const decodePluginManifest = Schema.decodeUnknownEffect(PluginManifest);
const decodePluginSettings = Schema.decodeUnknownEffect(PluginSettings);

const readPluginJson = Effect.fn("readClaudePluginJson")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(file).pipe(
    Effect.flatMap(decodePluginJson),
    Effect.orElseSucceed(() => undefined),
  );
});

// Claude Code identifies user, project, and plugin skills by directory, not
// frontmatter `name`. Plugins add their namespace: `compress/SKILL.md` with
// `name: caveman-compress` is `caveman:compress`. Ordinary skillOverrides also
// use directory names; plugin enablement is independent of those overrides.
export const discoverClaudePluginSkills = Effect.fn("discoverClaudePluginSkills")(function* (
  configDir: string,
  cwd: string | undefined,
  environment: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const registry = yield* readPluginJson(
    path.join(configDir, "plugins", "installed_plugins.json"),
  ).pipe(
    Effect.flatMap(decodePluginRegistry),
    Effect.orElseSucceed(() => undefined),
  );
  if (!registry || Object.keys(registry.plugins).length === 0) return [];

  // Plugin enablement is independent of ordinary skillOverrides. Read project
  // settings from the repository root down to the selected working directory.
  const repositoryRoot = cwd ? yield* findRepositoryRoot(cwd) : undefined;
  const projectDirs: string[] = [];
  if (cwd) {
    let directory = path.resolve(cwd);
    while (true) {
      projectDirs.unshift(directory);
      if (!repositoryRoot || directory === repositoryRoot) break;
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  const managed = claudeManagedSettingsPath(path, platform, environment);
  const enabledPlugins = new Map<string, boolean>();
  for (const file of [
    path.join(configDir, "settings.json"),
    ...projectDirs.flatMap((directory) => [
      path.join(directory, ".claude", "settings.json"),
      path.join(directory, ".claude", "settings.local.json"),
    ]),
    ...(managed ? [managed] : []),
  ]) {
    const settings = yield* readPluginJson(file).pipe(
      Effect.flatMap(decodePluginSettings),
      Effect.orElseSucceed(() => undefined),
    );
    for (const [id, enabled] of Object.entries(settings?.enabledPlugins ?? {})) {
      enabledPlugins.set(id, enabled);
    }
  }

  const skills: ServerProviderSkill[] = [];
  const pluginFiles: Array<{
    file: string;
    namespace: string;
    pluginId: string;
    scope: "user" | "project" | "local" | "managed";
  }> = [];
  const scopePriority = { user: 0, project: 1, local: 2, managed: 3 };
  for (const [pluginId, entries] of Object.entries(registry.plugins)) {
    if (!pluginId.trim() || !Array.isArray(entries)) continue;
    const installations: Array<typeof PluginInstallation.Type> = [];
    for (const entry of entries) {
      const installation = yield* decodePluginInstallation(entry).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (!installation || !path.isAbsolute(installation.installPath)) continue;
      if (installation.scope === "project" || installation.scope === "local") {
        if (!cwd || !installation.projectPath || !path.isAbsolute(installation.projectPath))
          continue;
        const relative = path.relative(installation.projectPath, path.resolve(cwd));
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
          continue;
      }
      installations.push(installation);
    }
    const installation = installations.sort(
      (a, b) => scopePriority[b.scope] - scopePriority[a.scope],
    )[0];
    if (!installation) continue;
    const manifestPath = path.join(installation.installPath, ".claude-plugin", "plugin.json");
    const hasManifest = yield* fs.exists(manifestPath).pipe(Effect.orElseSucceed(() => false));
    const manifest = hasManifest
      ? yield* readPluginJson(manifestPath).pipe(
          Effect.flatMap(decodePluginManifest),
          Effect.orElseSucceed(() => undefined),
        )
      : {};
    if (!manifest) continue;
    const namespace = manifest.name?.trim() || pluginId.split("@")[0];
    if (!namespace) continue;
    const declared =
      typeof manifest.skills === "string" ? [manifest.skills] : (manifest.skills ?? []);
    const roots = [path.join(installation.installPath, "skills")];
    for (const location of declared) {
      if (location !== "." && !location.startsWith("./")) continue;
      const root = path.resolve(installation.installPath, location);
      const relative = path.relative(installation.installPath, root);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        continue;
      roots.push(root);
    }
    if (
      manifest.skills === undefined &&
      !(yield* fs.exists(roots[0]!).pipe(Effect.orElseSucceed(() => false)))
    ) {
      roots.push(installation.installPath);
    }
    const seenFiles = new Set<string>();
    for (const root of new Set(roots)) {
      const directFile = path.join(root, "SKILL.md");
      const files = (yield* fs.exists(directFile).pipe(Effect.orElseSucceed(() => false)))
        ? [directFile]
        : (yield* fs.readDirectory(root).pipe(Effect.orElseSucceed((): string[] => [])))
            .sort()
            .map((entry) => path.join(root, entry, "SKILL.md"));
      for (const file of files) {
        if (seenFiles.has(file)) continue;
        seenFiles.add(file);
        pluginFiles.push({ file, namespace, pluginId, scope: installation.scope });
      }
    }
  }
  const contents = yield* Effect.forEach(
    pluginFiles,
    ({ file }) => fs.readFileString(file).pipe(Effect.orElseSucceed(() => undefined)),
    { concurrency: 8 },
  );
  for (const [index, { file, namespace, pluginId, scope }] of pluginFiles.entries()) {
    const content = contents[index];
    if (content === undefined) continue;
    const frontmatter = parseSkillFrontmatter(content);
    if (frontmatter.kind === "malformed") continue;
    const name = path.basename(path.dirname(file));
    skills.push({
      name: `${namespace}:${name}`,
      path: file,
      pluginId,
      scope,
      enabled: enabledPlugins.get(pluginId) ?? false,
      ...(frontmatter.kind === "parsed" && frontmatter.description
        ? { description: frontmatter.description }
        : {}),
      ...(frontmatter.kind === "parsed" && frontmatter.userInvocationOnly
        ? { userInvocationOnly: true }
        : {}),
      ...(frontmatter.kind === "parsed" && frontmatter.userInvocable === false
        ? { userInvocable: false }
        : {}),
    });
  }
  return skills;
});
