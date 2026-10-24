import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverClaudeSkills } from "../../provider/Drivers/ClaudeSkills.ts";

const writeFile = Effect.fn(function* (file: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(file, contents);
});

it.layer(NodeServices.layer)("Claude plugin ids", (it) => {
  it.effect(
    "names the registry key of each discovered plugin skill, even on a shared install",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const configDir = path.join(root, "config");
        const shared = path.join(root, "shared-install");
        const named = path.join(root, "named-install");
        // The project is itself an installed plugin: its own skills stay unattributed.
        const workspace = path.join(root, "project");
        yield* writeFile(path.join(shared, "skills", "review", "SKILL.md"), "# Review");
        yield* writeFile(path.join(named, "skills", "deploy", "SKILL.md"), "# Deploy");
        yield* writeFile(
          path.join(named, ".claude-plugin", "plugin.json"),
          JSON.stringify({ name: "ops" }),
        );
        yield* writeFile(path.join(workspace, ".claude", "skills", "local", "SKILL.md"), "# Local");
        yield* writeFile(path.join(configDir, "skills", "ordinary", "SKILL.md"), "# Ordinary");
        yield* writeFile(
          path.join(configDir, "plugins", "installed_plugins.json"),
          JSON.stringify({
            plugins: {
              "alpha@shop": [{ scope: "user", installPath: shared }],
              "beta@shop": [{ scope: "user", installPath: shared }],
              "tools@shop": [{ scope: "user", installPath: named }],
              "self@shop": [{ scope: "project", projectPath: workspace, installPath: workspace }],
            },
          }),
        );
        yield* writeFile(
          path.join(configDir, "settings.json"),
          JSON.stringify({
            enabledPlugins: {
              "alpha@shop": true,
              "beta@shop": true,
              "tools@shop": true,
              "self@shop": true,
            },
          }),
        );

        const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace);

        assert.deepStrictEqual(
          skills.map((skill) => [skill.name, skill.pluginId]),
          [
            ["alpha:review", "alpha@shop"],
            ["beta:review", "beta@shop"],
            ["local", undefined],
            ["ops:deploy", "tools@shop"],
            ["ordinary", undefined],
          ],
        );
      }),
  );
});
