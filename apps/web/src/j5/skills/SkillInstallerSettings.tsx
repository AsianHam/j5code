import { SKILLS_FOR_OWNERS, useIsOwnerSomewhere, useOwnedEnvironmentIds } from "../sharing/access";
import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type SkillCatalogApplyResult,
  type SkillCatalogReplacement,
} from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { SkillInventoryPanel } from "./SkillManagementSettings";
import { skillCatalogEnvironment } from "./skillCatalogAtoms";
import {
  catalogScopeFor,
  extractPartialApplyResult,
  isCatalogActionable,
  isSourceChangedError,
  isSourceSaveable,
  pruneSelectedGroups,
  summarizeApplyResult,
} from "./skillCatalogView";

import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  SettingsUnavailableGroup,
} from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
import { toastManager } from "../../components/ui/toast";
import { Checkbox } from "../../components/ui/checkbox";
import { Input } from "../../components/ui/input";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useSettingsScopeEnvironments } from "../settingsScopeEnvironment";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { openCommandPalette } from "../../commandPaletteBus";

const messageOf = (cause: unknown) =>
  cause instanceof Error && cause.message.trim().length > 0 ? cause.message : String(cause);

interface ApplyFailure {
  readonly message: string;
  readonly partial: SkillCatalogApplyResult | null;
}

function upstreamOf(
  status: { readonly git: { readonly upstream: string | null } } | null,
): string | null {
  return status?.git.upstream ?? null;
}

/** Installing skills is for a server's Owners (People and access AC20). */
export function SkillInstallerSettings() {
  return !useIsOwnerSomewhere() ? (
    <SettingsPageContainer>
      <SettingsSection title="Skills">
        <SettingsUnavailableGroup message={SKILLS_FOR_OWNERS}>{null}</SettingsUnavailableGroup>
      </SettingsSection>
    </SettingsPageContainer>
  ) : (
    <MemberSkillInstallerSettings />
  );
}

