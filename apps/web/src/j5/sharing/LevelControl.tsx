import type { EnvironmentId } from "@t3tools/contracts";
import type { SharingGrant, SharingGrantLevel, SharingPerson } from "@t3tools/contracts/j5";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { toastManager } from "../../components/ui/toast";
import { useAtomCommand } from "../../state/use-atom-command";
import { levelLabel } from "./shareLink.logic";
import { openSharingDialog } from "./sharingDialogs";
import { refreshSharing, refusalMessage, sharingManage } from "./sharingManage";
import { showReturnedPerson } from "./returnedPeople";

/**
 * The level one person holds on one project or thread. Lowering to View happens at once. Raising
 * to Collaborate opens the dialog that says what it allows and, for a person who typed their own
 * name, confirms it first (Shared server AC27).
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
    if (level === "collaborate") {
      openSharingDialog({
        kind: "promote",
        environmentId,
        person: {
          personId: person.personId,
          name: person.displayName ?? "this person",
          nameSelfGiven: person.nameSelfGiven,
        },
        target: grant.target,
      });
      return;
    }
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

  return (
    <div className="w-36 shrink-0">
      <Select
        value={grant.level}
        disabled={!canManage}
        onValueChange={(value) => void change(value as SharingGrantLevel)}
      >
        <SelectTrigger size="xs" aria-label="Level">
          <SelectValue>{levelLabel(grant.level)}</SelectValue>
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false}>
          <SelectItem hideIndicator value="view">
            View
          </SelectItem>
          <SelectItem hideIndicator value="collaborate">
            Collaborate
          </SelectItem>
        </SelectPopup>
      </Select>
    </div>
  );
}
