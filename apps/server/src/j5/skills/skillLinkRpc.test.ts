import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type SkillLinkCreate,
  type SkillLinkRequest,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as ProcessRunner from "../../processRunner.ts";
import { layerTest as configLayer } from "../../config.ts";
import { discoverClaudeSkills } from "../../provider/Drivers/ClaudeSkills.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { makeProviderRegistryMock } from "../../provider/testUtils/providerRegistryMock.ts";
import { layerTest as settingsLayer, ServerSettingsService } from "../../serverSettings.ts";
import { resolveSkillRoot } from "./skillRoots.ts";
import { skillCatalogPermit } from "./skillCatalogTool.ts";
import { makeSkillLinkRpcHandlers, skillLinkDiscovery } from "./skillLinkRpc.ts";

const sourceId = ProviderInstanceId.make("source");
const targetId = ProviderInstanceId.make("claude-work");
const projectId = ProjectId.make("project");
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const temp = yield* fs.makeTempDirectoryScoped({ prefix: "skill-link-rpc-" });
  const root = yield* fs.realPath(temp);
  const source = path.join(root, "source", "example", "SKILL.md");
  const cwd = path.join(root, "project");
  const claudeHome = path.join(root, "claude-home");
  const stateDir = path.join(root, "state");
  const processRunner = yield* ProcessRunner.ProcessRunner.pipe(
    Effect.provide(ProcessRunner.layer),
  );
  yield* fs.makeDirectory(path.dirname(source), { recursive: true });
  yield* fs.makeDirectory(cwd);
  yield* fs.writeFileString(
    source,
    "---\nname: example\ndescription: Shared test\n---\nInstructions\n",
  );
  const base: ServerProvider = {
    instanceId: sourceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-19T00:00:00Z",
    models: [],
    slashCommands: [],
    skills: [{ name: "example", path: source, scope: "user", enabled: true }],
  };
  const snapshots = yield* Ref.make<ReadonlyArray<ServerProvider>>([
    base,
    { ...base, instanceId: targetId, driver: ProviderDriverKind.make("claudeAgent"), skills: [] },
  ]);
  const failRefresh = yield* Ref.make(false);
  const hideSkill = yield* Ref.make(false);
  const refreshes = yield* Ref.make<ReadonlyArray<string>>([]);
  const beforeRefresh = yield* Ref.make(Effect.void);
  const refresh = (id: ProviderInstanceId, workspace?: string) =>
    Effect.gen(function* () {
      yield* yield* Ref.get(beforeRefresh);
      yield* Ref.update(refreshes, (ids) => [...ids, `${id}:${workspace ?? "user"}`]);
      if (id === targetId && (yield* Ref.get(failRefresh)))
        return yield* Effect.die("discovery offline");
      const skills = (yield* Ref.get(hideSkill))
        ? []
        : yield* discoverClaudeSkills({ homePath: claudeHome }, workspace);
      yield* Ref.update(snapshots, (all) =>
        all.map((entry) =>
          entry.instanceId !== targetId || id !== targetId
            ? entry
            : workspace
              ? {
                  ...entry,
                  workspaceSnapshots: [
                    { cwd: workspace, checkedAt: base.checkedAt, skills, slashCommands: [] },
                  ],
                }
              : { ...entry, skills, workspaceSnapshots: [] },
        ),
      );
      return yield* Ref.get(snapshots);
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  const homeVar = (yield* HostProcess.Platform) === "win32" ? "USERPROFILE" : "HOME";
  const layer = Layer.mergeAll(
    configLayer(root, stateDir),
    settingsLayer({
      providerInstances: {
        [sourceId]: {
          driver: ProviderDriverKind.make("codex"),
          config: { homePath: path.join(root, "custom-codex") },
          environment: [{ name: homeVar, value: root, sensitive: false }],
        },
        [targetId]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: { homePath: claudeHome },
        },
        [ProviderInstanceId.make("claude-shared")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: { homePath: claudeHome },
        },
      },
    }),
    Layer.succeed(ProviderRegistry, {
      ...makeProviderRegistryMock(),
      getProviders: Ref.get(snapshots),
      refreshInstance: (id) => refresh(id),
      refreshWorkspaceSnapshot: (input) => refresh(input.instanceId, input.cwd),
    }),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const { handlers, settings } = yield* Effect.gen(function* () {
    return {
      handlers: yield* makeSkillLinkRpcHandlers({
        getProjectRoot: (id) => Effect.succeed(id === projectId ? cwd : undefined),
      }),
      settings: yield* ServerSettingsService,
    };
  }).pipe(Effect.provide(layer));
  const request: SkillLinkRequest = {
    source: { instanceId: sourceId, path: source, name: "example" },
    targetInstanceId: targetId,
    scope: "user",
    projectId,
  };
  const prepare = Effect.fn("test.prepareLink")(function* (input = request) {
    const result = yield* handlers["j5.skills.links.preview"](input);
    return {
      ...input,
      expectedSourcePath: result.sourcePath,
      expectedDestinationPath: result.destinationPath,
    } satisfies SkillLinkCreate;
  });
  return {
    fs,
    processRunner,
    path,
    root,
    source,
    cwd,
    claudeHome,
    stateDir,
    snapshots,
    base,
    failRefresh,
    hideSkill,
    refreshes,
    beforeRefresh,
    settings,
    handlers,
    reopen: makeSkillLinkRpcHandlers({
      getProjectRoot: (id) => Effect.succeed(id === projectId ? cwd : undefined),
    }).pipe(Effect.provide(layer)),
    request,
    prepare,
  };
});
const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | FileSystem.FileSystem
    | Path.Path
    | import("effect/Scope").Scope
    | import("effect/process/ChildProcessSpawner").ChildProcessSpawner
  >,
) => effect.pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("skill link RPCs", () => {
  it.effect(
    "deletes a confirmed original skill, refreshes only affected providers outside the permit, and reports refresh failure",
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture;
          const folder = f.path.join(f.claudeHome, "skills", "example");
          yield* f.fs.makeDirectory(f.path.dirname(folder), { recursive: true });
          yield* f.fs.rename(f.path.dirname(f.source), folder);
          const request = {
            source: {
              instanceId: targetId,
              path: f.path.join(folder, "SKILL.md"),
              name: "example",
            },
          };
          yield* Ref.update(f.snapshots, (all) =>
            all.map((entry) =>
              entry.instanceId === targetId
                ? { ...entry, skills: [{ ...f.base.skills[0]!, path: request.source.path }] }
                : entry,
            ),
          );
          const handlers = yield* f.reopen;
          const preview = yield* handlers["j5.skills.links.deletePreview"](request);
          assert.equal(preview.expectedPath, folder);
          assert.isTrue(yield* f.fs.exists(request.source.path));
          const changed = yield* Effect.flip(
            handlers["j5.skills.links.delete"]({
              ...request,
              ...preview,
              expectedIdentity: "changed",
            }),
          );
          assert.match(changed.message, /changed/);
          assert.isTrue(yield* f.fs.exists(request.source.path));
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          yield* Ref.set(
            f.beforeRefresh,
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
          );
          yield* Ref.set(f.failRefresh, true);
          const pending = yield* handlers["j5.skills.links.delete"]({
            ...request,
            ...preview,
          }).pipe(Effect.forkChild);
          yield* Effect.gen(function* () {
            yield* Deferred.await(started);
            assert.isFalse(yield* f.fs.exists(folder));
            const available = yield* skillCatalogPermit.withPermitsIfAvailable(1)(Effect.void);
            assert.equal(available._tag, "Some");
          }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
          const result = yield* Fiber.join(pending);
          assert.equal(result.action, "removed");
          assert.equal(result.discovery, "failed");
          assert.match(result.message, /permanently deleted.*refresh failed/);
          assert.deepEqual(yield* Ref.get(f.refreshes), [`${targetId}:user`]);
        }),
      ),
  );
  it.effect("rejects deletion outside provider roots, forged sources, and read-only origins", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        const request = { source: f.request.source };
        const outside = yield* Effect.flip(f.handlers["j5.skills.links.deletePreview"](request));
        assert.match(outside.message, /outside/);
        const forged = yield* Effect.flip(
          f.handlers["j5.skills.links.deletePreview"]({
            source: { ...request.source, path: f.root },
          }),
        );
        assert.match(forged.message, /no longer in provider discovery/);
        for (const scope of ["plugin", "system", "unknown"]) {
          yield* Ref.update(f.snapshots, (all) =>
            all.map((entry) =>
              entry.instanceId === sourceId
                ? { ...entry, skills: [{ ...f.base.skills[0]!, scope }] }
                : entry,
            ),
          );
          const blocked = yield* Effect.flip(
            f.handlers["j5.skills.links.delete"]({
              ...request,
              expectedPath: f.path.dirname(f.source),
              expectedIdentity: "forged",
            }),
          );
          assert.match(blocked.message, /plugin|cannot be linked|unclassified/);
        }
        yield* Ref.update(f.snapshots, (all) =>
          all.map((entry) => (entry.instanceId === sourceId ? f.base : entry)),
        );
        yield* Ref.update(f.snapshots, (all) =>
          all.map((entry) =>
            entry.instanceId === sourceId
              ? {
                  ...entry,
                  skills: [
                    {
                      ...f.base.skills[0]!,
                      linkTarget: f.path.join(f.root, ".codex", "plugins", "example", "SKILL.md"),
                    },
                  ],
                }
              : entry,
          ),
        );
        const pluginTarget = yield* Effect.flip(
          f.handlers["j5.skills.links.deletePreview"](request),
        );
        assert.match(pluginTarget.message, /plugin/);
        yield* Ref.update(f.snapshots, (all) =>
          all.map((entry) => (entry.instanceId === sourceId ? f.base : entry)),
        );
        yield* f.settings.updateSettings({ skillCatalogSource: f.path.dirname(f.source) });
        const catalog = yield* Effect.flip(f.handlers["j5.skills.links.deletePreview"](request));
        assert.match(catalog.message, /Only original personal or project/);
        assert.isTrue(yield* f.fs.exists(f.source));
        assert.deepEqual(yield* Ref.get(f.refreshes), []);
      }),
    ),
  );

  it.effect(
    "finds unmanaged aliases after restarting and unlinks both providers with one refresh each",
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture;
          const codexRoot = f.path.join(f.root, "custom-codex", "skills");
          const claudeRoot = f.path.join(f.claudeHome, "skills");
          const sourceFolder = f.path.dirname(f.source);
          yield* f.fs.writeFileString(f.path.join(sourceFolder, "asset.txt"), "keep me");
          for (const root of [codexRoot, claudeRoot]) {
            yield* f.fs.makeDirectory(root, { recursive: true });
            yield* f.fs.symlink(sourceFolder, f.path.join(root, "different-name"));
          }
          yield* Ref.update(f.snapshots, (all) => [
            ...all,
            { ...all[1]!, instanceId: ProviderInstanceId.make("claude-shared") },
          ]);
          const handlers = yield* f.reopen;
          assert.deepEqual(yield* handlers["j5.skills.links.list"](), []);
          const links = yield* handlers["j5.skills.links.inspect"]({
            source: f.request.source,
            projectId,
          });
          assert.equal(links.length, 2);
          assert.include(
            links.find((link) => link.request.targetInstanceId === targetId)!.label,
            "claude-shared",
          );
          const result = yield* handlers["j5.skills.links.unlink"]({
            links: links.map((link) => link.request),
          });
          assert.equal(result.removedPaths.length, 2);
          assert.deepEqual(result.failed, []);
          assert.isFalse(result.refreshFailed);
          for (const root of [codexRoot, claudeRoot])
            assert.isFalse(yield* f.fs.exists(f.path.join(root, "different-name")));
          assert.equal(
            yield* f.fs.readFileString(f.path.join(sourceFolder, "asset.txt")),
            "keep me",
          );
          assert.isTrue(yield* f.fs.exists(f.source));
          const refreshes = yield* Ref.get(f.refreshes);
          for (const id of [sourceId, targetId, "claude-shared"])
            assert.equal(refreshes.filter((entry) => entry === `${id}:user`).length, 1);
        }),
      ),
  );
  it.effect("keeps healthy roots usable and rejects destinations under a broken root", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        const brokenRoot = f.path.join(f.root, "custom-codex", "skills");
        const healthyRoot = f.path.join(f.claudeHome, "skills");
        const healthyLink = f.path.join(healthyRoot, "alias");
        yield* f.fs.makeDirectory(f.path.dirname(brokenRoot), { recursive: true });
        yield* f.fs.symlink(f.path.join(f.root, "missing"), brokenRoot);
        yield* f.fs.makeDirectory(healthyRoot, { recursive: true });
        yield* f.fs.symlink(f.path.dirname(f.source), healthyLink);

        const links = yield* f.handlers["j5.skills.links.inspect"]({ source: f.request.source });
        assert.equal(links.length, 1);
        assert.equal(links[0]!.request.expectedDestinationPath, healthyLink);
        const result = yield* f.handlers["j5.skills.links.unlink"]({
          links: [
            { ...links[0]!.request, expectedDestinationPath: f.path.join(brokenRoot, "alias") },
            links[0]!.request,
          ],
        });
        assert.deepEqual(result.removedPaths, [healthyLink]);
        assert.equal(result.failed.length, 1);
        assert.match(result.failed[0]!.message, /Destination changed/);

        const folder = f.path.join(healthyRoot, "example");
        yield* f.fs.rename(f.path.dirname(f.source), folder);
        const request = {
          source: { instanceId: targetId, path: f.path.join(folder, "SKILL.md"), name: "example" },
        };
        yield* Ref.update(f.snapshots, (all) =>
          all.map((entry) =>
            entry.instanceId === targetId
              ? { ...entry, skills: [{ ...f.base.skills[0]!, path: request.source.path }] }
              : entry,
          ),
        );
        const preview = yield* f.handlers["j5.skills.links.deletePreview"](request);
        assert.equal(preview.expectedPath, folder);
        const deleted = yield* f.handlers["j5.skills.links.delete"]({ ...request, ...preview });
        assert.equal(deleted.action, "removed");
        assert.isFalse(yield* f.fs.exists(folder));
      }),
    ),
  );
  it.effect(
    "unlinks one provider, preserves changed links and directories, and reports partial failure",
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture;
          const root = f.path.join(f.claudeHome, "skills");
          yield* f.fs.makeDirectory(root, { recursive: true });
          const sourceFolder = f.path.dirname(f.source);
          for (const name of ["first", "second"])
            yield* f.fs.symlink(sourceFolder, f.path.join(root, name));
          const links = yield* f.handlers["j5.skills.links.inspect"]({ source: f.request.source });
          const first = links.find((entry) =>
            entry.request.expectedDestinationPath.endsWith("first"),
          )!;
          const second = links.find((entry) =>
            entry.request.expectedDestinationPath.endsWith("second"),
          )!;
          yield* f.fs.rename(
            first.request.expectedDestinationPath,
            `${first.request.expectedDestinationPath}-old`,
          );
          yield* f.fs.symlink(sourceFolder, first.request.expectedDestinationPath);
          const original = f.path.join(root, "original");
          yield* f.fs.makeDirectory(original);
          yield* Ref.set(f.failRefresh, true);
          const result = yield* f.handlers["j5.skills.links.unlink"]({
            links: [
              first.request,
              second.request,
              { ...second.request, expectedDestinationPath: original },
            ],
          });
          assert.deepEqual(result.removedPaths, [second.request.expectedDestinationPath]);
          assert.equal(result.failed.length, 2);
          assert.isTrue(result.refreshFailed);
          assert.isTrue(yield* f.fs.exists(first.request.expectedDestinationPath));
          assert.isTrue(yield* f.fs.exists(original));
          assert.isTrue(yield* f.fs.exists(f.source));
        }),
      ),
  );
  it.effect(
    "recovers saved managed links after restarting and rejects paths outside skill roots",
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.handlers["j5.skills.links.create"](yield* f.prepare());
          const handlers = yield* f.reopen;
          const [link] = yield* handlers["j5.skills.links.inspect"]({ source: f.request.source });
          assert.isDefined(link);
          const rejected = yield* handlers["j5.skills.links.unlink"]({
            links: [{ ...link!.request, expectedDestinationPath: f.path.dirname(f.source) }],
          });
          assert.equal(rejected.failed.length, 1);
          assert.deepEqual(rejected.removedPaths, []);
          const result = yield* handlers["j5.skills.links.unlink"]({ links: [link!.request] });
          assert.equal(result.removedPaths.length, 1);
          assert.deepEqual(yield* handlers["j5.skills.links.list"](), []);
          assert.isTrue(yield* f.fs.exists(f.source));
        }),
      ),
  );
  it.effect("links default provider instances and honors explicit instance overrides", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        const claudeId = ProviderInstanceId.make("claudeAgent");
        const codexId = ProviderInstanceId.make("codex");
        // Codex stays an implicit default; Claude's default needs a home inside the fixture.
        yield* f.settings.updateSettings({
          providerInstances: {
            ...(yield* f.settings.getSettings).providerInstances,
            [claudeId]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { homePath: f.claudeHome },
            },
          },
        });
        assert.isUndefined((yield* f.settings.getSettings).providerInstances[codexId]);
        const claudeRequest = { ...f.request, targetInstanceId: claudeId };
        const preview = yield* f.handlers["j5.skills.links.preview"](claudeRequest);
        assert.equal(preview.destinationPath, f.path.join(f.claudeHome, "skills", "example"));
        assert.deepEqual(
          preview.sharedWith.map((entry) => entry.instanceId).sort(),
          [claudeId, targetId, "claude-shared"].sort(),
        );
        for (const request of [
          claudeRequest,
          { ...f.request, targetInstanceId: codexId, scope: "project" as const },
        ]) {
          const create = yield* f.prepare(request);
          assert.equal((yield* f.handlers["j5.skills.links.create"](create)).action, "created");
          assert.equal((yield* f.handlers["j5.skills.links.create"](create)).action, "unchanged");
          const [link] = yield* f.handlers["j5.skills.links.list"]();
          assert.equal(link!.targetInstanceId, request.targetInstanceId);
          yield* f.handlers["j5.skills.links.remove"]({ id: link!.id });
          assert.isTrue(yield* f.fs.exists(f.source));
        }
        yield* f.settings.updateSettings({
          providerInstances: {
            [claudeId]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { homePath: f.path.join(f.root, "explicit-claude") },
            },
          },
        });
        assert.equal(
          (yield* f.handlers["j5.skills.links.preview"](claudeRequest)).destinationPath,
          f.path.join(f.root, "explicit-claude", "skills", "example"),
        );
        const missing = yield* Effect.flip(
          f.handlers["j5.skills.links.preview"]({
            ...f.request,
            targetInstanceId: ProviderInstanceId.make("removed-instance"),
          }),
        );
        assert.match(missing.message, /destination provider instance no longer exists/);
      }),
    ),
  );
  it.effect("warns about Git exposure unless the project destination is ignored", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.processRunner.run({ command: "git", args: ["init", "--quiet"], cwd: f.cwd });
        const request = { ...f.request, scope: "project" as const };
        const warning = (warnings: ReadonlyArray<string>) =>
          warnings.some((message) => message.includes("not confirmed ignored by Git"));
        assert.isTrue(warning((yield* f.handlers["j5.skills.links.preview"](request)).warnings));
        yield* f.fs.writeFileString(
          f.path.join(f.cwd, ".git", "info", "exclude"),
          ".claude/skills/\n",
        );
        assert.isFalse(warning((yield* f.handlers["j5.skills.links.preview"](request)).warnings));
        yield* f.fs.symlink(f.root, f.path.join(f.cwd, ".claude"));
        const error = yield* Effect.flip(f.handlers["j5.skills.links.preview"](request));
        assert.match(error.message, /outside the selected project/);
      }),
    ),
  );
  it.effect(
    "refreshes shared relative homes in the selected workspace while leaving unrelated providers alone",
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture;
          const shared = ProviderInstanceId.make("claude-shared");
          yield* f.settings.updateSettings({
            providerInstances: {
              [targetId]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                config: { homePath: "" },
                environment: [
                  { name: "CLAUDE_CONFIG_DIR", value: "../claude-home", sensitive: false },
                ],
              },
              [shared]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                config: { homePath: "" },
                environment: [
                  { name: "CLAUDE_CONFIG_DIR", value: "../claude-home", sensitive: false },
                ],
              },
            },
          });
          yield* Ref.update(f.snapshots, (all) => [
            ...all,
            {
              ...f.base,
              instanceId: shared,
              driver: ProviderDriverKind.make("claudeAgent"),
              skills: [],
              workspaceSnapshots: [],
            },
          ]);
          yield* f.handlers["j5.skills.links.create"](yield* f.prepare());
          const refreshed = yield* Ref.get(f.refreshes);
          assert.include(refreshed, `${targetId}:user`);
          assert.include(refreshed, `${shared}:user`);
          assert.include(refreshed, `${shared}:${f.cwd}`);
          assert.isFalse(refreshed.some((entry) => entry.startsWith(`${sourceId}:`)));
          const [link] = yield* f.handlers["j5.skills.links.list"]();
          yield* f.fs.remove(link!.destinationPath);
          yield* f.fs.writeFileString(link!.destinationPath, "replacement");
          yield* Ref.set(f.refreshes, []);
          const forgotten = yield* f.handlers["j5.skills.links.remove"]({
            id: link!.id,
            forget: true,
          });
          assert.equal(forgotten.action, "forgotten");
          assert.equal(yield* f.fs.readFileString(link!.destinationPath), "replacement");
          assert.deepEqual(yield* f.handlers["j5.skills.links.list"](), []);
          assert.deepEqual(yield* Ref.get(f.refreshes), []);
        }),
      ),
  );
  it.effect("repeats a request when discovery now reports another link to the same source", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        const request = yield* f.prepare();
        yield* f.handlers["j5.skills.links.create"](request);
        yield* Ref.update(f.snapshots, (all) =>
          all.map((entry) =>
            entry.instanceId === sourceId
              ? {
                  ...entry,
                  skills: [
                    {
                      ...f.base.skills[0]!,
                      path: f.path.join(request.expectedDestinationPath, "SKILL.md"),
                      linkTarget: f.source,
                    },
                  ],
                }
              : entry,
          ),
        );
        assert.equal((yield* f.handlers["j5.skills.links.create"](request)).action, "unchanged");
        assert.equal((yield* f.handlers["j5.skills.links.list"]()).length, 1);
      }),
    ),
  );
  it.effect(
    "reports a destination shared by Codex and Claude and rejects unsupported destination providers",
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture;
          const homeVar = (yield* HostProcess.Platform) === "win32" ? "USERPROFILE" : "HOME";
          yield* f.settings.updateSettings({
            providerInstances: {
              [sourceId]: {
                driver: ProviderDriverKind.make("codex"),
                environment: [{ name: homeVar, value: f.root, sensitive: false }],
              },
              [targetId]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                config: { homePath: f.path.join(f.root, ".agents") },
              },
              [ProviderInstanceId.make("other")]: { driver: ProviderDriverKind.make("cursor") },
            },
          });
          const checked = yield* f.handlers["j5.skills.links.preview"](f.request);
          assert.deepEqual(
            checked.sharedWith.map((entry) => entry.instanceId).sort(),
            [sourceId, targetId].sort(),
          );
          const error = yield* Effect.flip(
            f.handlers["j5.skills.links.preview"]({
              ...f.request,
              targetInstanceId: ProviderInstanceId.make("other"),
            }),
          );
          assert.match(error.message, /only for Codex and Claude/);
        }),
      ),
  );
  it.effect(
    "recognizes Codex canonical paths and provider refresh errors without conflating detection with enablement",
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture;
          assert.equal(
            skillLinkDiscovery(f.base, "/destination/example", undefined, f.path.dirname(f.source)),
            "detected",
          );
          const disabledSkill = { ...f.base, skills: [{ ...f.base.skills[0]!, enabled: false }] };
          assert.equal(
            skillLinkDiscovery(
              disabledSkill,
              "/destination/example",
              undefined,
              f.path.dirname(f.source),
            ),
            "detected",
          );
          assert.equal(
            skillLinkDiscovery(
              { ...f.base, status: "error" },
              "/destination/example",
              undefined,
              f.path.dirname(f.source),
            ),
            "failed",
          );
          assert.equal(
            skillLinkDiscovery(f.base, "/destination/example", f.cwd, f.path.dirname(f.source)),
            "not-checked",
          );
        }),
      ),
  );
  it.effect("resolves instance config, shared destinations, and server-owned project roots", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        const user = yield* f.handlers["j5.skills.links.preview"](f.request);
        assert.equal(user.destinationPath, f.path.join(f.claudeHome, "skills", "example"));
        assert.deepEqual(
          user.sharedWith.map((entry) => entry.instanceId).sort(),
          [targetId, "claude-shared"].sort(),
        );
        const project = yield* f.handlers["j5.skills.links.preview"]({
          ...f.request,
          scope: "project",
        });
        assert.equal(project.destinationPath, f.path.join(f.cwd, ".claude", "skills", "example"));
        const invalid = yield* Effect.flip(
          f.handlers["j5.skills.links.preview"]({
            ...f.request,
            projectId: ProjectId.make("unknown"),
          }),
        );
        assert.match(invalid.message, /no longer exists/);
      }),
    ),
  );
  it.effect(
    "serializes repeated creates, refreshes native discovery, and preserves source on unlink",
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture;
          const create = yield* f.prepare({ ...f.request, scope: "project" });
          const results = yield* Effect.all(
            [
              f.handlers["j5.skills.links.create"](create),
              f.handlers["j5.skills.links.create"](create),
            ],
            { concurrency: 2 },
          );
          assert.deepEqual(results.map((entry) => entry.action).sort(), ["created", "unchanged"]);
          assert.isTrue(results.every((entry) => entry.discovery === "detected"));
          const links = yield* f.handlers["j5.skills.links.list"]();
          assert.equal(links.length, 1);
          assert.include(yield* Ref.get(f.refreshes), `${targetId}:${f.cwd}`);
          const removed = yield* f.handlers["j5.skills.links.remove"]({ id: links[0]!.id });
          assert.equal(removed.discovery, "not-detected");
          assert.isTrue(yield* f.fs.exists(f.source));
          assert.deepEqual(yield* f.handlers["j5.skills.links.list"](), []);
        }),
      ),
  );
  it.effect.each(["create", "remove", "unlink"] as const)(
    "allows another mutation while %s waits for discovery",
    (operation) =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture;
          const create = yield* f.prepare();
          if (operation !== "create") yield* f.handlers["j5.skills.links.create"](create);
          const existing = yield* f.handlers["j5.skills.links.list"]();
          const inspected =
            operation === "unlink"
              ? yield* f.handlers["j5.skills.links.inspect"]({ source: f.request.source })
              : [];
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          yield* Ref.set(
            f.beforeRefresh,
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
          );
          const pending = yield* (
            operation === "create"
              ? f.handlers["j5.skills.links.create"](create)
              : operation === "remove"
                ? f.handlers["j5.skills.links.remove"]({ id: existing[0]!.id })
                : f.handlers["j5.skills.links.unlink"]({
                    links: inspected.map((link) => link.request),
                  })
          ).pipe(Effect.forkChild);
          yield* Effect.gen(function* () {
            yield* Deferred.await(started);
            // Fail immediately if discovery still owns the permit, without a timing assertion.
            const available = yield* skillCatalogPermit.withPermitsIfAvailable(1)(Effect.void);
            assert.equal(available._tag, "Some");
            yield* Ref.set(f.beforeRefresh, Effect.void);
            if (operation === "create") {
              const links = yield* f.handlers["j5.skills.links.list"]();
              assert.equal(links.length, 1);
              const removed = yield* f.handlers["j5.skills.links.remove"]({ id: links[0]!.id });
              assert.equal(removed.action, "removed");
              assert.deepEqual(yield* f.handlers["j5.skills.links.list"](), []);
            } else {
              assert.deepEqual(yield* f.handlers["j5.skills.links.list"](), []);
              const created = yield* f.handlers["j5.skills.links.create"](create);
              assert.equal(created.action, "created");
              assert.equal((yield* f.handlers["j5.skills.links.list"]()).length, 1);
            }
          }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
          yield* Fiber.join(pending);
          assert.isTrue(yield* f.fs.exists(f.source));
        }),
      ),
  );
  it.effect("keeps successful creation and removal distinct from failed or absent discovery", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* Ref.set(f.failRefresh, true);
        const created = yield* f.handlers["j5.skills.links.create"](yield* f.prepare());
        assert.equal(created.action, "created");
        assert.equal(created.discovery, "failed");
        const links = yield* f.handlers["j5.skills.links.list"]();
        assert.equal(links[0]!.status, "linked");
        const removed = yield* f.handlers["j5.skills.links.remove"]({ id: links[0]!.id });
        assert.equal(removed.action, "removed");
        assert.equal(removed.discovery, "failed");
        yield* Ref.set(f.failRefresh, false);
        yield* Ref.set(f.hideSkill, true);
        assert.equal(
          (yield* f.handlers["j5.skills.links.create"](yield* f.prepare())).discovery,
          "not-detected",
        );
      }),
    ),
  );
  it.effect("rejects stale previews when destination settings change", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        const request = yield* f.prepare();
        yield* f.settings.updateSettings({
          providerInstances: {
            [targetId]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { homePath: f.path.join(f.root, "other-home") },
            },
          },
        });
        const error = yield* Effect.flip(f.handlers["j5.skills.links.create"](request));
        assert.match(error.message, /Source or destination changed/);
        assert.deepEqual(yield* f.handlers["j5.skills.links.list"](), []);
      }),
    ),
  );
  it.effect("rejects forged source records and plugin, built-in, and unclassified sources", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        const forged = yield* Effect.flip(
          f.handlers["j5.skills.links.preview"]({
            ...f.request,
            source: { ...f.request.source, path: f.path.join(f.root, "secret") },
          }),
        );
        assert.match(forged.message, /no longer in provider discovery/);
        for (const scope of ["plugin", "system", "unknown"]) {
          yield* Ref.update(f.snapshots, (all) =>
            all.map((entry) =>
              entry.instanceId === sourceId
                ? { ...entry, skills: [{ ...f.base.skills[0]!, scope }] }
                : entry,
            ),
          );
          const error = yield* Effect.flip(f.handlers["j5.skills.links.preview"](f.request));
          assert.match(error.message, /plugin|cannot be linked|unclassified/);
        }
      }),
    ),
  );
  it.effect(
    "honors Codex user HOME, Claude explicit and environment config directories, and project roots",
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture;
          const homeVar = (yield* HostProcess.Platform) === "win32" ? "USERPROFILE" : "HOME";
          const codex = yield* resolveSkillRoot(
            {
              driver: ProviderDriverKind.make("codex"),
              config: {
                homePath: f.path.join(f.root, "codex-work"),
                shadowHomePath: f.path.join(f.root, "shadow"),
              },
              environment: [{ name: homeVar, value: f.root, sensitive: false }],
            },
            "user",
            f.cwd,
          );
          assert.equal(codex, f.path.join(f.root, ".agents", "skills"));
          const claude = {
            driver: ProviderDriverKind.make("claudeAgent"),
            environment: [{ name: "CLAUDE_CONFIG_DIR", value: "relative-home", sensitive: false }],
          };
          assert.equal(
            yield* resolveSkillRoot(claude, "user", f.cwd),
            f.path.join(f.cwd, "relative-home", "skills"),
          );
          assert.equal(
            yield* resolveSkillRoot(
              { ...claude, config: { homePath: f.claudeHome } },
              "user",
              f.cwd,
            ),
            f.path.join(f.claudeHome, "skills"),
          );
          assert.equal(
            yield* resolveSkillRoot(
              { ...claude, environment: [{ name: homeVar, value: f.root, sensitive: false }] },
              "user",
              f.cwd,
            ),
            f.path.join(f.root, ".claude", "skills"),
          );
        }),
      ),
  );
});
