import type { EnvironmentId } from "@t3tools/contracts";
import type { SharingGrant, SharingGrantLevel, SharingPerson } from "@t3tools/contracts/j5";

import { Badge } from "../../components/ui/badge";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { toastManager } from "../../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useAtomCommand } from "../../state/use-atom-command";
import { levelLabel } from "./shareLink.logic";
import { refreshSharing, refusalMessage, sharingManage } from "./sharingManage";
import { showReturnedPerson } from "./returnedPeople";

/**
 * Whether a guest can be raised to Collaborate yet. Nothing lets a guest send to an agent today,
 * so the level is listed and cannot be chosen, as in the Share dialog.
 */
const COLLABORATE_IS_OFFERED = false;

/**
 * The level one person holds on one project or thread. A person who typed their own name cannot
 * be given Collaborate until a member confirms it (Shared server AC27), so their control says so.
 */
export function LevelControl({
  environmentId,
  person,
  grant,
  canManage,
}: {
  readonly environmentId: EnvironmentId;
  readonly person: SharingPerson;
  readonly grant: SharingGrant;
  readonly canManage: boolean;
}) {
  const putGrant = useAtomCommand(sharingManage.putGrant, { reportFailure: false });
  const change = async (level: SharingGrantLevel) => {
    if (level === grant.level) return;
    const result = await putGrant({
      environmentId,
      input: { personId: person.personId, target: grant.target, level },
    });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not change the level",
        description: refusalMessage(result),
      });
    } else showReturnedPerson(environmentId, result.value);
    refreshSharing(environmentId);
  };

  const control = (
    <Select
      value={grant.level}
      disabled={!canManage || person.nameSelfGiven}
      onValueChange={(value) => void change(value as SharingGrantLevel)}
    >
      <SelectTrigger size="xs" aria-label="Level">
        <SelectValue>{levelLabel(grant.level)}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem hideIndicator value="view">
          View
        </SelectItem>
        <SelectItem hideIndicator value="collaborate" disabled={!COLLABORATE_IS_OFFERED}>
          Collaborate
          {COLLABORATE_IS_OFFERED ? null : (
            <Badge variant="outline" size="sm">
              coming soon
            </Badge>
          )}
        </SelectItem>
      </SelectPopup>
    </Select>
  );
  if (!person.nameSelfGiven || !canManage) return <div className="w-36 shrink-0">{control}</div>;
  return (
    <Tooltip>
      <TooltipTrigger render={<div className="w-36 shrink-0" />}>{control}</TooltipTrigger>
      <TooltipPopup side="top">Confirm their name first</TooltipPopup>
    </Tooltip>
  );
}
