import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Shared from "@t3tools/client-runtime/j5/archive-flow";
import { createElement, type ReactNode } from "react";

import { toastManager } from "../../components/ui/toast";
import { readArchivePreflight, type ArchivePreflight } from "./archiveFlowClient";
import { ArchiveWarningContent } from "./ArchiveWarningContent";

export { needsArchiveWarning } from "@t3tools/client-runtime/j5/archive-flow";

export interface ArchiveWarningConfirmation {
  readonly message: string;
  readonly content: ReactNode;
  readonly confirmLabel: "Archive" | "Archive anyway";
}

const toConfirmation = (warning: Shared.ArchiveWarning): ArchiveWarningConfirmation => ({
  message: warning.title,
  confirmLabel: warning.confirmLabel,
  content:
    warning.payload === null
      ? null
      : createElement(ArchiveWarningContent, { payload: warning.payload }),
});

export const formatArchiveWarning = (input: {
  readonly threadTitle: string;
  readonly preflight: ArchivePreflight;
}): ArchiveWarningConfirmation => toConfirmation(Shared.buildArchiveWarning(input));

export function archiveWithPreflight<Result>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly threadTitle: string;
  readonly confirm: (confirmation: ArchiveWarningConfirmation) => Promise<boolean>;
  /** Preserves the existing plain archive preference when no J5 warning is warranted. */
  readonly confirmCleanArchive?: () => Promise<boolean>;
  readonly archive: () => Promise<Result>;
}): Promise<Result | undefined> {
  return Shared.archiveWithPreflight({
    threadTitle: input.threadTitle,
    readPreflight: () => readArchivePreflight(input.threadRef),
    refuseCrewSeat: (crewSeat) =>
      toastManager.add({
        type: "warning",
        title: `${input.threadTitle} is seat ${crewSeat.seat} of Crew ${crewSeat.crewName}`,
        description:
          "Crew members are never archived one by one. Retire the whole Crew with Archive crew on the Fleet page, or message the member instead.",
      }),
    confirm: (warning) => input.confirm(toConfirmation(warning)),
    ...(input.confirmCleanArchive ? { confirmCleanArchive: input.confirmCleanArchive } : {}),
    archive: input.archive,
  });
}
