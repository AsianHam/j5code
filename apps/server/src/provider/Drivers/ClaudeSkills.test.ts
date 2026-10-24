import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveProviderSkillPaths } from "../../j5/skills/skillPaths.ts";

import { discoverClaudeSkills } from "./ClaudeSkills.ts";
import { planClaudeSkillDispatch } from "./ClaudeSkillDispatch.ts";

const writeSkill = Effect.fn(function* (
  skillsDir: string,
  directoryName: string,
  contents: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillDir = path.join(skillsDir, directoryName);
  yield* fs.makeDirectory(skillDir, { recursive: true });
  yield* fs.writeFileString(path.join(skillDir, "SKILL.md"), contents);
});

const encodePluginFixture = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const writeJson = Effect.fn(function* (file: string, value: unknown) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(file, encodePluginFixture(value));
});

it.layer(NodeServices.layer)("Claude plugin inventory", (it) => {
  it.effect(
    "skips plugin settings and repository probes for an empty registry while retaining ordinary overrides",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const configDir = path.join(root, "config");
        yield* fs.makeDirectory(path.join(root, ".git"));
        yield* writeSkill(path.join(configDir, "skills"), "ordinary", "# Ordinary");
        yield* writeJson(path.join(configDir, "settings.json"), {
          skillOverrides: { ordinary: "off" },
        });
        yield* writeJson(path.join(configDir, "plugins", "installed_plugins.json"), {
          version: 2,
          plugins: {},
        });
        const reads: string[] = [];
        const probes: string[] = [];
        const skills = yield* discoverClaudeSkills({ homePath: configDir }, root).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readFileString: (file, options) => {
              reads.push(file);
              return fs.readFileString(file, options);
            },
            exists: (file) => {
              probes.push(file);
              return fs.exists(file);
            },
          }),
        );
        assert.deepStrictEqual(
          skills.map((skill) => [skill.name, skill.enabled]),
          [["ordinary", false]],
        );
        assert.equal(
          reads.filter((file) => file === path.join(configDir, "settings.json")).length,
          1,
        );
        assert.deepStrictEqual(probes, [path.join(root, ".git")]);
        assert.equal(reads.at(-1), path.join(configDir, "plugins", "installed_plugins.json"));
      }),
  );
  it.effect("honors managed enablement and resolves plugin skill directory and file symlinks", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const configDir = path.join(root, "config");
      const plugin = path.join(root, "plugin");
      const target = path.join(root, "shared.md");
      yield* fs.writeFileString(target, "---\nname: review\n---\n");
      yield* fs.makeDirectory(path.join(plugin, "skills", "linked"), { recursive: true });
      yield* fs.symlink(target, path.join(plugin, "skills", "linked", "SKILL.md"));
      const pluginLink = path.join(root, "plugin-link");
      yield* fs.symlink(plugin, pluginLink);
      yield* writeJson(path.join(configDir, "plugins", "installed_plugins.json"), {
        version: 2,
        plugins: { "tools@managed": [{ scope: "managed", installPath: pluginLink }] },
      });
      yield* writeJson(path.join(configDir, "settings.json"), {
        enabledPlugins: { "tools@managed": true },
      });
      const programData = path.join(root, "policy");
      yield* writeJson(path.join(programData, "ClaudeCode", "managed-settings.json"), {
        enabledPlugins: { "tools@managed": false },
      });
      const discovered = yield* discoverClaudeSkills({ homePath: configDir }, undefined, {
        PROGRAMDATA: programData,
      }).pipe(Effect.provideService(HostProcess.Platform, "win32"));
      const skills = yield* resolveProviderSkillPaths(discovered);
      assert.deepStrictEqual(skills, [
        {
          name: "tools:linked",
          path: path.join(pluginLink, "skills", "linked", "SKILL.md"),
          linkTarget: yield* fs.realPath(target),
          enabled: false,
          scope: "managed",
          pluginId: "tools@managed",
        },
      ]);
    }),
  );
  it.effect("names plugin skills by directory when frontmatter repeats the namespace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const configDir = path.join(root, "config");
      const plugin = path.join(root, "caveman");
      yield* writeSkill(
        path.join(plugin, "skills"),
        "compress",
        "---\nname: caveman-compress\n---\n",
      );
      yield* writeJson(path.join(configDir, "plugins", "installed_plugins.json"), {
        version: 2,
        plugins: { "caveman@market": [{ scope: "user", installPath: plugin }] },
      });
      yield* writeJson(path.join(configDir, "settings.json"), {
        enabledPlugins: { "caveman@market": true },
      });

      const skills = yield* discoverClaudeSkills({ homePath: configDir });

      assert.deepStrictEqual(
        skills.map((skill) => skill.name),
        ["caveman:compress"],
      );
    }),
  );
  it.effect("reads plugin skill files in order with at most eight concurrent reads", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const configDir = path.join(root, "config");
      const plugin = path.join(root, "plugin");
      const names = Array.from(
        { length: 17 },
        (_, index) => `skill-${String(index).padStart(2, "0")}`,
      );
      for (const name of names) yield* writeSkill(path.join(plugin, "skills"), name, "# Skill");
      yield* writeJson(path.join(configDir, "plugins", "installed_plugins.json"), {
        version: 2,
        plugins: { "tools@market": [{ scope: "user", installPath: plugin }] },
      });
      let active = 0;
      let peak = 0;
      const skills = yield* discoverClaudeSkills({ homePath: configDir }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFileString: (file, options) =>
            file.endsWith("SKILL.md")
              ? Effect.gen(function* () {
                  peak = Math.max(peak, ++active);
                  try {
                    yield* Effect.yieldNow;
                    return yield* fs.readFileString(file, options);
                  } finally {
                    active--;
                  }
                })
              : fs.readFileString(file, options),
        }),
      );
      assert.equal(peak, 8);
      assert.deepStrictEqual(
        skills.map((skill) => skill.name),
        names.map((name) => `tools:${name}`),
      );
    }),
  );
  it.effect(
    "respects installation scope, project association, enablement precedence, namespaces and manifest paths",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const configDir = path.join(root, "config");
        const workspace = path.join(root, "project");
        yield* fs.makeDirectory(path.join(workspace, ".git"), { recursive: true });
        const user = path.join(root, "user-install");
        const local = path.join(root, "local-install");
        const project = path.join(root, "project-install");
        const foreign = path.join(root, "foreign-install");
        const disabled = path.join(root, "disabled-install");
        for (const install of [user, local, project, foreign, disabled]) {
          yield* writeJson(path.join(install, ".claude-plugin", "plugin.json"), {
            name: "tools",
            skills: ["./extras", "./direct", "./skills"],
          });
          yield* writeSkill(
            path.join(install, "skills"),
            "review",
            "---\nname: renamed\ndescription: Review code\nuser-invocable: false\n---\n",
          );
          yield* writeSkill(
            path.join(install, "extras"),
            "deploy",
            "---\nname: tools:deploy\ndisable-model-invocation: true\n---\n",
          );
          yield* writeSkill(install, "direct", "# Direct skill");
        }
        yield* writeSkill(path.join(configDir, "skills"), "review", "# Ordinary skill");
        yield* writeJson(path.join(configDir, "plugins", "installed_plugins.json"), {
          version: 2,
          plugins: {
            "tools@market": [
              { scope: "user", installPath: user },
              { scope: "local", projectPath: workspace, installPath: local },
            ],
            "project@market": [{ scope: "project", projectPath: workspace, installPath: project }],
            "foreign@market": [
              { scope: "project", projectPath: `${workspace}-other`, installPath: foreign },
            ],
            "disabled@market": [{ scope: "user", installPath: disabled }],
          },
        });
        yield* writeJson(path.join(configDir, "settings.json"), {
          enabledPlugins: {
            "tools@market": false,
            "project@market": true,
            "foreign@market": true,
            "disabled@market": true,
          },
          skillOverrides: { "tools:review": "off", review: "off" },
        });
        yield* writeJson(path.join(workspace, ".claude", "settings.json"), {
          enabledPlugins: { "tools@market": true, "disabled@market": false },
        });
        yield* writeJson(path.join(workspace, ".claude", "settings.local.json"), {
          enabledPlugins: { "project@market": false },
        });
        const skills = yield* discoverClaudeSkills(
          { homePath: configDir },
          path.join(workspace, "nested"),
        );
        const tools = skills.filter((skill) => skill.pluginId === "tools@market");
        assert.deepStrictEqual(
          tools.map((skill) => skill.name),
          ["tools:deploy", "tools:direct", "tools:review"],
        );
        assert.isTrue(
          tools.every(
            (skill) => skill.enabled && skill.scope === "local" && skill.path.startsWith(local),
          ),
        );
        assert.isTrue(tools.find((skill) => skill.name === "tools:deploy")!.userInvocationOnly);
        assert.isFalse(tools.find((skill) => skill.name === "tools:review")!.userInvocable);
        assert.isFalse(skills.find((skill) => skill.name === "review")!.enabled);
        assert.isTrue(
          skills
            .filter(
              (skill) =>
                skill.pluginId === "project@market" || skill.pluginId === "disabled@market",
            )
            .every((skill) => !skill.enabled),
        );
        assert.isFalse(skills.some((skill) => skill.pluginId === "foreign@market"));
        const global = yield* discoverClaudeSkills({ homePath: configDir });
        assert.isFalse(
          global.some((skill) => skill.scope === "project" || skill.scope === "local"),
        );
        assert.isTrue(
          global
            .filter((skill) => skill.pluginId === "tools@market")
            .every((skill) => !skill.enabled && skill.path.startsWith(user)),
        );
      }),
  );

  it.effect(
    "isolates malformed registry entries and manifests, tolerates absent manifests, and retains disabled installs",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const configDir = path.join(root, "config");
        yield* writeSkill(path.join(configDir, "skills"), "ordinary", "# Ordinary");
        const plugin = path.join(root, "plugin");
        yield* writeSkill(plugin, "skills", "---\nname: solo\n---\n");
        yield* writeJson(path.join(configDir, "plugins", "installed_plugins.json"), {
          version: 2,
          plugins: {
            "invalid@market": { installPath: plugin },
            "partial@market": [
              null,
              { scope: "user", installPath: 42 },
              { scope: "user", installPath: plugin },
            ],
            "missing-project@market": [{ scope: "local", installPath: plugin }],
          },
        });
        let skills = yield* discoverClaudeSkills({ homePath: configDir }, root);
        assert.deepStrictEqual(
          skills.map((skill) => skill.name),
          ["ordinary", "partial:skills"],
        );
        assert.isFalse(skills[1]!.enabled);
        yield* writeJson(path.join(plugin, ".claude-plugin", "plugin.json"), { skills: 42 });
        skills = yield* discoverClaudeSkills({ homePath: configDir }, root);
        assert.deepStrictEqual(
          skills.map((skill) => skill.name),
          ["ordinary"],
        );
        yield* fs.writeFileString(
          path.join(configDir, "plugins", "installed_plugins.json"),
          "{ broken",
        );
        assert.deepStrictEqual(
          (yield* discoverClaudeSkills({ homePath: configDir }, root)).map((skill) => skill.name),
          ["ordinary"],
        );
      }),
  );
});

