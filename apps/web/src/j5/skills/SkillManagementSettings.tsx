import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderSkill,
} from "@t3tools/contracts";
import { skillLinkUnavailableReason } from "@t3tools/shared/j5/skillInventory";
import { skillLinkEnvironment } from "./skillLinkAtoms";
import { SkillLinksPanel, type SkillLinkSelection } from "./SkillLinksPanel";
import {
  CheckIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  CircleHelpIcon,
  MinusIcon,
  MoreHorizontalIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ProviderInstanceIcon } from "../../components/chat/ProviderInstanceIcon";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../components/ui/collapsible";
import { Input } from "../../components/ui/input";
import { SettingsGroup } from "../../components/settings/SettingsGroup";
import { SettingsRow, SettingsSection } from "../../components/settings/settingsLayout";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../components/ui/menu";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { useOptionalSettingsScope } from "../../components/settings/SettingsScopeContext";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { useEnvironment } from "../../state/environments";
import { lockedSettingsScopeProject } from "../settingsScopeEnvironment.logic";
import { useProjects } from "../../state/entities";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  buildSkillInventory,
  filterSkillInventory,
  inventoryColumnProviders,
  missingSkillLabel,
  SKILL_ORIGINS,
  skillDiscoveryState,
  type SkillOrigin,
} from "./skillInventory";

const SKILL_ORIGIN_DESCRIPTIONS = {
  Plugin:
    "From installed plugins’ skill folders, such as those under ~/.codex/plugins or ~/.claude/plugins.",
  Catalog:
    "From your configured skill catalog directory or the cached catalog checkout, including skills linked to those locations.",
  Project:
    "Reported for the selected project or workspace, usually from folders such as .agents/skills or .claude/skills inside the project.",
  Personal:
    "Reported for your user account, usually from folders such as ~/.agents/skills, ~/.codex/skills, or ~/.claude/skills. Custom provider homes may use different paths.",
  "Built-in":
    "Reported by the provider as built-in, system, or administrator-managed skills. Their locations depend on the provider and installation.",
  Other:
    "Discovered by a provider, but its reported scope and file location do not identify one of the categories above.",
} satisfies Record<SkillOrigin, string>;

function providerLabel(provider: ServerProvider, providers: ReadonlyArray<ServerProvider>) {
  const label = provider.displayName ?? provider.driver;
  return providers.filter((entry) => entry.driver === provider.driver).length > 1
    ? `${label} (${provider.instanceId})`
    : label;
}

function SkillRecordDetails({ skill }: { readonly skill: ServerProviderSkill }) {
  return (
    <div className="space-y-1">
      <p className="font-medium">{skill.name}</p>
      {(skill.description ?? skill.shortDescription) ? (
        <p>{skill.description ?? skill.shortDescription}</p>
      ) : null}
      <p>
        {skill.enabled ? "Enabled" : "Disabled"}
        {skill.userInvocationOnly ? " · User only" : ""}
        {skill.userInvocable === false ? " · Agent only" : ""}
      </p>
      {skill.pluginId ? <p>Plugin: {skill.pluginId}</p> : null}
      <p>{skill.path}</p>
      <p>{skill.linkTarget ? `Resolved: ${skill.linkTarget}` : "Resolved location unavailable"}</p>
    </div>
  );
}

const offersSkillLinks = (provider: ServerProvider) =>
  provider.driver === "codex" || provider.driver === "claudeAgent";