function MemberSkillInstallerSettings() {
  const ownedEnvironmentIds = useOwnedEnvironmentIds();
  const { environments: everyEnvironment } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // A server this person does not own is left out: its skills are not theirs to manage.
  const environments = everyEnvironment.filter((environment) =>
    ownedEnvironmentIds.has(environment.environmentId),
  );
  const orderedEnvironments = environments.toSorted((left, right) => {
    const leftPrimary = left.environmentId === primaryEnvironmentId;
    const rightPrimary = right.environmentId === primaryEnvironmentId;
    return Number(rightPrimary) - Number(leftPrimary) || left.label.localeCompare(right.label);
  });
  const {
    candidates: pickerEnvironments,
    pinnedEnvironmentId,
    initialEnvironmentId,
  } = useSettingsScopeEnvironments(orderedEnvironments, primaryEnvironmentId);
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    initialEnvironmentId,
  );
  const effectiveEnvironmentId =
    pinnedEnvironmentId ??
    (pickerEnvironments.some((environment) => environment.environmentId === selectedEnvironmentId)
      ? selectedEnvironmentId
      : (pickerEnvironments[0]?.environmentId ?? null));
  const selectedEnvironment = orderedEnvironments.find(
    (environment) => environment.environmentId === effectiveEnvironmentId,
  );

  return (
    <SettingsPageContainer>
      {pinnedEnvironmentId === null && pickerEnvironments.length > 1 ? (
        <SettingsSection title="Environment">
          <SettingsRow
            title="Environment"
            description="Skills are installed on the selected environment's machine."
            control={
              <Select
                value={effectiveEnvironmentId ?? undefined}
                onValueChange={(value) => {
                  const environment = pickerEnvironments.find(
                    (candidate) => candidate.environmentId === value,
                  );
                  if (environment) setSelectedEnvironmentId(environment.environmentId);
                }}
              >
                <SelectTrigger className="w-full sm:w-56" aria-label="Skills environment">
                  <SelectValue>{selectedEnvironment?.label}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {pickerEnvironments.map((environment) => (
                    <SelectItem key={environment.environmentId} value={environment.environmentId}>
                      {environment.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        </SettingsSection>
      ) : null}
      {effectiveEnvironmentId === null ? (
        <SettingsSection title="Catalog">
          <SettingsRow
            title="No connected environments"
            description="Connect an environment to manage its skill catalog."
          />
        </SettingsSection>
      ) : (
        <div key={effectiveEnvironmentId} className="grid min-w-0 gap-6">
          <SettingsSection
            id="installed-skills"
            title="Installed"
            variant="plain"
            headerAction={
              // Scroll instead of linking to #skill-catalog: Electron's hash router
              // would read the fragment as a route and leave Settings.
              <Button
                variant="ghost"
                size="xs"
                onClick={() =>
                  document.getElementById("skill-catalog")?.scrollIntoView({ block: "start" })
                }
              >
                Manage catalog
              </Button>
            }
          >
            <SkillInventoryPanel environmentId={effectiveEnvironmentId} />
          </SettingsSection>
          <SkillCatalogPanel environmentId={effectiveEnvironmentId} />
        </div>
      )}
    </SettingsPageContainer>
  );
}

export function SkillCatalogPanel({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { environments } = useEnvironments();
  const configuredSource =
    environments.find((environment) => environment.environmentId === environmentId)?.serverConfig
      ?.settings.skillCatalogSource ?? DEFAULT_SERVER_SETTINGS.skillCatalogSource;

  // The query atom is keyed by environment and source, so its cached status
  // always belongs to the acknowledged settings used by Apply and Update.
  const status = useEnvironmentQuery(
    configuredSource
      ? skillCatalogEnvironment.status({
          environmentId,
          input: { expectedSource: configuredSource },
        })
      : null,
  );

  const [draft, setDraft] = useState<string | null>(null);
  const displayedSource = draft ?? configuredSource;
  if (draft !== null && draft.trim() === configuredSource) setDraft(null);

  const selectionScope = catalogScopeFor(environmentId, configuredSource);
  // Latest identity for in-flight requests: an Apply started on A must not
  // publish its counts into B's panel when another client switches sources
  // mid-operation. Written in an effect, since render may not write refs.
  const selectionScopeRef = useRef(selectionScope);
  // oxlint-disable-next-line t3code/react-effect-budget -- async handlers compare against the latest selection, and render may not write refs.
  useEffect(() => {
    selectionScopeRef.current = selectionScope;
  }, [selectionScope, selectionScopeRef]);
  const [selection, setSelection] = useState<{ scope: string | null; groups: Array<string> }>({
    scope: null,
    groups: [],
  });
  // Prune against the latest known groups so an Update that removes a group
  // cannot leave Apply submitting an unknown one.
  const knownGroups = status.data?.groups ?? [];
  const selectedGroups = pruneSelectedGroups(
    selection.scope === selectionScope ? selection.groups : (status.data?.selectedGroups ?? []),
    knownGroups,
  );

  const [operation, setOperation] = useState<"save" | "update" | "apply" | null>(null);
  const busy = operation !== null;
  const [sourceEditorOpen, setSourceEditorOpen] = useState(false);
  const [reviewingApply, setReviewingApply] = useState(false);
  const canOperate = useAtomValue(
    skillCatalogEnvironment.applyGroups.permissionAtom(environmentId),
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [applyFailure, setApplyFailure] = useState<ApplyFailure | null>(null);
  const [lastApply, setLastApply] = useState<SkillCatalogApplyResult | null>(null);
  const [replacementPaths, setReplacementPaths] = useState<ReadonlyArray<string> | null>(null);

  // Selections and results belong to one catalog identity. When acknowledged
  // settings move (another client saved A → B, or this panel saved), drop
  // the previous catalog's state so Apply cannot submit groups, counts,
  // or errors from the old source.
  const [stateScope, setStateScope] = useState(selectionScope);
  if (stateScope !== selectionScope) {
    setStateScope(selectionScope);
    setSelection({ scope: null, groups: [] });
    setLastApply(null);
    setReplacementPaths(null);
    setApplyFailure(null);
    setNotice(null);
    setSaveError(null);
    setReviewingApply(false);
  }

  // Awaited directly (not via the shared fan-out hook): this key is
  // environment-local, and the save must settle before identity resets.
  const persistSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const applyGroupsCommand = useAtomCommand(skillCatalogEnvironment.applyGroups, {
    reportFailure: false,
  });
  const updateCatalogCommand = useAtomCommand(skillCatalogEnvironment.updateCatalog, {
    reportFailure: false,
  });

  const sourceMismatch = isSourceChangedError(status.failure);

  async function saveSource() {
    if (busy) return;
    const trimmed = displayedSource.trim();
    if (!isSourceSaveable(displayedSource, configuredSource)) return;
    const originScope = selectionScope;
    setOperation("save");
    setNotice(null);
    setSaveError(null);
    setApplyFailure(null);
    const result = await persistSettings({
      environmentId,
      input: { patch: { skillCatalogSource: trimmed } },
    });
    setOperation(null);
    if (selectionScopeRef.current !== originScope) {
      // The settings echo can precede the receipt for our own save.
      if (
        result._tag === "Success" &&
        selectionScopeRef.current === catalogScopeFor(environmentId, trimmed)
      ) {
        setSourceEditorOpen(false);
      }
      return;
    }
    if (result._tag === "Failure") {
      // The draft stays visible against the old settings; actions stay
      // disabled until the displayed source has matching loaded status.
      setSaveError(messageOf(squashAtomCommandFailure(result)));
      return;
    }
    setSourceEditorOpen(false);
    // The status query follows the echoed settings. Actions stay disabled
    // until the new source's status arrives.
    status.refresh();
  }

  async function applySelected(replacements?: ReadonlyArray<SkillCatalogReplacement>) {
    if (!catalogReady) return;
    setReplacementPaths(null);
    const originScope = selectionScope;
    setOperation("apply");
    setReviewingApply(false);
    setNotice(null);
    setApplyFailure(null);
    const result = await applyGroupsCommand({
      environmentId,
      input: {
        expectedSource: configuredSource,
        groups: selectedGroups,
        ...(replacements ? { replacements } : {}),
      },
    });
    setOperation(null);
    // The source moved mid-operation: discard A's counts/conflicts instead
    // of showing them under B.
    if (selectionScopeRef.current !== originScope) return;
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      const partial = extractPartialApplyResult(cause) ?? null;
      setApplyFailure({ message: messageOf(cause), partial });
      setLastApply(partial);
    } else {
      setLastApply(result.value);
      const message = summarizeApplyResult(result.value);
      setNotice(message);
      toastManager.add({ type: "info", title: "Skills", description: message });
    }
    status.refresh();
  }

  async function updateCheckout() {
    if (!catalogReady) return;
    const originScope = selectionScope;
    setOperation("update");
    setNotice(null);
    setApplyFailure(null);
    const result = await updateCatalogCommand({
      environmentId,
      input: { expectedSource: configuredSource },
    });
    setOperation(null);
    if (selectionScopeRef.current !== originScope) return;
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setApplyFailure({ message: messageOf(cause), partial: null });
    } else {
      const message = `Catalog updated from ${result.value.upstream}. Review the skill groups and choose Apply changes to update installed skills.`;
      setNotice(message);
      toastManager.add({ type: "info", title: "Skills", description: message });
    }
    status.refresh();
  }

  // Actions run only when the input shows the configured source and status
  // has loaded for exactly that source. This keeps a failed save from
  // leaving Apply enabled against the previous source, and keeps an
  // external A → B change from submitting A before B's status arrives.
  const catalogReady = isCatalogActionable({
    busy,
    isPending: status.isPending,
    hasData: status.data !== null,
    displayedSource,
    configuredSource,
  });
  const replacementOptions =
    lastApply?.conflicts.flatMap((conflict) =>
      conflict.replacement ? [{ skill: conflict.skill, ...conflict.replacement }] : [],
    ) ?? [];
  const canReplace =
    canOperate &&
    catalogReady &&
    lastApply?.selectedGroups.length === selectedGroups.length &&
    lastApply.selectedGroups.every((group) => selectedGroups.includes(group));
  const applyDisabled = !catalogReady || !canOperate;
  const updateDisabled = !catalogReady || !canOperate || upstreamOf(status.data) === null;

  const toggleGroup = (name: string) => {
    if (!catalogReady) return;
    const current = new Set(selectedGroups);
    if (current.has(name)) current.delete(name);
    else current.add(name);
    setSelection({ scope: selectionScope, groups: [...current] });
  };

  const upstream = upstreamOf(status.data);

  return (
    <>
      <SettingsSection id="skill-catalog" title="Catalog">
        <SettingsRow
          title="Catalog source"
          description={
            <span className="break-all">
              {configuredSource || "Add a catalog to install groups of skills."}
            </span>
          }
          control={
            <>
              {configuredSource ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={updateDisabled}
                  title={
                    upstream === null
                      ? "This catalog has no Git upstream to update from."
                      : `Update from ${upstream}.`
                  }
                  onClick={() => void updateCheckout()}
                >
                  {operation === "update" ? "Updating…" : "Update catalog"}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !canOperate}
                onClick={() => setSourceEditorOpen(true)}
              >
                {configuredSource ? "Change source…" : "Add source…"}
              </Button>
            </>
          }
        >
          {sourceEditorOpen ? (
            <div className="grid gap-3 pt-2 pb-3">
              <p className="text-xs text-muted-foreground">
                Choose a Git URL or an absolute folder on this environment. Skills link to this
                folder, so keep it in place.
              </p>
              <Input
                aria-label="Catalog source"
                autoFocus
                size="sm"
                value={displayedSource}
                disabled={busy}
                placeholder="Git URL or /path/to/catalog"
                autoComplete="off"
                spellCheck={false}
                font="mono"
                onChange={(event) => {
                  setDraft(event.target.value);
                  setNotice(null);
                }}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    openCommandPalette({
                      open: "add-project",
                      sourcePicker: {
                        environmentId,
                        onSelect: (source) => {
                          if (selectionScopeRef.current !== selectionScope) return;
                          setDraft(source);
                          setNotice(null);
                        },
                      },
                    });
                  }}
                >
                  Choose source
                </Button>
                <Button
                  size="xs"
                  disabled={
                    busy || !canOperate || !isSourceSaveable(displayedSource, configuredSource)
                  }
                  onClick={() => void saveSource()}
                >
                  {operation === "save" ? "Saving…" : "Save source"}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setSourceEditorOpen(false);
                    setDraft(null);
                    setSaveError(null);
                  }}
                >
                  Cancel
                </Button>
                {configuredSource ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={
                      busy || displayedSource === DEFAULT_SERVER_SETTINGS.skillCatalogSource
                    }
                    title="Clear the catalog source, then save."
                    onClick={() => {
                      setDraft(DEFAULT_SERVER_SETTINGS.skillCatalogSource);
                      setNotice(null);
                    }}
                  >
                    Clear source
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
          {saveError ? (
            <p role="alert" className="pb-3 text-sm text-destructive-foreground">
              {saveError} The previous source is still active.
            </p>
          ) : null}
          {status.error ? (
            <div className="grid gap-2 pb-3">
              <p role="alert" className="text-sm text-destructive-foreground">
                {status.error}
              </p>
              <div>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => status.refresh()}
                >
                  {sourceMismatch ? "Reload with current source" : "Retry status"}
                </Button>
              </div>
            </div>
          ) : null}
          {configuredSource && status.data === null && !status.error ? (
            <p className="pb-3 text-sm text-muted-foreground">
              {status.isPending ? "Loading catalog status…" : "No catalog status yet."}
            </p>
          ) : null}
          {status.data ? (
            <div className="grid gap-2 pb-3 text-xs text-muted-foreground">
              {status.data.git.dirty ? (
                <p className="text-warning">The catalog has local changes.</p>
              ) : null}
              {status.data.warnings.map((warning) => (
                <p key={warning} className="text-warning">
                  {warning}
                </p>
              ))}
              <details>
                <summary className="w-fit cursor-pointer">Catalog details</summary>
                <div className="space-y-1 pt-2 break-words">
                  <p>Folder: {status.data.catalogDir}</p>
                  <p>
                    Git: {upstream ?? "no upstream"} ·{" "}
                    {status.data.git.dirty ? "local changes" : "no local changes"}
                  </p>
                  {status.data.targets.length > 0 ? (
                    <p>Installs to: {status.data.targets.join(", ")}</p>
                  ) : null}
                </div>
              </details>
            </div>
          ) : null}
        </SettingsRow>
      </SettingsSection>
      {configuredSource ? (
        <SettingsSection
          title="Skill groups"
          headerAction={
            <Button size="xs" disabled={applyDisabled} onClick={() => setReviewingApply(true)}>
              {operation === "apply" ? "Applying…" : "Apply changes"}
            </Button>
          }
        >
          {status.data?.groups.length ? (
            status.data.groups.map((group) => (
              <SettingsRow
                key={`${selectionScope}:${group.name}`}
                title={<span className="font-mono">{group.name}</span>}
                description={group.description}
                status={`${group.skills.length} skills${group.depends.length > 0 ? ` · needs ${group.depends.join(", ")}` : ""}`}
                control={
                  <Checkbox
                    aria-label={`Install ${group.name} group`}
                    checked={selectedGroups.includes(group.name)}
                    disabled={applyDisabled}
                    onCheckedChange={() => toggleGroup(group.name)}
                  />
                }
              >
                <details className="group/skill-group pb-3 text-xs">
                  <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm text-muted-foreground outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                    <ChevronRightIcon
                      aria-hidden
                      className="size-3.5 shrink-0 group-open/skill-group:rotate-90"
                    />
                    View skills
                  </summary>
                  {group.skills.length > 0 ? (
                    <ul className="ml-2 grid gap-3 border-l border-border pt-2 pl-4">
                      {group.skills.map((skill) => (
                        <li key={skill.name} className="min-w-0 break-words">
                          <span className="font-mono">{skill.name}</span>
                          {skill.description ? (
                            <p className="text-muted-foreground">{skill.description}</p>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="pt-2 pl-6 text-muted-foreground">No skills in this group.</p>
                  )}
                </details>
              </SettingsRow>
            ))
          ) : (
            <SettingsRow
              title={status.data ? "No groups" : "No groups available"}
              description={
                status.data
                  ? "This catalog defines no groups."
                  : configuredSource
                    ? "Groups will appear when catalog status loads."
                    : "Choose a catalog source to see its groups."
              }
            />
          )}
          {notice ||
          applyFailure ||
          (lastApply && (lastApply.conflicts.length || lastApply.failed.length)) ? (
            <SettingsRow title="Last action">
              <div className="grid gap-1 pt-2 pb-3 text-sm">
                {notice ? (
                  <p role="status" className="text-muted-foreground">
                    {notice}
                  </p>
                ) : null}
                {applyFailure ? (
                  <p role="alert" className="text-destructive-foreground">
                    {applyFailure.message}
                    {applyFailure.partial ? ` ${summarizeApplyResult(applyFailure.partial)}` : null}
                  </p>
                ) : null}
                {lastApply && (lastApply.conflicts.length > 0 || lastApply.failed.length > 0) ? (
                  <>
                    {lastApply.conflicts.length > 0 ? (
                      <p role="alert" className="text-destructive-foreground">
                        The conflicting paths were left unchanged. Review links before replacing
                        them; they may be used by another environment. Existing files or folders
                        must be moved manually.
                      </p>
                    ) : null}
                    {replacementOptions.length > 0 ? (
                      <div>
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={!canReplace}
                          onClick={() =>
                            setReplacementPaths(replacementOptions.map((option) => option.linkPath))
                          }
                        >
                          Use this catalog…
                        </Button>
                      </div>
                    ) : null}
                    {lastApply.conflicts.map((conflict) => (
                      <p key={`${conflict.skill}${conflict.linkPath}`} className="break-words">
                        Conflict: {conflict.skill} at {conflict.linkPath}: {conflict.detail}
                      </p>
                    ))}
                    {lastApply.failed.map((failed) => (
                      <p key={failed.linkPath} className="text-destructive-foreground">
                        Failed: {failed.linkPath}: {failed.error}
                      </p>
                    ))}
                  </>
                ) : null}
              </div>
            </SettingsRow>
          ) : null}
        </SettingsSection>
      ) : null}
      <Dialog open={reviewingApply && catalogReady} onOpenChange={setReviewingApply}>
        <DialogPopup className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Apply skill changes</DialogTitle>
            <DialogDescription>
              Selected groups and their dependencies will be installed or refreshed. This catalog’s
              links for unselected groups will be removed. Other sources are kept.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="grid gap-4 text-sm">
              {[
                {
                  title: "Add groups",
                  groups: selectedGroups.filter(
                    (name) => !status.data?.selectedGroups.includes(name),
                  ),
                },
                {
                  title: "Keep and refresh groups",
                  groups: selectedGroups.filter((name) =>
                    status.data?.selectedGroups.includes(name),
                  ),
                },
                {
                  title: "Remove groups",
                  groups: (status.data?.selectedGroups ?? []).filter(
                    (name) => !selectedGroups.includes(name),
                  ),
                },
              ]
                .filter((section) => section.groups.length > 0)
                .map((section) => (
                  <div key={section.title}>
                    <h3 className="font-medium">{section.title}</h3>
                    <ul className="list-inside list-disc pt-1 text-muted-foreground">
                      {section.groups.map((name) => (
                        <li key={name}>{name}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              {selectedGroups.length === 0 ? (
                <p role="alert">
                  No groups selected. Applying removes all links owned by this catalog.
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                Existing files and links from other sources will not be replaced without a separate
                confirmation. Running provider sessions may need restarting.
              </p>
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewingApply(false)}>
              Cancel
            </Button>
            <Button disabled={applyDisabled} onClick={() => void applySelected()}>
              Confirm changes
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={replacementPaths !== null && canReplace}
        onOpenChange={(open) => {
          if (!open) setReplacementPaths(null);
        }}
      >
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Use this catalog</DialogTitle>
            <DialogDescription>
              Replace the selected links with this catalog's skills. Source folders are kept. This
              affects every environment using these provider skill folders.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="grid gap-4">
              {replacementOptions.map((option) => (
                <label key={option.linkPath} className="flex min-w-0 items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    aria-label={`Replace ${option.linkPath}`}
                    checked={replacementPaths?.includes(option.linkPath) ?? false}
                    onChange={(event) =>
                      setReplacementPaths((paths) =>
                        event.target.checked
                          ? [...(paths ?? []), option.linkPath]
                          : (paths ?? []).filter((path) => path !== option.linkPath),
                      )
                    }
                  />
                  <span className="grid min-w-0 gap-1 break-words">
                    <strong>{option.skill}</strong>
                    <span>Link: {option.linkPath}</span>
                    <span>Current target: {option.currentTarget}</span>
                    <span>New target: {option.target}</span>
                  </span>
                </label>
              ))}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReplacementPaths(null)}>
              Cancel
            </Button>
            <Button
              disabled={!canReplace || !replacementPaths?.length}
              onClick={() =>
                void applySelected(
                  replacementOptions
                    .filter((option) => replacementPaths?.includes(option.linkPath))
                    .map(({ skill: _skill, ...replacement }) => replacement),
                )
              }
            >
              Replace selected links
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
