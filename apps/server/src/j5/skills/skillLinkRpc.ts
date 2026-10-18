import * as NodeOS from "node:os";
import {
  AuthOrchestrationOperateScope,
  CodexSettings,
  J5_SKILL_LINK_WS_METHODS as METHODS,
  SkillLinkError,
  type ProjectId,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerProvider,
  type SkillDelete,
  type SkillLinkCreate,
  type SkillLinkMutationResult,
  type SkillLinkRequest,
  type SkillLinkInspect,
  type SkillLinkUnlinkBatch,
  type ExistingSkillLink,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { resolveCodexHomeLayout } from "../../provider/Drivers/CodexHomeLayout.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { ServerConfig } from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { deriveProviderInstanceConfigMap } from "../../provider/ProviderInstanceRegistryHydration.ts";
import {
  normalizePath,
  skillDiscoveryState,
  skillOrigin,
  skillLinkUnavailableReason,
} from "@t3tools/shared/j5/skillInventory";
import { affectedSkillProviderIds, resolveSkillRoot } from "./skillRoots.ts";
import { refreshSkillProviders } from "./skillProviderRefresh.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { skillCatalogPermit } from "./skillCatalogTool.ts";
import {
  previewSkillDeletion,
  deleteSkillDirectory,
  canonicalSkillRoot,
  canonicalSkillFolder,
  inspectSkillLinks,
  createManagedSkillLink,
  listManagedSkillLinks,
  previewSkillLink,
  removeManagedSkillLink,
  unlinkSkill,
} from "./skillLinks.ts";

export const SKILL_LINK_RPC_SCOPES = {
  [METHODS.preview]: AuthOrchestrationOperateScope,
  [METHODS.create]: AuthOrchestrationOperateScope,
  [METHODS.list]: AuthOrchestrationOperateScope,
  [METHODS.remove]: AuthOrchestrationOperateScope,
  [METHODS.unlink]: AuthOrchestrationOperateScope,
  [METHODS.inspect]: AuthOrchestrationOperateScope,
  [METHODS.deletePreview]: AuthOrchestrationOperateScope,
  [METHODS.delete]: AuthOrchestrationOperateScope,
} as const;
const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);
const failure = (cause: unknown) =>
  new SkillLinkError({ message: cause instanceof Error ? cause.message : String(cause) });
const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: failure });

export function skillLinkDiscovery(
  provider: ServerProvider | undefined,
  destinationPath: string,
  cwd?: string,
  sourcePath?: string,
): SkillLinkMutationResult["discovery"] {
  const state = skillDiscoveryState(provider, cwd);
  if (state !== "checked" || !provider) return state === "failed" ? "failed" : "not-checked";
  const workspace = cwd
    ? provider.workspaceSnapshots?.find((entry) => normalizePath(entry.cwd) === normalizePath(cwd))
    : undefined;
  const normalize = (value: string) => normalizePath(value).replace(/\/SKILL\.md$/, "");
  return (workspace?.skills ?? provider.skills).some(
    (skill) =>
      normalize(skill.path) === normalize(destinationPath) ||
      (sourcePath !== undefined &&
        [skill.path, skill.linkTarget].some(
          (location) => location !== undefined && normalize(location) === normalize(sourcePath),
        )),
  )
    ? "detected"
    : "not-detected";
}

function discoveryMessage(discovery: SkillLinkMutationResult["discovery"]) {
  switch (discovery) {
    case "detected":
      return "Detected by provider; this does not verify compatibility.";
    case "failed":
      return "Discovery refresh failed; the link remains created. Retry Refresh.";
    case "not-checked":
      return "Provider discovery has not checked this destination.";
    case "not-detected":
      return "Not detected by provider. Refresh or restart the provider session.";
  }
}