export function SkillInventoryPanel({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const environment = useEnvironment(environmentId);
  const allProjects = useProjects();
  const settingsScope = useOptionalSettingsScope()?.scope;
  const [projectId, setProjectId] = useState("");
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const [filter, setFilter] = useState<ProviderInstanceId | undefined>();
  const [query, setQuery] = useState("");
  const [linkSelection, setLinkSelection] = useState<SkillLinkSelection | null>(null);
  const [collapsedOrigins, setCollapsedOrigins] = useState<ReadonlySet<SkillOrigin>>(new Set());
  const [detailsKey, setDetailsKey] = useState<string | null>(null);
  const canOperate = useAtomValue(skillLinkEnvironment.create.permissionAtom(environmentId));
  const refresh = useAtomCommand(serverEnvironment.refreshProviders, { reportFailure: false });
  const attempted = useRef({ selection: "", instances: new Set<ProviderInstanceId>() });
  const [failures, setFailures] = useState<ReadonlySet<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const busy = useRef(false);

  // A project named in the settings scope sentence locks the inventory to its checkout.
  const lockedProject = lockedSettingsScopeProject(settingsScope, environmentId);
  const project =
    lockedProject ??
    allProjects.find((entry) => entry.environmentId === environmentId && entry.id === projectId);
  // Make the primitive explicit so React Compiler preserves the inventory memoization.
  const cwd = project ? String(project.workspaceRoot) : undefined;
  const connected = environment?.connection.phase === "connected";

  // The effect reads only hook values and primitives, and comes before the derived lists: the
  // compiler caches a value only when no hook call sits between its uses.
  // oxlint-disable-next-line t3code/react-effect-budget -- refreshes a provider's skills from the server once per selection, for the providers that have no snapshot yet.
  useEffect(() => {
    const selectedProvider = providers.find(
      (provider) => offersSkillLinks(provider) && provider.instanceId === filter,
    );
    const selection = JSON.stringify([cwd, selectedProvider?.instanceId, connected]);
    if (attempted.current.selection !== selection) {
      attempted.current = { selection, instances: new Set() };
    }
    if (!connected || !cwd) return;
    for (const provider of selectedProvider ? [selectedProvider] : providers) {
      if (
        !provider.enabled ||
        !provider.installed ||
        provider.availability === "unavailable" ||
        provider.workspaceSnapshots?.some((snapshot) => snapshot.cwd === cwd)
      )
        continue;
      const key = JSON.stringify([provider.instanceId, cwd]);
      if (attempted.current.instances.has(provider.instanceId)) continue;
      attempted.current.instances.add(provider.instanceId);
      void refresh({ environmentId, input: { instanceId: provider.instanceId, cwd } }).then(
        (result) => {
          setFailures((previous) => {
            if (result._tag === "Failure") return new Set(previous).add(key);
            if (!previous.has(key)) return previous;
            const next = new Set(previous);
            next.delete(key);
            return next;
          });
        },
      );
    }
  }, [connected, cwd, environmentId, providers, filter, refresh, attempted]);

  const projects = allProjects.filter((entry) => entry.environmentId === environmentId);
  const providerOptions = providers.filter(offersSkillLinks);
  const selectedProvider = providerOptions.find((provider) => provider.instanceId === filter);
  const selectedProviders = selectedProvider ? [selectedProvider] : providers;
  const scopeKey = (instanceId: ProviderInstanceId) => JSON.stringify([instanceId, cwd]);

  const catalogSource = environment?.serverConfig?.settings.skillCatalogSource;
  const rows = buildSkillInventory(providers, cwd, catalogSource);
  const visibleRows = filterSkillInventory(rows, query, selectedProvider?.instanceId);
  const details = visibleRows.find((row) => row.key === detailsKey);
  const displayedProviders = selectedProvider
    ? selectedProviders
    : inventoryColumnProviders(selectedProviders, rows);
  const providerDetails = new Map(
    displayedProviders.map((provider) => [
      provider.instanceId,
      {
        label: providerLabel(provider, displayedProviders),
        state: failures.has(JSON.stringify([provider.instanceId, cwd]))
          ? ("failed" as const)
          : !connected
            ? ("not-checked" as const)
            : skillDiscoveryState(provider, cwd),
        driver: provider.driver,
        checkedAt:
          (cwd
            ? provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd)?.checkedAt
            : undefined) ?? provider.checkedAt,
      },
    ]),
  );

  async function refreshInventory() {
    if (busy.current) return;
    busy.current = true;
    setRefreshing(true);
    await Promise.all(
      selectedProviders.map(async (provider) => {
        const key = scopeKey(provider.instanceId);
        // No cwd: the explicit instance refresh replaces its cached workspaces.
        let result = await refresh({
          environmentId,
          input: { instanceId: provider.instanceId },
        });
        if (
          result._tag === "Success" &&
          cwd &&
          !result.value.providers
            .find((entry) => entry.instanceId === provider.instanceId)
            ?.workspaceSnapshots?.some((snapshot) => snapshot.cwd === cwd)
        ) {
          result = await refresh({
            environmentId,
            input: { instanceId: provider.instanceId, cwd },
          });
        }
        setFailures((previous) => {
          const next = new Set(previous);
          if (result._tag === "Failure") next.add(key);
          else next.delete(key);
          return next;
        });
      }),
    );
    busy.current = false;
    setRefreshing(false);
  }

  return (
    <div className="grid min-w-0 gap-4">
      <SettingsGroup>
        {!lockedProject ? (
          <SettingsRow
            title="Project"
            description="Include skills from this workspace."
            control={
              <Select
                value={project?.id ?? ""}
                onValueChange={(value) => {
                  setProjectId(value ?? "");
                  setLinkSelection(null);
                  setDetailsKey(null);
                }}
              >
                <SelectTrigger size="sm" aria-label="Skill inventory project">
                  <SelectValue>{project?.title ?? "Environment only"}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="">Environment only</SelectItem>
                  {projects.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {entry.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        ) : null}
        <SettingsRow
          title="Provider"
          control={
            <Select
              value={selectedProvider?.instanceId ?? ""}
              onValueChange={(value) => {
                setFilter(
                  providerOptions.find((provider) => provider.instanceId === value)?.instanceId,
                );
                setDetailsKey(null);
              }}
            >
              <SelectTrigger size="sm" aria-label="Skill inventory provider">
                <SelectValue>
                  {selectedProvider?.displayName ?? selectedProvider?.instanceId ?? "All providers"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="">All providers</SelectItem>
                {providerOptions.map((provider) => (
                  <SelectItem key={provider.instanceId} value={provider.instanceId}>
                    {providerLabel(provider, providerOptions)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsGroup>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <Input
            size="sm"
            aria-label="Search skill inventory"
            placeholder="Search skills…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              if (event.target.value.trim()) setCollapsedOrigins(new Set());
            }}
          />
        </div>
        <Button
          size="xs"
          variant="ghost"
          disabled={!connected || refreshing || providers.length === 0}
          onClick={() => void refreshInventory()}
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      <div className="grid gap-1 px-3 text-xs text-muted-foreground sm:px-4" role="status">
        {!connected ? <p>Environment disconnected. Cached results may be stale.</p> : null}
        {displayedProviders.map((provider) => {
          const { state, label } = providerDetails.get(provider.instanceId)!;
          return state !== "checked" ? (
            <p key={provider.instanceId} className="text-warning">
              {label}: {missingSkillLabel(state)}. Cached results may be stale.
            </p>
          ) : null;
        })}
        <details>
          <summary className="w-fit cursor-pointer">
            {visibleRows.length} skill locations · Discovery details
          </summary>
          <div className="grid gap-1 pt-2">
            {displayedProviders.map((provider) => {
              const { state, label, checkedAt } = providerDetails.get(provider.instanceId)!;
              return (
                <p key={provider.instanceId}>
                  {label}: {state === "checked" ? `Checked ${checkedAt}` : missingSkillLabel(state)}
                </p>
              );
            })}
          </div>
        </details>
      </div>
      {SKILL_ORIGINS.map((origin) => {
        const group = visibleRows.filter((row) => row.origin === origin);
        if (!group.length) return null;
        return (
          <Collapsible
            key={origin}
            open={!collapsedOrigins.has(origin)}
            onOpenChange={(open) => {
              setCollapsedOrigins((previous) => {
                const next = new Set(previous);
                if (open) next.delete(origin);
                else next.add(origin);
                return next;
              });
            }}
          >
            <SettingsSection
              title={`${origin} (${group.length})`}
              variant="plain"
              headerAction={
                <CollapsibleTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`${collapsedOrigins.has(origin) ? "Expand" : "Collapse"} ${origin} skills`}
                    />
                  }
                >
                  <ChevronRightIcon
                    className={collapsedOrigins.has(origin) ? "size-3.5" : "size-3.5 rotate-90"}
                  />
                </CollapsibleTrigger>
              }
            >
              <CollapsiblePanel>
                <SettingsGroup role="list" aria-label={`${origin} skill inventory`}>
                  {group.map((row) => {
                    const selectedRecords = displayedProviders.flatMap((provider) =>
                      (row.records.get(provider.instanceId) ?? []).map((skill) => ({
                        provider,
                        skill,
                      })),
                    );
                    const first = selectedRecords[0]!.skill;
                    const name = first.displayName ?? first.name;
                    const canLink = !skillLinkUnavailableReason(row.origin);
                    const selectAction = (action: SkillLinkSelection["action"]) =>
                      setLinkSelection({
                        action,
                        source: {
                          instanceId: selectedRecords[0]!.provider.instanceId,
                          path: first.path,
                          name: first.name,
                        },
                        origin: row.origin,
                      });
                    return (
                      <SettingsRow
                        key={row.key}
                        role="listitem"
                        title={name}
                        description={
                          <span className="line-clamp-2">
                            {first.shortDescription ?? first.description}
                          </span>
                        }
                        status={
                          <div className="flex flex-wrap gap-x-3 gap-y-1">
                            {displayedProviders.flatMap((provider) => {
                              const { state, driver, label } = providerDetails.get(
                                provider.instanceId,
                              )!;
                              const records = row.records.get(provider.instanceId);
                              return (records ?? [undefined]).map((skill) => {
                                const status =
                                  state !== "checked"
                                    ? skill
                                      ? "Unknown · Stale"
                                      : "Unknown"
                                    : skill
                                      ? skill.enabled
                                        ? "Enabled"
                                        : "Disabled"
                                      : "Not detected";
                                const StatusIcon =
                                  state !== "checked"
                                    ? CircleHelpIcon
                                    : skill
                                      ? skill.enabled
                                        ? CheckIcon
                                        : MinusIcon
                                      : CircleDashedIcon;
                                const statusLabel = `${label}: ${skill?.name ?? name} · ${status}`;
                                return (
                                  <Tooltip
                                    key={JSON.stringify([
                                      provider.instanceId,
                                      skill?.path,
                                      skill?.name,
                                      skill?.pluginId,
                                    ])}
                                  >
                                    <TooltipTrigger
                                      render={
                                        <span
                                          role="img"
                                          tabIndex={0}
                                          className="inline-flex items-center gap-1.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                                          aria-label={statusLabel}
                                        >
                                          <ProviderInstanceIcon
                                            driverKind={driver}
                                            displayName={label}
                                            iconClassName="size-3"
                                          />
                                          <span>{label}</span>
                                          <Badge
                                            size="sm"
                                            variant={
                                              state !== "checked"
                                                ? "warning"
                                                : skill?.enabled
                                                  ? "success"
                                                  : "secondary"
                                            }
                                          >
                                            <StatusIcon aria-hidden="true" />
                                          </Badge>
                                        </span>
                                      }
                                    />
                                    <TooltipPopup>{statusLabel}</TooltipPopup>
                                  </Tooltip>
                                );
                              });
                            })}
                          </div>
                        }
                        control={
                          <Menu>
                            <MenuTrigger
                              aria-label={`More actions for ${name}`}
                              render={<Button variant="ghost" size="icon-sm" />}
                            >
                              <MoreHorizontalIcon className="size-4" />
                            </MenuTrigger>
                            <MenuPopup align="end">
                              <MenuItem onClick={() => setDetailsKey(row.key)}>Details</MenuItem>
                              {canLink ? (
                                <>
                                  <MenuItem
                                    disabled={!connected || !canOperate}
                                    onClick={() => selectAction("link")}
                                  >
                                    Make available to…
                                  </MenuItem>
                                  <MenuItem
                                    disabled={!connected || !canOperate}
                                    onClick={() => selectAction("unlink")}
                                  >
                                    Remove provider link…
                                  </MenuItem>
                                </>
                              ) : null}
                              {row.origin === "Personal" || row.origin === "Project" ? (
                                <>
                                  <MenuSeparator />
                                  <MenuItem
                                    variant="destructive"
                                    disabled={!connected || !canOperate}
                                    onClick={() => selectAction("delete")}
                                  >
                                    Delete source folder…
                                  </MenuItem>
                                </>
                              ) : null}
                            </MenuPopup>
                          </Menu>
                        }
                      />
                    );
                  })}
                </SettingsGroup>
              </CollapsiblePanel>
            </SettingsSection>
          </Collapsible>
        );
      })}
      <Dialog
        open={details !== undefined}
        onOpenChange={(open) => {
          if (!open) setDetailsKey(null);
        }}
      >
        <DialogPopup className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Skill details</DialogTitle>
            <DialogDescription>
              {details ? SKILL_ORIGIN_DESCRIPTIONS[details.origin] : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="grid gap-4 text-sm break-words">
              {details
                ? displayedProviders.map((provider) => {
                    const { state, label } = providerDetails.get(provider.instanceId)!;
                    const records = details.records.get(provider.instanceId);
                    return (
                      <div key={provider.instanceId} className="grid gap-2">
                        <h3 className="font-medium">
                          {label}
                          {state !== "checked" ? ` · ${missingSkillLabel(state)} · Stale` : ""}
                        </h3>
                        {records ? (
                          records.map((skill) => (
                            <SkillRecordDetails
                              key={JSON.stringify([skill.path, skill.name, skill.pluginId])}
                              skill={skill}
                            />
                          ))
                        ) : (
                          <p>{missingSkillLabel(state)}</p>
                        )}
                      </div>
                    );
                  })
                : null}
              {details && skillLinkUnavailableReason(details.origin) ? (
                <p className="text-muted-foreground">
                  {skillLinkUnavailableReason(details.origin)}
                </p>
              ) : null}
            </div>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
      <SkillLinksPanel
        environmentId={environmentId}
        connected={connected}
        providers={providers}
        {...(project ? { projectId: project.id, projectTitle: project.title } : {})}
        selection={linkSelection}
        onClose={() => setLinkSelection(null)}
      />
      {!visibleRows.length ? (
        <SettingsGroup>
          <SettingsRow
            title="No skills reported for this selection"
            description="Try another search or refresh discovery."
          />
        </SettingsGroup>
      ) : null}
    </div>
  );
}
