import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import {
  crewMemberModelCounts,
  isCrewMemberModelChecked,
  isCrewMemberProviderSetUp,
  type CrewMemberModel,
  type CrewMemberModels,
} from "@t3tools/contracts/j5";
import { Link } from "@tanstack/react-router";
import { AlertTriangleIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

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
  crewMemberModelLabel,
  crewMemberModelsSummary,
  personasOffCrewMemberModels,
  setCrewMemberModelChecked,
  setCrewMemberProviderChecked,
} from "./crewMemberModels.logic";

const NO_ENVIRONMENT = "" as EnvironmentId;

/** One model: solid when allowed. Every chip fills its grid cell, so they all match in size. */
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

function ProviderModels(props: {
  readonly provider: ServerProvider;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly entry: ReturnType<typeof deriveProviderInstanceEntries>[number];
  readonly list: CrewMemberModels;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onChange: (next: ReadonlyArray<CrewMemberModel>) => void;
}) {
  const { provider, entry, list } = props;
  const { checked, total } = crewMemberModelCounts(list, [provider]);
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
            {checked} of {total}
          </span>
          <Button
            size="micro"
            variant="ghost-muted"
            onClick={() =>
              props.onChange(
                setCrewMemberProviderChecked(list, props.providers, provider, checked < total),
              )
            }
          >
            {checked < total ? "Check all" : "Uncheck all"}
          </Button>
        </div>
        <CollapsiblePanel>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-1.5 px-3 pb-3">
            {provider.models.map((model) => {
              const pair = { instanceId: provider.instanceId, model: model.slug };
              return (
                <li key={model.slug}>
                  <ModelChip
                    name={crewMemberModelLabel(provider, model.name)}
                    checked={isCrewMemberModelChecked(list, pair)}
                    onChange={(next) =>
                      props.onChange(setCrewMemberModelChecked(list, props.providers, pair, next))
                    }
                  />
                </li>
              );
            })}
          </ul>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

/**
 * Which models custom Crew members, and plain agents started without a persona, may run on.
 * Personas keep their own model, and native subagents are outside the list on every provider
 * (docs/j5/product/crews.md).
 */
export function CrewMemberModelsSettings() {
  const settings = useScopedSettings();
  const mixed = useScopedSettingsMixed(["crewMemberModels"]);
  const updateSettings = useUpdateScopedSettings();
  const { target } = useSettingsScope();
  const environmentId = target?.environmentId ?? null;
  const list = settings.crewMemberModels;
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
  const offList = personasOffCrewMemberModels(catalog.data, list);
  const save = (next: ReadonlyArray<CrewMemberModel>) => updateSettings({ crewMemberModels: next });
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;

  return (
    <SettingsRow
      id="crew-member-models"
      title="Models for custom members"
      description="Models custom members and persona-less agents may use. All are allowed until you save a list."
      serverScoped
      settingKeys={["crewMemberModels"]}
      mixed={mixed}
      status={
        summary.nothingEligible && !mixed ? (
          <span className="inline-flex items-center gap-1.5 text-warning-foreground">
            <AlertTriangleIcon aria-hidden="true" className="size-3.5 shrink-0" />
            No models allowed, so custom members can't start.
          </span>
        ) : null
      }
      resetAction={
        list !== null ? (
          <SettingResetButton
            label="Models for custom members"
            tooltip="Reset to every model"
            onClick={() => updateSettings({ crewMemberModels: null })}
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
            Personas keep their own model.
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
