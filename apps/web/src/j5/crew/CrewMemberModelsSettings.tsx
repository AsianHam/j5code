import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import {
  crewMemberLevelCounts,
  crewMemberModelCounts,
  crewMemberProviderLevels,
  isCrewMemberLevelChecked,
  isCrewMemberModelChecked,
  isCrewMemberProviderSetUp,
  type CrewMemberModel,
  type CrewMemberModels,
  type CrewMemberReasoning,
  type CrewMemberReasoningLevel,
} from "@t3tools/contracts/j5";
import { Link } from "@tanstack/react-router";
import { AlertTriangleIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { ProviderInstanceIcon } from "../../components/chat/ProviderInstanceIcon";
import { SettingResetButton, SettingsRow } from "../../components/settings/settingsLayout";
import { useSettingsScope } from "../../components/settings/SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "../../components/settings/useScopedSettings";
import { Button } from "../../components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../components/ui/collapsible";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { agentPersonaEnvironment } from "../agents/agentPersonaAtoms";
import {
  crewMemberLevelsSummary,
  crewMemberModelLabel,
  crewMemberModelsSummary,
  crewMemberProviderSummary,
  personasOffCrewMemberModels,
  setCrewMemberLevelChecked,
  setCrewMemberModelChecked,
  setCrewMemberProviderChecked,
  setCrewMemberProviderLevelsChecked,
} from "./crewMemberModels.logic";

const NO_ENVIRONMENT = "" as EnvironmentId;

/** One model or level: solid when allowed. Every chip fills its grid cell, so they all match in size. */
function ModelChip(props: {
  readonly name: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.checked}
      onClick={() => props.onChange(!props.checked)}
      className={`h-7 w-full cursor-pointer truncate rounded-md border px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
        props.checked
          ? "border-primary bg-primary text-primary-foreground"
          : "border-input bg-background text-muted-foreground hover:bg-accent hover:text-foreground"
      }`}
    >
      {props.name}
    </button>
  );
}

interface CrewMemberListsPatch {
  readonly crewMemberModels?: ReadonlyArray<CrewMemberModel>;
  readonly crewMemberReasoning?: ReadonlyArray<CrewMemberReasoningLevel>;
}

function ChipGroup(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <p className="text-3xs font-medium uppercase tracking-wider text-muted-foreground">
        {props.label}
      </p>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-1.5">
        {props.children}
      </ul>
    </div>
  );
}

