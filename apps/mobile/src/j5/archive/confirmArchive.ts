import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  archiveWithPreflight,
  readArchivePreflight,
} from "@t3tools/client-runtime/j5/archive-flow";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import * as Dialog from "../../components/ui/Dialog";
import { appAtomRegistry } from "../../state/atom-registry";
import { j5Environment } from "../state";
import { presentArchiveWarning } from "./ArchiveWarningSheet";

/**
 * J5's archive preflight (register D13) before every mobile archive door: true when the archive
 * should go ahead. Mobile has no Fleet page yet, so a seat's refusal names where Archive crew is.
 */
export async function confirmJ5Archive(thread: EnvironmentThreadShell): Promise<boolean> {
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const proceed = await archiveWithPreflight({
    threadTitle: thread.title,
    readPreflight: () => readArchivePreflight(j5Environment, appAtomRegistry, threadRef),
    refuseCrewSeat: (crewSeat) =>
      Dialog.alert(
        `${thread.title} is seat ${crewSeat.seat} of Crew ${crewSeat.crewName}`,
        "Crew members are never archived one by one. Retire the whole Crew with Archive crew on the Fleet page in J5 on web or desktop, or message the member instead.",
      ),
    confirm: presentArchiveWarning,
    archive: async () => true,
  });
  return proceed === true;
}
