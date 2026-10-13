import {
  GUEST_SKILLS_UNAVAILABLE,
  useGuestEnvironmentIds,
  useIsGuestEverywhere,
} from "../sharing/guestAccess";
import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type SkillCatalogApplyResult,
  type SkillCatalogReplacement,
} from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

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

/** Skills belong to the person a server belongs to; a guest is not offered them (AC24). */
export function SkillInstallerSettings() {
  return useIsGuestEverywhere() ? (
    <SettingsPageContainer>
      <SettingsSection title="Skills">
        <SettingsUnavailableGroup message={GUEST_SKILLS_UNAVAILABLE}>
          {null}
        </SettingsUnavailableGroup>
      </SettingsSection>
    </SettingsPageContainer>
  ) : (
    <MemberSkillInstallerSettings />
  );
}

function MemberSkillInstallerSettings() {
  const guestEnvironmentIds = useGuestEnvironmentIds();
  const { environments: everyEnvironment } = useEnvironments();
  // A server this person is a guest on is left out: its skills are not theirs to manage.
  const environments = useMemo(
    () =>
      everyEnvironment.filter((environment) => !guestEnvironmentIds.has(environment.environmentId)),
    [everyEnvironment, guestEnvironmentIds],
  );
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const orderedEnvironments = useMemo(
    () =>
      environments.toSorted((left, right) => {
        const leftPrimary = left.environmentId === primaryEnvironmentId;
        const rightPrimary = right.environmentId === primaryEnvironmentId;
        return Number(rightPrimary) - Number(leftPrimary) || left.label.localeCompare(right.label);
      }),
    [environments, primaryEnvironmentId],
  );
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
          <SkillCatalogPanel environmentId={effectiveEnvironmentId} />
          <SettingsSection id="installed-skills" title="Installed" variant="plain">
            <SkillInventoryPanel environmentId={effectiveEnvironmentId} />
          </SettingsSection>
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
  useEffect(() => {
    if (draft !== null && draft.trim() === configuredSource) setDraft(null);
  }, [draft, configuredSource]);

  const selectionScope = catalogScopeFor(environmentId, configuredSource);
  // Latest identity for in-flight requests: an Apply started on A must not
  // publish its counts into B's panel when another client switches sources
  // mid-operation. Written in the reset effect below (not during render) so
  // it always moves together with the state reset.
  const selectionScopeRef = useRef(selectionScope);
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

  const [busy, setBusy] = useState(false);
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
  useEffect(() => {
    selectionScopeRef.current = selectionScope;
    setSelection({ scope: null, groups: [] });
    setLastApply(null);
    setReplacementPaths(null);
    setApplyFailure(null);
    setNotice(null);
    setSaveError(null);
  }, [selectionScope]);

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
    setBusy(true);
    setNotice(null);
    setSaveError(null);
    setApplyFailure(null);
    try {
      const result = await persistSettings({
        environmentId,
        input: { patch: { skillCatalogSource: trimmed } },
      });
      if (selectionScopeRef.current !== originScope) return;
      if (result._tag === "Failure") {
        // The draft stays visible against the old settings; actions stay
        // disabled until the displayed source has matching loaded status.
        setSaveError(messageOf(squashAtomCommandFailure(result)));
        return;
      }
      // The status query follows the echoed settings. Actions stay disabled
      // until the new source's status arrives.
      status.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function applySelected(replacements?: ReadonlyArray<SkillCatalogReplacement>) {
    if (!catalogReady) return;
    setReplacementPaths(null);
    const originScope = selectionScope;
    setBusy(true);
    setNotice(null);
    setApplyFailure(null);
    try {
      const result = await applyGroupsCommand({
        environmentId,
        input: {
          expectedSource: configuredSource,
          groups: selectedGroups,
          ...(replacements ? { replacements } : {}),
        },
      });
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
        setNotice(summarizeApplyResult(result.value));
      }
      status.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function updateCheckout() {
    if (!catalogReady) return;
    const originScope = selectionScope;
    setBusy(true);
    setNotice(null);
    setApplyFailure(null);
    try {
      const result = await updateCatalogCommand({
        environmentId,
        input: { expectedSource: configuredSource },
      });
      if (selectionScopeRef.current !== originScope) return;
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setApplyFailure({ message: messageOf(cause), partial: null });
      } else {
        setNotice(`Catalog updated from ${result.value.upstream}.`);
      }
      status.refresh();
    } finally {
      setBusy(false);
    }
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
          description="Use a Git URL or an absolute path on this environment's machine. Installed skills link to this folder, so keep it in place."
          control={
            <Input
              aria-label="Catalog source"
              size="sm"
              value={displayedSource}
              disabled={busy}
              placeholder="https://github.com/your-team/skills.git or /path/to/catalog"
              autoComplete="off"
              spellCheck={false}
              font="mono"
              className="w-full sm:w-80"
              onChange={(event) => {
                setDraft(event.target.value);
                setNotice(null);
              }}
            />
          }
        >
          <div className="flex flex-wrap gap-2 pt-2 pb-3 sm:justify-end">
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
              disabled={busy || !isSourceSaveable(displayedSource, configuredSource)}
              onClick={() => void saveSource()}
            >
              {busy ? "Saving…" : "Save source"}
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={busy || displayedSource === DEFAULT_SERVER_SETTINGS.skillCatalogSource}
              title="Clear the catalog source, then save."
              onClick={() => {
                setDraft(DEFAULT_SERVER_SETTINGS.skillCatalogSource);
                setNotice(null);
              }}
            >
              Clear source
            </Button>
          </div>
          {saveError ? (
            <p role="alert" className="pb-3 text-sm text-destructive-foreground">
              {saveError} The previous source is still active.
            </p>
          ) : null}
        </SettingsRow>
        <SettingsRow
          title="Catalog status"
          description="Update a Git-backed catalog before applying its groups."
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={busy || updateDisabled}
              title={
                upstream === null
                  ? "The catalog reports no upstream to update from."
                  : `Update from ${upstream}.`
              }
              onClick={() => void updateCheckout()}
            >
              {busy ? "Updating…" : "Update catalog"}
            </Button>
          }
        >
          <div className="grid gap-2 pt-2 pb-3">
            {status.error ? (
              <div className="grid gap-2">
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
            {!configuredSource ? (
              <p className="text-sm text-muted-foreground">
                Choose and save a catalog source to get started.
              </p>
            ) : null}
            {configuredSource && status.data === null && !status.error ? (
              <p className="text-sm text-muted-foreground">
                {status.isPending ? "Loading catalog status…" : "No catalog status yet."}
              </p>
            ) : null}
            {status.data ? (
              <>
                <p className="break-all text-xs text-muted-foreground">
                  {status.data.catalogDir} · {upstream ?? "no upstream"} ·{" "}
                  {status.data.git.dirty ? "dirty" : "clean"}
                  {status.data.targets.length > 0
                    ? ` · installs to ${status.data.targets.join(", ")}`
                    : null}
                </p>
                {status.data.warnings.map((warning) => (
                  <p key={warning} className="text-xs text-muted-foreground">
                    {warning}
                  </p>
                ))}
              </>
            ) : null}
          </div>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection
        title="Skill groups"
        headerAction={
          <Button size="xs" disabled={applyDisabled} onClick={() => void applySelected()}>
            {busy ? "Applying…" : "Apply selected groups"}
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
                <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm text-muted-foreground outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
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
                      The conflicting paths were left unchanged. Review links before replacing them;
                      they may be used by another environment. Existing files or folders must be
                      moved manually.
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
                      Conflict: {conflict.skill} at {conflict.linkPath} — {conflict.detail}
                    </p>
                  ))}
                  {lastApply.failed.map((failed) => (
                    <p key={failed.linkPath} className="text-destructive-foreground">
                      Failed: {failed.linkPath} — {failed.error}
                    </p>
                  ))}
                </>
              ) : null}
            </div>
          </SettingsRow>
        ) : null}
      </SettingsSection>
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
