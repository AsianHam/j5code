import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { SharingGrantTarget } from "@t3tools/contracts/j5";

/**
 * Which of sharing's dialogs is open. They are opened from places that render nothing of their
 * own (the thread menu, the command palette), so one host mounted at the root draws them, as
 * upstream's confirm and custom-snooze dialogs are drawn. This module imports nothing of React or
 * the app's connection runtime, so upstream's menu code can open a dialog without loading either.
 */
export type SharingDialogRequest =
  | {
      readonly kind: "share";
      readonly environmentId: EnvironmentId;
      /** `null` when opened from a place that names no thread or project: the dialog asks. */
      readonly target: SharingGrantTarget | null;
      /** Someone already on the server who is being given more; no link is made for them. */
      readonly person?: { readonly personId: string; readonly name: string };
    }
  | {
      /** The person the server belongs to sets or changes the name they are known by on it. */
      readonly kind: "owner-name";
      readonly environmentId: EnvironmentId;
    }
  | {
      readonly kind: "join-link";
      readonly environmentId: EnvironmentId;
      /** `null` when opened from the People page: the dialog asks which thread. */
      readonly threadId: ThreadId | null;
    }
  | {
      readonly kind: "rename";
      readonly environmentId: EnvironmentId;
      readonly person: { readonly personId: string; readonly name: string };
    }
  | {
      readonly kind: "device-link";
      readonly environmentId: EnvironmentId;
      readonly person: { readonly personId: string; readonly name: string };
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