export const makeSkillLinkRpcHandlers = Effect.fn("j5.makeSkillLinkRpcHandlers")(function* (deps: {
  readonly getProjectRoot: (
    projectId: ProjectId,
  ) => Effect.Effect<string | undefined, SkillLinkError>;
}) {
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettingsService;
  const providers = yield* ProviderRegistry;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const processRunner = yield* ProcessRunner.ProcessRunner.pipe(
    Effect.provide(ProcessRunner.layer),
  );
  const rootFor = (
    instance: ProviderInstanceConfig,
    scope: SkillLinkRequest["scope"],
    cwd?: string,
  ) =>
    resolveSkillRoot(instance, scope, cwd).pipe(
      Effect.mapError(failure),
      Effect.provideService(Path.Path, path),
    );
  const projectRoot = Effect.fn("j5.skills.linkProjectRoot")(function* (id?: ProjectId) {
    if (!id) return undefined;
    const cwd = yield* deps.getProjectRoot(id);
    if (!cwd) return yield* failure("The selected project no longer exists in this environment.");
    return cwd;
  });
  const preview = Effect.fn("j5.skills.previewLink")(function* (
    request: SkillLinkRequest,
    expectedSourcePath?: string,
  ) {
    const settings = yield* settingsService.getSettings.pipe(Effect.mapError(failure));
    const instances = deriveProviderInstanceConfigMap(settings);
    const snapshots = yield* providers.getProviders;
    const cwd = yield* projectRoot(request.projectId);
    const sourceProvider = snapshots.find(
      (entry) => entry.instanceId === request.source.instanceId,
    );
    const sourceSkills =
      (cwd
        ? sourceProvider?.workspaceSnapshots?.find((entry) => entry.cwd === cwd)?.skills
        : undefined) ?? sourceProvider?.skills;
    // Discovery may deduplicate the original location after adding a shared link.
    // Retries can use another current record for the same canonical source.
    const source = sourceSkills?.find(
      (skill) =>
        skill.name === request.source.name &&
        (skill.path === request.source.path ||
          (expectedSourcePath !== undefined &&
            skill.linkTarget === path.join(expectedSourcePath, "SKILL.md"))),
    );
    if (!source)
      return yield* failure(
        "The source skill is no longer in provider discovery. Refresh the inventory and try again.",
      );
    const reason = skillLinkUnavailableReason(
      skillOrigin(source, cwd, settings.skillCatalogSource),
    );
    if (reason) return yield* failure(reason);
    const target = instances[request.targetInstanceId];
    if (!target) return yield* failure("The destination provider instance no longer exists.");
    const root = yield* rootFor(target, request.scope, cwd);
    const result = yield* attempt(() =>
      previewSkillLink(
        source.path,
        root,
        target.driver,
        request.scope === "project" ? cwd : undefined,
      ),
    );
    const resolvedReason = skillLinkUnavailableReason(
      skillOrigin(
        { ...source, linkTarget: path.join(result.sourcePath, "SKILL.md") },
        cwd,
        settings.skillCatalogSource,
      ),
    );
    if (resolvedReason) return yield* failure(resolvedReason);
    const sharedWith = yield* Effect.forEach(
      Object.entries(instances),
      ([id, instance]) =>
        rootFor(instance, request.scope, cwd).pipe(
          Effect.flatMap((candidate) => attempt(() => canonicalSkillRoot(candidate))),
          Effect.map((candidate) =>
            candidate === path.dirname(result.destinationPath)
              ? [{ instanceId: id as ProviderInstanceId, label: instance.displayName ?? id }]
              : [],
          ),
          Effect.orElseSucceed(() => []),
        ),
      { concurrency: 4 },
    );
    const affected = yield* affectedSkillProviderIds(
      snapshots,
      instances,
      [path.dirname(result.destinationPath)],
      { scope: request.scope, cwd },
    ).pipe(Effect.mapError(failure), Effect.provideService(Path.Path, path));
    const sharing = new Map(sharedWith.flat().map((entry) => [entry.instanceId, entry]));
    for (const id of affected)
      sharing.set(id, { instanceId: id, label: instances[id]?.displayName ?? id });
    let gitWarning: string | undefined;
    if (request.scope === "project" && cwd) {
      const checked = yield* processRunner
        .run({
          command: "git",
          args: ["check-ignore", "--quiet", "--", result.destinationPath],
          cwd,
          timeout: "5 seconds",
        })
        .pipe(Effect.option);
      gitWarning =
        checked._tag === "Some" && checked.value.code === 0
          ? undefined
          : "This project link is not confirmed ignored by Git. Committing it can expose an absolute path on this machine and will not share the skill files. Add the destination to .git/info/exclude before committing.";
    }
    return {
      ...result,
      sharedWith: [...sharing.values()],
      warnings: [
        ...result.warnings,
        ...(gitWarning ? [gitWarning] : []),
        ...(target.driver === "codex" && request.scope === "user"
          ? [
              "Codex uses the user's .agents/skills directory, including instances with custom CODEX_HOME or shadow homes.",
            ]
          : []),
        "Edits to the source, scripts, references, and assets are shared. Running sessions may need refreshing or restarting. Discovery does not prove the skill works correctly.",
      ],
    };
  });
  const refresh = Effect.fn("j5.skills.refreshLinkedSkill")(function* (
    targetId: ProviderInstanceId,
    destination: string,
    scope: SkillLinkRequest["scope"],
    projectId?: ProjectId,
    sourcePath?: string,
    affectedInstanceIds?: ReadonlySet<ProviderInstanceId>,
  ): Effect.fn.Return<SkillLinkMutationResult["discovery"]> {
    return yield* Effect.gen(function* () {
      const snapshots = yield* providers.getProviders;
      const settings = yield* settingsService.getSettings;
      const cwd = yield* projectRoot(projectId);
      const affected = yield* affectedSkillProviderIds(
        snapshots,
        deriveProviderInstanceConfigMap(settings),
        [path.dirname(destination)],
        { scope, cwd },
      ).pipe(Effect.provideService(Path.Path, path));
      const updated = yield* refreshSkillProviders(
        providers,
        [...new Set([targetId, ...affected, ...(affectedInstanceIds ?? [])])],
        cwd ? [cwd] : [],
      );
      return skillLinkDiscovery(
        updated.find((entry) => entry.instanceId === targetId),
        destination,
        cwd,
        sourcePath,
      );
    }).pipe(Effect.catchCause(() => Effect.succeed("failed" as const)));
  });
  const linkRoots = Effect.fn("j5.skills.linkRoots")(function* (projectId?: ProjectId) {
    const settings = yield* settingsService.getSettings.pipe(Effect.mapError(failure));
    const instances = deriveProviderInstanceConfigMap(settings);
    const snapshots = yield* providers.getProviders;
    const cwd = yield* projectRoot(projectId);
    const roots: Array<{
      root: string;
      instanceId: ProviderInstanceId;
      label: string;
      scope: "user" | "project";
    }> = [];
    for (const provider of snapshots) {
      const instance = instances[provider.instanceId];
      if (!instance || (instance.driver !== "codex" && instance.driver !== "claudeAgent")) continue;
      const candidates: Array<{ root: string; scope: "user" | "project" }> = [
        { root: yield* rootFor(instance, "user", cwd), scope: "user" },
      ];
      if (cwd)
        candidates.push({ root: yield* rootFor(instance, "project", cwd), scope: "project" });
      if (instance.driver === "codex") {
        const config = yield* decodeCodexSettings(instance.config ?? {}).pipe(
          Effect.mapError(failure),
        );
        const layout = yield* resolveCodexHomeLayout(config).pipe(
          Effect.provideService(Path.Path, path),
        );
        const env = yield* mergeProviderInstanceEnvironment(instance.environment);
        const home = (platform === "win32" ? env.USERPROFILE : env.HOME) || NodeOS.homedir();
        candidates.push({
          root: path.resolve(
            cwd ?? process.cwd(),
            layout.effectiveHomePath || env.CODEX_HOME || path.join(home, ".codex"),
            "skills",
          ),
          scope: "user",
        });
      }
      const skills =
        (cwd
          ? provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd)?.skills
          : undefined) ?? provider.skills;
      for (const skill of skills) {
        const origin = skillOrigin(skill, cwd, settings.skillCatalogSource);
        if (skillLinkUnavailableReason(origin)) continue;
        const folder =
          path.basename(skill.path) === "SKILL.md" ? path.dirname(skill.path) : skill.path;
        // Native discovery also covers ancestor projects and non-default skill roots.
        if (path.basename(path.dirname(folder)) === "skills")
          candidates.push({
            root: path.dirname(folder),
            scope: origin === "Project" ? "project" : "user",
          });
      }
      for (const candidate of candidates) {
        if (
          roots.some(
            (entry) => entry.root === candidate.root && entry.instanceId === provider.instanceId,
          )
        )
          continue;
        roots.push({
          ...candidate,
          instanceId: provider.instanceId,
          label: `${provider.displayName ?? provider.instanceId} · ${candidate.scope === "user" ? "User" : "Project"}`,
        });
      }
    }
    const canonical = new Map(
      (yield* Effect.forEach(
        [...new Set(roots.map((entry) => entry.root))],
        (root) =>
          attempt(async () => [[root, await canonicalSkillRoot(root)] as const]).pipe(
            Effect.orElseSucceed(() => []),
          ),
        { concurrency: 4 },
      )).flat(),
    );
    return roots.flatMap((entry) => {
      const root = canonical.get(entry.root);
      return root === undefined ? [] : [{ ...entry, root }];
    });
  });
  const sourceFor = Effect.fn("j5.skills.linkSource")(function* (request: SkillLinkInspect) {
    const snapshots = yield* providers.getProviders;
    const settings = yield* settingsService.getSettings.pipe(Effect.mapError(failure));
    const cwd = yield* projectRoot(request.projectId);
    const provider = snapshots.find((entry) => entry.instanceId === request.source.instanceId);
    const skills =
      (cwd
        ? provider?.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd)?.skills
        : undefined) ?? provider?.skills;
    const source = skills?.find(
      (skill) => skill.path === request.source.path && skill.name === request.source.name,
    );
    if (!source)
      return yield* failure(
        "The source skill is no longer in provider discovery. Refresh and try again.",
      );
    const reportedOrigin = skillOrigin(source, cwd, settings.skillCatalogSource);
    const reportedReason = skillLinkUnavailableReason(reportedOrigin);
    if (reportedReason) return yield* failure(reportedReason);
    const sourcePath = yield* attempt(() => canonicalSkillFolder(source.path));
    const origin = skillOrigin(
      { ...source, linkTarget: path.join(sourcePath, "SKILL.md") },
      cwd,
      settings.skillCatalogSource,
    );
    const reason = skillLinkUnavailableReason(origin);
    if (reason) return yield* failure(reason);
    return { source, sourcePath, origin, reportedOrigin };
  });
  const deletePreview = Effect.fn("j5.skills.previewDeletion")(function* (
    request: SkillLinkInspect,
  ) {
    const { source, origin, reportedOrigin } = yield* sourceFor(request);
    if (![origin, reportedOrigin].every((value) => value === "Personal" || value === "Project"))
      return yield* failure("Only original personal or project skills can be deleted here.");
    const checked = yield* attempt(() => previewSkillDeletion(source.path));
    const roots = yield* linkRoots(request.projectId);
    if (
      !roots.some(
        (entry) =>
          entry.instanceId === request.source.instanceId &&
          entry.root === path.dirname(checked.expectedPath),
      )
    )
      return yield* failure("The skill is outside this provider's skill directories.");
    const affectedInstanceIds = new Set(
      roots
        .filter((entry) => entry.root === path.dirname(checked.expectedPath))
        .map((entry) => entry.instanceId),
    );
    const snapshots = yield* providers.getProviders;
    for (const provider of snapshots) {
      const skills = [
        ...provider.skills,
        ...(provider.workspaceSnapshots ?? []).flatMap((snapshot) => snapshot.skills),
      ];
      if (
        skills.some((skill) =>
          [skill.path, skill.linkTarget].some(
            (location) =>
              location === source.path ||
              location === checked.expectedPath ||
              location === path.join(checked.expectedPath, "SKILL.md"),
          ),
        )
      )
        affectedInstanceIds.add(provider.instanceId);
    }
    return {
      checked,
      affectedInstanceIds,
      scope: origin === "Project" ? ("project" as const) : ("user" as const),
    };
  });
  const inspect = Effect.fn("j5.skills.inspectLinks")(function* (request: SkillLinkInspect) {
    const { sourcePath } = yield* sourceFor(request);
    const roots = yield* linkRoots(request.projectId);
    const result = yield* Effect.forEach(
      [...new Set(roots.map((entry) => entry.root))],
      (root) =>
        Effect.gen(function* () {
          const shared = roots.filter((entry) => entry.root === root);
          const target = shared[0]!;
          const links = yield* attempt(() => inspectSkillLinks(root, sourcePath));
          return links.map((link): ExistingSkillLink => ({
            label: [...new Set(shared.map((entry) => entry.label))].join(", "),
            request: {
              ...link,
              targetInstanceId: target.instanceId,
              scope: target.scope,
              ...(request.projectId ? { projectId: request.projectId } : {}),
            },
          }));
        }),
      { concurrency: 4 },
    );
    return result.flat();
  });
  // Share the catalog permit so a catalog apply cannot race a managed link operation.
  const mutation = <A>(effect: Effect.Effect<A, SkillLinkError>) =>
    skillCatalogPermit.withPermit(effect.pipe(Effect.uninterruptible));
  return {
    [METHODS.preview]: (request: SkillLinkRequest) => preview(request),
    [METHODS.list]: () => attempt(() => listManagedSkillLinks(config.stateDir)),
    [METHODS.create]: (request: SkillLinkCreate) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const { checked, action } = yield* mutation(
            Effect.gen(function* () {
              const checked = yield* preview(request, request.expectedSourcePath);
              if (
                checked.sourcePath !== request.expectedSourcePath ||
                checked.destinationPath !== request.expectedDestinationPath
              )
                return yield* failure("Source or destination changed. Preview the link again.");
              const action = yield* attempt(() =>
                createManagedSkillLink(config.stateDir, checked, request, platform === "win32"),
              );
              return { checked, action };
            }),
          );
          const discovery = yield* refresh(
            request.targetInstanceId,
            checked.destinationPath,
            request.scope,
            request.projectId,
            checked.sourcePath,
          );
          return {
            action,
            discovery,
            message: `${action === "created" ? "Link created" : "Link already exists"}. ${discoveryMessage(discovery)}`,
          };
        }),
      ),
    [METHODS.remove]: ({
      id,
      forget = false,
    }: {
      readonly id: string;
      readonly forget?: boolean | undefined;
    }) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const removed = yield* mutation(
            attempt(() =>
              removeManagedSkillLink(config.stateDir, id, platform === "win32", forget),
            ),
          );
          if (forget)
            return {
              action: "forgotten" as const,
              discovery: "not-checked" as const,
              message: "Record forgotten. The destination and source were left unchanged.",
            };
          const discovery = removed
            ? yield* refresh(
                removed.targetInstanceId,
                removed.destinationPath,
                removed.scope,
                removed.projectId,
                removed.sourcePath,
              )
            : ("not-checked" as const);
          return {
            action: "removed" as const,
            discovery,
            message: `Link removed. The source is unchanged.${discovery === "failed" ? " Discovery refresh failed; retry Refresh." : " Running sessions may need refreshing or restarting."}`,
          };
        }),
      ),
    [METHODS.inspect]: (request: SkillLinkInspect) => inspect(request),
    [METHODS.deletePreview]: (request: SkillLinkInspect) =>
      deletePreview(request).pipe(Effect.map(({ checked }) => checked)),
    [METHODS.delete]: (request: SkillDelete) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const { affectedInstanceIds, scope } = yield* mutation(
            Effect.gen(function* () {
              const { checked, affectedInstanceIds, scope } = yield* deletePreview(request);
              if (
                checked.expectedPath !== request.expectedPath ||
                checked.expectedIdentity !== request.expectedIdentity
              )
                return yield* failure("The skill folder changed. Review the deletion again.");
              yield* attempt(() => deleteSkillDirectory(checked));
              return { affectedInstanceIds, scope };
            }),
          );
          const discovery = yield* refresh(
            request.source.instanceId,
            request.expectedPath,
            scope,
            request.projectId,
            undefined,
            affectedInstanceIds,
          );
          return {
            action: "removed" as const,
            discovery,
            message: `Skill permanently deleted.${discovery === "failed" ? " Discovery refresh failed; retry Refresh." : " Running sessions may need refreshing or restarting."}`,
          };
        }),
      ),
    [METHODS.unlink]: (request: SkillLinkUnlinkBatch) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const { removedPaths, failed, refreshIds, workspaces } = yield* mutation(
            Effect.gen(function* () {
              const settings = yield* settingsService.getSettings.pipe(Effect.mapError(failure));
              const snapshots = yield* providers.getProviders;
              const rootsByProject = new Map(
                yield* Effect.forEach(
                  [...new Set(request.links.map((link) => link.projectId))],
                  (id) =>
                    Effect.gen(function* () {
                      return [id, yield* linkRoots(id)] as const;
                    }),
                ),
              );
              const removedPaths: string[] = [];
              const failed: Array<{ path: string; message: string }> = [];
              const refreshIds = new Set<ProviderInstanceId>();
              const workspaces = new Set<string>();
              for (const link of new Map(
                request.links.map((link) => [link.expectedDestinationPath, link]),
              ).values()) {
                const roots = rootsByProject.get(link.projectId)!;
                const outcome = yield* Effect.gen(function* () {
                  if (
                    !roots.some(
                      (entry) =>
                        entry.instanceId === link.targetInstanceId &&
                        entry.scope === link.scope &&
                        entry.root === path.dirname(link.expectedDestinationPath),
                    )
                  )
                    return yield* failure("Destination changed. Preview again.");
                  const cwd = yield* projectRoot(link.projectId);
                  const reason = skillLinkUnavailableReason(
                    skillOrigin(
                      {
                        name: path.basename(link.expectedDestinationPath),
                        path: path.join(link.expectedDestinationPath, "SKILL.md"),
                        linkTarget: path.join(link.expectedSourcePath, "SKILL.md"),
                        scope: link.scope,
                        enabled: true,
                      },
                      cwd,
                      settings.skillCatalogSource,
                    ),
                  );
                  if (reason) return yield* failure(reason);
                  const affected = yield* affectedSkillProviderIds(
                    snapshots,
                    deriveProviderInstanceConfigMap(settings),
                    [path.dirname(link.expectedDestinationPath)],
                    { scope: link.scope, cwd },
                  ).pipe(Effect.mapError(failure), Effect.provideService(Path.Path, path));
                  yield* attempt(() => unlinkSkill(config.stateDir, link, platform === "win32"));
                  for (const id of affected) refreshIds.add(id);
                  if (cwd) workspaces.add(cwd);
                  return undefined;
                }).pipe(Effect.catch((error) => Effect.succeed(error)));
                if (outcome) {
                  failed.push({ path: link.expectedDestinationPath, message: outcome.message });
                  continue;
                }
                removedPaths.push(link.expectedDestinationPath);
                for (const entry of roots)
                  if (entry.root === path.dirname(link.expectedDestinationPath))
                    refreshIds.add(entry.instanceId);
                for (const provider of snapshots) {
                  const skills = [
                    ...provider.skills,
                    ...(provider.workspaceSnapshots ?? []).flatMap((snapshot) => snapshot.skills),
                  ];
                  if (
                    skills.some(
                      (skill) =>
                        skill.linkTarget === path.join(link.expectedSourcePath, "SKILL.md"),
                    )
                  )
                    refreshIds.add(provider.instanceId);
                }
              }
              return { removedPaths, failed, refreshIds, workspaces };
            }),
          );
          // One refresh per affected instance after the whole batch, including shared roots.
          const refreshFailed = yield* refreshSkillProviders(
            providers,
            [...refreshIds],
            [...workspaces],
          ).pipe(
            Effect.map((updated) =>
              updated.some(
                (provider) =>
                  refreshIds.has(provider.instanceId) &&
                  (skillDiscoveryState(provider) === "failed" ||
                    provider.workspaceSnapshots?.some((snapshot) => snapshot.refreshError)),
              ),
            ),
            Effect.catchCause(() => Effect.succeed(true)),
          );
          return { removedPaths, failed, refreshFailed };
        }),
      ),
  };
});
