import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import type { CrewProposalSeatRuntime } from "@t3tools/contracts/j5";
import { PencilIcon, Trash2Icon } from "lucide-react";
import { type ReactNode } from "react";

import { ProviderInstanceIcon } from "../../components/chat/ProviderInstanceIcon";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../../components/ui/tooltip";
import { Button } from "../../components/ui/button";
import { serverEnvironment } from "../../state/server";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { CUSTOM_AGENT, crewProposalRowChange, type CrewProposalRow } from "./crewProposalDraft";
import { crewSeatStopsForApprovals, describeCrewSeatWorkspace } from "./crewSeatRuntime";

function MemberProvider(props: {
  environmentId: EnvironmentId;
  runtime?: CrewProposalSeatRuntime | undefined;
}) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(props.environmentId)) ?? [];
  const entry = deriveProviderInstanceEntries(providers).find(
    (provider) => provider.instanceId === props.runtime?.modelSelection.instanceId,
  );
  return entry ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            tabIndex={0}
            aria-label={entry.displayName}
            className="rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
          />
        }
      >
        <ProviderInstanceIcon
          driverKind={entry.driverKind}
          displayName={entry.displayName}
          accentColor={entry.accentColor}
          acpRegistryIconUrl={entry.acpRegistryIconUrl}
          iconClassName="size-6"
        />
      </TooltipTrigger>
      <TooltipPopup>{entry.displayName}</TooltipPopup>
    </Tooltip>
  ) : (
    <span className="size-6 shrink-0" aria-hidden />
  );
}

export function CrewProposalMemberRow(props: {
  readonly row: CrewProposalRow;
  readonly environmentId: EnvironmentId | null;
  readonly runtime?: CrewProposalSeatRuntime | undefined;
  readonly disabled: boolean;
  readonly canRemove: boolean;
  readonly runtimeLoading: boolean;
  readonly error?: string | undefined;
  readonly children?: ReactNode;
  readonly onOpen: (trigger: HTMLButtonElement) => void;
  readonly onRemove: () => void;
}) {
  const { row, runtime } = props;
  const change = crewProposalRowChange(row);
  const seat = {
    agentId: row.value.agentId === CUSTOM_AGENT ? null : row.value.agentId,
    runtimeMode: row.value.runtimeMode,
  };
  return (
    <li className="flex items-start gap-2 py-3" data-testid={`crew-member-${row.id}`}>
      <div className="pt-0.5">
        {props.environmentId === null ? null : (
          <MemberProvider environmentId={props.environmentId} runtime={runtime} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h3 className="break-words text-sm font-medium">
            {row.value.seat
              ? row.value.seat[0]!.toUpperCase() + row.value.seat.slice(1)
              : "New member"}
          </h3>
          <span className="text-xs text-muted-foreground">
            {runtime
              ? [runtime.model.replace(/^Claude\s+/u, ""), runtime.reasoning, runtime.access].join(
                  " · ",
                )
              : props.runtimeLoading
                ? "Resolving runtime…"
                : "Runtime unavailable"}
          </span>
          {change ? <span className="text-xs text-muted-foreground">{change}</span> : null}
        </div>
        <p className="mt-0.5 line-clamp-2 break-words text-xs text-muted-foreground">
          {row.original?.reason ?? "Added by the user"}
        </p>
        {runtime?.workspace && runtime.workspace.type !== "shared" ? (
          <p className="mt-1 break-words text-xs text-muted-foreground">
            {describeCrewSeatWorkspace(runtime.workspace)}
          </p>
        ) : null}
        {crewSeatStopsForApprovals(seat, runtime) ? (
          <p className="mt-1 text-xs text-warning">Asks for approvals</p>
        ) : null}
        {props.children}
        {props.error ? (
          <p className="mt-1 text-xs text-destructive" role="alert">
            {props.error}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          aria-label={`Edit seat ${row.value.seat}`}
          type="button"
          size="icon-xs"
          variant="ghost"
          disabled={props.disabled}
          onClick={(event) => props.onOpen(event.currentTarget)}
        >
          <PencilIcon className="size-3.5" />
        </Button>
        <Button
          aria-label={`Remove seat ${row.value.seat}`}
          type="button"
          size="icon-xs"
          variant="ghost"
          disabled={props.disabled || !props.canRemove}
          onClick={props.onRemove}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>
    </li>
  );
}