function ProviderModels(props: {
  readonly provider: ServerProvider;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly entry: ReturnType<typeof deriveProviderInstanceEntries>[number];
  readonly list: CrewMemberModels;
  readonly reasoning: CrewMemberReasoning;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onChange: (patch: CrewMemberListsPatch) => void;
}) {
  const { provider, entry, list, reasoning } = props;
  const levels = crewMemberProviderLevels(provider);
  const modelCounts = crewMemberModelCounts(list, [provider]);
  const levelCounts = crewMemberLevelCounts(reasoning, [provider]);
  const allChecked =
    modelCounts.checked === modelCounts.total && levelCounts.checked === levelCounts.total;
  const Chevron = props.open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div className="rounded-lg border bg-card">
      <Collapsible open={props.open} onOpenChange={props.onOpenChange}>
        <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
          <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2 text-left">
            <Chevron aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            <ProviderInstanceIcon
              driverKind={entry.driverKind}
              displayName={entry.displayName}
              acpRegistryIconUrl={entry.acpRegistryIconUrl}
              iconClassName="size-3.5"
            />
            <span className="truncate font-medium text-foreground">{entry.displayName}</span>
          </CollapsibleTrigger>
          <span className="shrink-0 text-muted-foreground">
            {crewMemberProviderSummary(provider, list, reasoning)}
          </span>
          <Button
            size="micro"
            variant="ghost-muted"
            onClick={() =>
              props.onChange({
                crewMemberModels: setCrewMemberProviderChecked(
                  list,
                  props.providers,
                  provider,
                  !allChecked,
                ),
                ...(levels.length === 0
                  ? {}
                  : {
                      crewMemberReasoning: setCrewMemberProviderLevelsChecked(
                        reasoning,
                        props.providers,
                        provider,
                        !allChecked,
                      ),
                    }),
              })
            }
          >
            {allChecked ? "Uncheck all" : "Check all"}
          </Button>
        </div>
        <CollapsiblePanel>
          <div className="space-y-3 px-3 pb-3">
            <ChipGroup label="Models">
              {provider.models.map((model) => {
                const pair = { instanceId: provider.instanceId, model: model.slug };
                return (
                  <li key={model.slug}>
                    <ModelChip
                      name={crewMemberModelLabel(provider, model.name)}
                      checked={isCrewMemberModelChecked(list, pair)}
                      onChange={(next) =>
                        props.onChange({
                          crewMemberModels: setCrewMemberModelChecked(
                            list,
                            props.providers,
                            pair,
                            next,
                          ),
                        })
                      }
                    />
                  </li>
                );
              })}
            </ChipGroup>
            {levels.length === 0 ? null : (
              <ChipGroup label="Reasoning">
                {levels.map((level) => {
                  const key = { instanceId: provider.instanceId, level: level.level };
                  return (
                    <li key={level.level}>
                      <ModelChip
                        name={level.label}
                        checked={isCrewMemberLevelChecked(reasoning, key)}
                        onChange={(next) =>
                          props.onChange({
                            crewMemberReasoning: setCrewMemberLevelChecked(
                              reasoning,
                              props.providers,
                              key,
                              next,
                            ),
                          })
                        }
                      />
                    </li>
                  );
                })}
              </ChipGroup>
            )}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

/**
 * Which models and reasoning levels custom Crew members, and plain agents started without a
 * persona, may use. Personas keep their own model and level, and native subagents are outside the
 * lists on every provider (docs/j5/product/crews.md).
 */
export function CrewMemberModelsSettings() {
  const settings = useScopedSettings();
  const mixed = useScopedSettingsMixed(["crewMemberModels", "crewMemberReasoning"]);
  const updateSettings = useUpdateScopedSettings();
  const { target } = useSettingsScope();
  const environmentId = target?.environmentId ?? null;
  const list = settings.crewMemberModels;
  const reasoning = settings.crewMemberReasoning;
  const [open, setOpen] = useState(false);
  const [openProvider, setOpenProvider] = useState<string | null>(null);
  const providers = useAtomValue(
    serverEnvironment.providersValueAtom(environmentId ?? NO_ENVIRONMENT),
  );
  const catalog = useEnvironmentQuery(
    environmentId === null ? null : agentPersonaEnvironment.catalog({ environmentId, input: {} }),
  );
  const entries = deriveProviderInstanceEntries(providers ?? []);
  const known = providers ?? [];
  const setUp = entries.filter((entry) => isCrewMemberProviderSetUp(entry.snapshot));
  const notSetUp = entries.filter((entry) => !isCrewMemberProviderSetUp(entry.snapshot));
  const summary = crewMemberModelsSummary(list, known);
  const levelSummary = crewMemberLevelsSummary(reasoning, known);
  const offList = personasOffCrewMemberModels(catalog.data, list);
  const save = (patch: CrewMemberListsPatch) => updateSettings(patch);
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;

  return (
    <SettingsRow
      id="crew-member-models"
      title="Models for custom members"
      description="Models and reasoning levels custom members and persona-less agents may use. All are allowed until you save a list."
      serverScoped
      settingKeys={["crewMemberModels", "crewMemberReasoning"]}
      mixed={mixed}
      status={
        (summary.nothingEligible || levelSummary.nothingEligible) && !mixed ? (
          <span className="inline-flex items-center gap-1.5 text-warning-foreground">
            <AlertTriangleIcon aria-hidden="true" className="size-3.5 shrink-0" />
            {summary.nothingEligible
              ? "No models allowed, so custom members can't start."
              : "No reasoning levels allowed, so custom members can't use models that have them."}
          </span>
        ) : null
      }
      resetAction={
        list !== null || reasoning !== null ? (
          <SettingResetButton
            label="Models for custom members"
            tooltip="Reset to every model and level"
            onClick={() => updateSettings({ crewMemberModels: null, crewMemberReasoning: null })}
          />
        ) : null
      }
      control={
        <Button
          size="sm"
          variant="outline"
          aria-expanded={open}
          aria-controls="crew-member-models-panel"
          disabled={environmentId === null}
          onClick={() => {
            setOpen((value) => !value);
            setOpenProvider((current) => current ?? setUp[0]?.instanceId ?? null);
          }}
        >
          {mixed ? "Mixed" : summary.label}
          <Chevron aria-hidden="true" />
        </Button>
      }
    >
      {open && environmentId !== null ? (
        <div id="crew-member-models-panel" className="space-y-2 pb-3 pt-1">
          {mixed ? (
            <p className="text-xs text-muted-foreground">
              The environments differ. A change applies to all of them.
            </p>
          ) : null}
          {setUp.map((entry) => (
            <ProviderModels
              key={entry.instanceId}
              provider={entry.snapshot}
              providers={known}
              entry={entry}
              list={list}
              reasoning={reasoning}
              open={openProvider === entry.instanceId}
              onOpenChange={(next) => setOpenProvider(next ? entry.instanceId : null)}
              onChange={save}
            />
          ))}
          {notSetUp.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              Not set up: {notSetUp.map((entry) => entry.displayName).join(", ")}.{" "}
              <Link to="/settings/providers" className="underline underline-offset-2">
                Set up in Providers
              </Link>
              .
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Personas keep their own model and level.
            {offList.length > 0
              ? ` ${offList.join(", ")} ${offList.length === 1 ? "uses" : "use"} an unchecked one.`
              : ""}{" "}
            Native subagents aren't covered.
          </p>
        </div>
      ) : null}
    </SettingsRow>
  );
}