it.layer(NodeServices.layer)("discoverClaudeSkills", (it) => {
  it.effect("discovers enabled plugin skills with manifest names and ignores skill overrides", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const plugin = path.join(configDir, "plugins", "cache", "shop", "plugin", "1.0.0");
      const disabled = path.join(configDir, "plugins", "disabled");
      yield* writeSkill(path.join(disabled, "skills"), "hidden", "# Hidden");
      yield* writeSkill(path.join(plugin, "skills"), "plain", "# Plain");
      yield* writeSkill(
        path.join(plugin, "engineering"),
        "review",
        "---\nname: review-alias\ndescription: Review changes.\ndisable-model-invocation: true\nuser-invocable: false\n---\n",
      );
      yield* fs.makeDirectory(path.join(plugin, ".claude-plugin"), { recursive: true });
      yield* fs.writeFileString(
        path.join(plugin, ".claude-plugin", "plugin.json"),
        '{"name":"manifest-plugin","skills":["./engineering/review"]}',
      );
      yield* fs.writeFileString(
        path.join(configDir, "plugins", "installed_plugins.json"),
        JSON.stringify({
          plugins: {
            "plugin@shop": [{ scope: "user", installPath: plugin }],
            "disabled@shop": [{ scope: "user", installPath: disabled }],
            "unconfigured@shop": [{ scope: "user", installPath: disabled }],
          },
        }),
      );
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{"enabledPlugins":{"plugin@shop":true,"disabled@shop":false,"uninstalled@shop":true,"other@shop":["^1.0.0"]},"skillOverrides":{"manifest-plugin:plain":"off"}}',
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir });
      assert.deepEqual(skills, [
        {
          name: "manifest-plugin:plain",
          path: path.join(plugin, "skills", "plain", "SKILL.md"),
          enabled: true,
          scope: "user",
        },
        {
          name: "manifest-plugin:review-alias",
          path: path.join(plugin, "engineering", "review", "SKILL.md"),
          enabled: true,
          scope: "user",
          description: "Review changes.",
          userInvocationOnly: true,
          userInvocable: false,
        },
      ]);
    }),
  );

  it.effect("merges plugin enablement and selects installs in native registry order", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");
      const nestedWorkspace = path.join(workspace, "packages", "app");
      const aliasedWorkspace = path.join(tempDir, "aliased-workspace");
      const userInstall = path.join(configDir, "plugins", "user");
      const projectInstall = path.join(configDir, "plugins", "project");
      const localInstall = path.join(configDir, "plugins", "local");
      const managedInstall = path.join(configDir, "plugins", "managed");
      yield* fs.makeDirectory(path.join(workspace, ".git"), { recursive: true });
      yield* fs.makeDirectory(nestedWorkspace, { recursive: true });
      yield* fs.symlink(workspace, aliasedWorkspace);
      for (const install of [userInstall, projectInstall, localInstall, managedInstall]) {
        yield* writeSkill(path.join(install, "skills"), "review", "# Review");
      }
      yield* fs.writeFileString(
        path.join(configDir, "plugins", "installed_plugins.json"),
        JSON.stringify({
          plugins: {
            "plugin@shop": [
              { scope: "project", projectPath: aliasedWorkspace, installPath: localInstall },
              { scope: "project", projectPath: workspace, installPath: projectInstall },
              { scope: "user", installPath: userInstall },
              { scope: "managed", installPath: managedInstall },
            ],
            "local@shop": [
              { scope: "local", projectPath: workspace, installPath: localInstall },
              { scope: "project", projectPath: workspace, installPath: projectInstall },
              { scope: "managed", installPath: path.join(configDir, "plugins", "missing") },
              { scope: "managed", installPath: managedInstall },
              { scope: "user", installPath: userInstall },
            ],
          },
        }),
      );
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{"enabledPlugins":{"plugin@shop":true,"local@shop":false}}',
      );
      yield* fs.makeDirectory(path.join(workspace, ".claude"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workspace, ".claude", "settings.json"),
        '{"enabledPlugins":{"plugin@shop":false,"local@shop":true,"other@shop":["^1.0.0"]}}',
      );
      const projectSettings = yield* discoverClaudeSkills({ homePath: configDir }, workspace);
      assert.deepEqual(
        projectSettings.map((skill) => [skill.name, skill.scope, skill.path]),
        [["local:review", "project", path.join(localInstall, "skills", "review", "SKILL.md")]],
      );
      assert.deepEqual(
        (yield* discoverClaudeSkills({ homePath: configDir }, nestedWorkspace)).map((skill) => [
          skill.name,
          skill.scope,
          skill.path,
        ]),
        [["plugin:review", "project", path.join(projectInstall, "skills", "review", "SKILL.md")]],
      );
      yield* fs.writeFileString(
        path.join(workspace, ".claude", "settings.local.json"),
        '{"enabledPlugins":{"plugin@shop":true,"local@shop":false},"skillOverrides":{"invalid":"bogus"}}',
      );
      assert.deepEqual(
        yield* discoverClaudeSkills({ homePath: configDir }, workspace),
        projectSettings,
      );
      yield* fs.writeFileString(
        path.join(workspace, ".claude", "settings.local.json"),
        '{"enabledPlugins":{"plugin@shop":true,"local@shop":true}}',
      );
      const localSettings = yield* discoverClaudeSkills({ homePath: configDir }, workspace);
      assert.deepEqual(
        localSettings.map((skill) => [skill.name, skill.scope, skill.path]),
        [
          ["local:review", "project", path.join(localInstall, "skills", "review", "SKILL.md")],
          ["plugin:review", "project", path.join(projectInstall, "skills", "review", "SKILL.md")],
        ],
      );
      assert.deepEqual(
        yield* discoverClaudeSkills({ homePath: configDir }, nestedWorkspace),
        localSettings,
      );
      assert.deepEqual(
        yield* discoverClaudeSkills({ homePath: configDir }, aliasedWorkspace),
        localSettings,
      );
      yield* fs.writeFileString(
        path.join(workspace, ".claude", "settings.local.json"),
        '{"enabledPlugins":{"local@shop":["^1.0.0"]}}',
      );
      assert.deepEqual(yield* discoverClaudeSkills({ homePath: configDir }, workspace), []);
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{"enabledPlugins":{"plugin@shop":true,"local@shop":true}}',
      );
      const separateRepository = path.join(workspace, "separate");
      yield* fs.makeDirectory(path.join(separateRepository, ".git"), { recursive: true });
      for (const cwd of [undefined, path.join(tempDir, "elsewhere"), separateRepository]) {
        const elsewhere = yield* discoverClaudeSkills({ homePath: configDir }, cwd);
        assert.deepEqual(
          elsewhere.map((skill) => [skill.name, skill.scope, skill.path]),
          [
            ["local:review", "user", path.join(managedInstall, "skills", "review", "SKILL.md")],
            ["plugin:review", "user", path.join(userInstall, "skills", "review", "SKILL.md")],
          ],
        );
      }
      const worktree = path.join(tempDir, "worktree");
      const worktreeGitDirectory = path.join(workspace, ".git", "worktrees", "fixture");
      yield* fs.makeDirectory(worktree);
      yield* fs.makeDirectory(worktreeGitDirectory, { recursive: true });
      yield* fs.writeFileString(path.join(worktree, ".git"), `gitdir: ${worktreeGitDirectory}\n`);
      yield* fs.writeFileString(path.join(worktreeGitDirectory, "commondir"), "../..\n");
      yield* fs.writeFileString(
        path.join(worktreeGitDirectory, "gitdir"),
        path.join(worktree, ".git"),
      );
      assert.deepEqual(
        yield* discoverClaudeSkills({ homePath: configDir }, worktree),
        localSettings,
      );
      const linkedWorktree = path.join(tempDir, "linked-worktree");
      yield* fs.symlink(worktree, linkedWorktree);
      assert.deepEqual(
        yield* discoverClaudeSkills({ homePath: configDir }, linkedWorktree),
        localSettings,
      );
    }),
  );

  it.effect("publishes and dispatches canonical plugin folder names regardless of aliases", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const plugin = path.join(configDir, "plugins", "installed");
      yield* writeSkill(path.join(plugin, "skills"), "review", "---\nname: review-alias\n---\n");
      yield* writeSkill(path.join(plugin, "skills"), "alias", "---\nname: dot.alias\n---\n");
      yield* fs.writeFileString(
        path.join(configDir, "plugins", "installed_plugins.json"),
        JSON.stringify({ plugins: { "plugin@shop": [{ scope: "user", installPath: plugin }] } }),
      );
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{"enabledPlugins":{"plugin@shop":true}}',
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir });
      assert.deepEqual(
        planClaudeSkillDispatch(
          "$plugin:alias focus on auth",
          new Map(skills.map((skill) => [skill.name, skill])),
        ),
        {
          leadingText: undefined,
          commandText: "/plugin:alias focus on auth",
          skillName: "plugin:alias",
        },
      );
      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["plugin:alias", "plugin:review"],
      );
    }),
  );

  it.effect("uses the native cache root, root-skill fallback and manifest path boundaries", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(workspace, "config");
      const pluginsDir = path.join(workspace, "plugin-cache");
      const plugin = path.join(pluginsDir, "installed");
      const outside = path.join(workspace, "outside");
      yield* writeSkill(pluginsDir, "installed", "---\nname: plugin:root.alias\n---\n");
      yield* fs.makeDirectory(configDir);
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{"enabledPlugins":{"plugin@shop":true}}',
      );
      yield* fs.writeFileString(
        path.join(pluginsDir, "installed_plugins.json"),
        JSON.stringify({ plugins: { "plugin@shop": [{ scope: "user", installPath: plugin }] } }),
      );
      const environment = { CLAUDE_CODE_PLUGIN_CACHE_DIR: "plugin-cache" };
      assert.deepEqual(
        (yield* discoverClaudeSkills({ homePath: configDir }, workspace, environment)).map(
          (skill) => skill.name,
        ),
        ["plugin:root-alias"],
      );

      yield* writeSkill(path.join(plugin, "skills"), "plain", "# Plain");
      yield* writeSkill(plugin, "custom", "---\nname: custom.review\n---\n");
      yield* writeSkill(outside, "escaped", "# Outside");
      yield* fs.symlink(outside, path.join(plugin, "escape"));
      yield* fs.makeDirectory(path.join(plugin, ".claude-plugin"));
      yield* fs.writeFileString(
        path.join(plugin, ".claude-plugin", "plugin.json"),
        '{"skills":["./custom","./escape","../../outside"]}',
      );
      assert.deepEqual(
        (yield* discoverClaudeSkills({ homePath: configDir }, workspace, environment)).map(
          (skill) => skill.name,
        ),
        ["plugin:custom-review", "plugin:plain"],
      );
    }),
  );

  it.effect("discovers user and project skills with frontmatter metadata", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "codex-review",
        [
          "---",
          "name: codex-review",
          "description: Ask Codex for a review.",
          "---",
          "",
          "# Body",
        ].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Deploy the app.", "---", "", "# Deploy"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace);

      assert.deepEqual(skills, [
        {
          name: "codex-review",
          path: path.join(configDir, "skills", "codex-review", "SKILL.md"),
          enabled: true,
          scope: "user",
          description: "Ask Codex for a review.",
        },
        {
          name: "deploy",
          path: path.join(workspace, ".claude", "skills", "deploy", "SKILL.md"),
          enabled: true,
          scope: "project",
          description: "Deploy the app.",
        },
      ]);
    }),
  );

  it.effect("discovers skills from the instance's --add-dir launch args", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");
      const extraDir = path.join(workspace, "extra skills");
      yield* fs.makeDirectory(workspace, { recursive: true });
      yield* writeSkill(
        path.join(extraDir, ".claude", "skills"),
        "demo",
        ["---", "description: From an additional directory.", "---"].join("\n"),
      );

      assert.deepEqual(yield* discoverClaudeSkills({ homePath: configDir }, workspace), []);
      for (const launchArgs of [
        `--add-dir "${extraDir}"`,
        `--add-dir="${extraDir}"`,
        '--add-dir "extra skills"',
        '--add-dir="extra skills"',
        `--add-dir missing --add-dir "${extraDir}"`,
      ]) {
        const settings = { homePath: configDir, launchArgs };
        const skills = yield* discoverClaudeSkills(settings, workspace);
        assert.deepEqual(skills, [
          {
            name: "demo",
            path: path.join(extraDir, ".claude", "skills", "demo", "SKILL.md"),
            enabled: true,
            scope: "project",
            description: "From an additional directory.",
          },
        ]);
      }
      const settings = { homePath: configDir, launchArgs: `--add-dir "${extraDir}"` };
      const skills = yield* discoverClaudeSkills(settings, workspace);
      assert.deepEqual(
        planClaudeSkillDispatch(
          "$demo",
          new Map(skills.map((skill) => [skill.name, { path: skill.path }])),
        ),
        {
          leadingText: undefined,
          commandText: "/demo",
          skillName: "demo",
        },
      );
      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "demo",
        "---\ndescription: Project copy.\n---",
      );
      const projectSkills = yield* discoverClaudeSkills(settings, workspace);
      assert.equal(projectSkills[0]?.description, "Project copy.");
      for (const launchArgs of ["--add-dir", '--add-dir=""', '--add-dir "extra skills"']) {
        const settings = { homePath: configDir, launchArgs };
        assert.deepEqual(yield* discoverClaudeSkills(settings), []);
      }
    }),
  );

  it.effect("prefers user skills on name collisions even with a stray .agents copy", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "deploy",
        ["---", "name: deploy", "description: User deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".agents", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Agents deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Claude deploy.", "---"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace);

      assert.deepEqual(skills, [
        {
          name: "deploy",
          path: path.join(configDir, "skills", "deploy", "SKILL.md"),
          enabled: true,
          scope: "user",
          description: "User deploy.",
        },
      ]);
    }),
  );

  it.effect("recovers colon-bearing descriptions with invocation metadata intact", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");

      for (const [description, comment] of [
        ["Browser automation + AI test authoring via kane-cli: run browser objectives, ...", ""],
        ['Read C:\\skills\\guide#tag: continue with "quoted".', " # trailing: comment"],
      ] as const) {
        yield* writeSkill(
          path.join(configDir, "skills"),
          "kane-cli",
          [
            "---",
            "name: frontmatter-alias",
            `description: ${description}${comment}`,
            "allowed-tools: [Read, Write]",
            "disable-model-invocation: yes",
            "user-invocable: no",
            "---",
          ].join("\n"),
        );

        const skills = yield* discoverClaudeSkills({ homePath: configDir }, undefined);

        assert.deepEqual(skills, [
          {
            name: "kane-cli",
            path: path.join(configDir, "skills", "kane-cli", "SKILL.md"),
            enabled: true,
            scope: "user",
            description,
            userInvocationOnly: true,
            userInvocable: false,
          },
        ]);
      }
    }),
  );

  it.effect("falls back to the directory name and skips malformed frontmatter", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const skillsDir = path.join(configDir, "skills");

      yield* writeSkill(skillsDir, "no-frontmatter", "# Just a heading\n");
      for (const [directoryName, field] of [
        ["broken-yaml", "name: [unclosed"],
        ["broken-tools", "allowed-tools: [Read, Write"],
        ["broken-quoted", 'name: "unclosed: text'],
      ] as const) {
        yield* writeSkill(
          skillsDir,
          directoryName,
          ["---", "description: Run: browser objectives.", field, "---"].join("\n"),
        );
      }
      yield* fs.makeDirectory(skillsDir, { recursive: true });
      yield* fs.writeFileString(path.join(skillsDir, "README.md"), "not a skill");

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, undefined);

      // A skill with no frontmatter falls back to its directory name; a skill
      // whose frontmatter fails to parse is skipped entirely (Claude Code
      // won't load it either).
      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["no-frontmatter"],
      );
      assert.equal(skills[0]?.description, undefined);
    }),
  );

  it.effect("honors CLAUDE_CONFIG_DIR from the environment when homePath is unset", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const environmentConfigDir = path.join(tempDir, "env-config");

      yield* writeSkill(
        path.join(environmentConfigDir, "skills"),
        "env-skill",
        ["---", "name: env-skill", "description: From env config dir.", "---"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: "" }, undefined, {
        CLAUDE_CONFIG_DIR: environmentConfigDir,
      });

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["env-skill"],
      );

      const explicitHome = path.join(tempDir, "explicit-home");
      yield* writeSkill(
        path.join(explicitHome, "skills"),
        "explicit-skill",
        ["---", "name: explicit-skill", "---"].join("\n"),
      );
      const explicitSkills = yield* discoverClaudeSkills({ homePath: explicitHome }, undefined, {
        CLAUDE_CONFIG_DIR: environmentConfigDir,
      });
      assert.deepEqual(
        explicitSkills.map((skill) => skill.name),
        ["explicit-skill"],
      );
    }),
  );

  it.effect("resolves a relative CLAUDE_CONFIG_DIR against the workspace cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const workspace = path.join(tempDir, "workspace");
      yield* fs.makeDirectory(workspace, { recursive: true });

      // The spawned CLI resolves a relative CLAUDE_CONFIG_DIR against its own
      // cwd (the workspace), so discovery must do the same.
      yield* writeSkill(
        path.join(workspace, "relative-config", "skills"),
        "relative-skill",
        ["---", "name: relative-skill", "---"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: "" }, workspace, {
        CLAUDE_CONFIG_DIR: "relative-config",
      });

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["relative-skill"],
      );
      assert.equal(skills[0]?.scope, "user");
    }),
  );

  it.effect("disables skills switched off by skillOverrides", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");

      for (const name of ["kept", "off-by-user", "off-by-project"]) {
        yield* writeSkill(
          path.join(configDir, "skills"),
          name,
          ["---", `name: ${name}`, "---", "", "# Body"].join("\n"),
        );
      }

      yield* fs.makeDirectory(configDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{ "skillOverrides": { "off-by-user": "off", "kept": "on" } }',
      );
      yield* fs.makeDirectory(path.join(workspace, ".claude"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workspace, ".claude", "settings.json"),
        '{ "skillOverrides": { "off-by-project": "off" } }',
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace);

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.enabled]),
        [
          ["kept", true],
          ["off-by-project", false],
          ["off-by-user", false],
        ],
      );
    }),
  );

  it.effect("ignores unreadable settings when resolving skillOverrides", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "kept",
        ["---", "name: kept", "---", "", "# Body"].join("\n"),
      );
      yield* fs.writeFileString(path.join(configDir, "settings.json"), "{ not json");

      const skills = yield* discoverClaudeSkills({ homePath: configDir });

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.enabled]),
        [["kept", true]],
      );
    }),
  );

  it.effect("treats a user-invocable-only override like disable-model-invocation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "ask-matt",
        ["---", "name: ask-matt", "---", "", "# Body"].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{ "skillOverrides": { "ask-matt": "user-invocable-only" } }',
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir });

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.enabled, skill.userInvocationOnly === true]),
        [["ask-matt", true, true]],
      );
    }),
  );

  it.effect("drops every override in a file when one value is invalid, as Claude Code does", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");

      for (const name of ["unknown-mode", "boolean-false", "sibling-off"]) {
        yield* writeSkill(
          path.join(configDir, "skills"),
          name,
          ["---", `name: ${name}`, "---", "", "# Body"].join("\n"),
        );
      }
      // Verified against the CLI: with an unknown string or a boolean in the
      // map, the valid "off" sibling is ignored too and every skill runs.
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{ "skillOverrides": { "unknown-mode": "some-future-mode", "boolean-false": false, "sibling-off": "off" } }',
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir });

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.enabled]),
        [
          ["boolean-false", true],
          ["sibling-off", true],
          ["unknown-mode", true],
        ],
      );
    }),
  );

  it.effect("reads repository root settings from a nested workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const repo = path.join(tempDir, "repo");
      const workspace = path.join(repo, "packages", "app");

      for (const name of ["root-off", "root-off-cwd-on", "cwd-off-root-on"]) {
        yield* writeSkill(
          path.join(configDir, "skills"),
          name,
          ["---", `name: ${name}`, "---", "", "# Body"].join("\n"),
        );
      }
      yield* fs.makeDirectory(path.join(repo, ".git"), { recursive: true });
      yield* fs.makeDirectory(path.join(repo, ".claude"), { recursive: true });
      yield* fs.makeDirectory(path.join(workspace, ".claude"), { recursive: true });
      // The CLI ignores the root's plain settings.json from a nested cwd.
      yield* fs.writeFileString(
        path.join(repo, ".claude", "settings.json"),
        '{ "skillOverrides": { "cwd-off-root-on": "off" } }',
      );
      // The root local file outranks the workspace local file, as in the CLI.
      yield* fs.writeFileString(
        path.join(repo, ".claude", "settings.local.json"),
        '{ "skillOverrides": { "root-off": "off", "root-off-cwd-on": "off", "cwd-off-root-on": "on" } }',
      );
      yield* fs.writeFileString(
        path.join(workspace, ".claude", "settings.local.json"),
        '{ "skillOverrides": { "root-off-cwd-on": "on", "cwd-off-root-on": "off" } }',
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace);

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.enabled]),
        [
          ["cwd-off-root-on", true],
          ["root-off", false],
          ["root-off-cwd-on", false],
        ],
      );
    }),
  );

  it.effect("ignores ancestor settings outside a repository", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const parent = path.join(tempDir, "not-a-repo");
      const workspace = path.join(parent, "workspace");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "kept",
        ["---", "name: kept", "---", "", "# Body"].join("\n"),
      );
      yield* fs.makeDirectory(path.join(parent, ".claude"), { recursive: true });
      yield* fs.makeDirectory(workspace, { recursive: true });
      yield* fs.writeFileString(
        path.join(parent, ".claude", "settings.local.json"),
        '{ "skillOverrides": { "kept": "off" } }',
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace);

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.enabled]),
        [["kept", true]],
      );
    }),
  );

  it.effect("identifies a skill by its directory, as Claude Code does", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "probe-alias",
        ["---", "name: probe-alias-frontmatter", "---", "", "# Body"].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{ "skillOverrides": { "probe-alias-frontmatter": "off" } }',
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir });

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.enabled]),
        [["probe-alias", true]],
      );
    }),
  );

  // regression: #9128 skills picked from the composer did not run
  it.effect("switches a skill off by its directory name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "probe-alias",
        ["---", "name: probe-alias-frontmatter", "---", "", "# Body"].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{ "skillOverrides": { "probe-alias": "off" } }',
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir });

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.enabled]),
        [["probe-alias", false]],
      );
    }),
  );

  it.effect("accepts the YAML 1.1 boolean spellings Claude Code allows", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const skillsDir = path.join(configDir, "skills");

      yield* writeSkill(
        skillsDir,
        "user-only-yes",
        ["---", "disable-model-invocation: yes", "---", "", "# Body"].join("\n"),
      );
      yield* writeSkill(
        skillsDir,
        "agent-only-no",
        ["---", "user-invocable: no", "---", "", "# Body"].join("\n"),
      );
      yield* writeSkill(
        skillsDir,
        "plain-off",
        ["---", "disable-model-invocation: off", "---", "", "# Body"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir });

      assert.deepEqual(
        skills.map((skill) => [
          skill.name,
          skill.userInvocationOnly === true,
          skill.userInvocable === false,
        ]),
        [
          ["agent-only-no", false, true],
          ["plain-off", false, false],
          ["user-only-yes", true, false],
        ],
      );
    }),
  );
});
