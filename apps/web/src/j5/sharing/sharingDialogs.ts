import type { EnvironmentId } from "@t3tools/contracts";
import type { PersonScope } from "@t3tools/contracts/j5";

/**
 * Which of sharing's dialogs is open. They are opened from places that render nothing of their
 * own (the thread menu, the command palette), so one host mounted at the root draws them, as
 * upstream's confirm and custom-snooze dialogs are drawn. This module imports nothing of React or
 * the app's connection runtime, so upstream's menu code can open a dialog without loading either.
 */
export type SharingDialogRequest =
  | {
      /** The one Share dialog (People and access AC34 to AC41). */
      readonly kind: "share";
      readonly environmentId: EnvironmentId;
      /** `null` when opened from the People page: the dialog asks, the server or a project. */
      readonly scope: PersonScope | null;
    }
  | {
      /** A person gives up a level they hold (AC48). */
      readonly kind: "leave";
      readonly environmentId: EnvironmentId;
      readonly scope: PersonScope;
    }
  | {
      /** A person renames themselves, or an Owner renames anyone (AC46). */
      readonly kind: "rename";
      readonly environmentId: EnvironmentId;
      readonly person: {
        readonly personId: string | null;
        readonly name: string | null;
        readonly you: boolean;
      };
    };

interface SharingDialogState {
  readonly request: SharingDialogRequest | null;
  /** Counts openings, so each one mounts a fresh dialog with none of the last one's fields. */
  readonly opening: number;
}

let state: SharingDialogState = { request: null, opening: 0 };
const listeners = new Set<() => void>();

const publish = (next: SharingDialogState) => {
  state = next;
  for (const listener of listeners) listener();
};

export function openSharingDialog(request: SharingDialogRequest) {
  publish({ request, opening: state.opening + 1 });
}

export function closeSharingDialog() {
  if (state.request !== null) publish({ request: null, opening: state.opening });
}

/** For the host that draws the dialogs; everything else opens and closes them. */
export const sharingDialogStore = {
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  read: () => state,
};
