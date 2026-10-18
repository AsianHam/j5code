import type { ConfirmDialogOptions, ConfirmDialogVariant } from "@t3tools/contracts";
import type { ReactNode } from "react";

export interface ConfirmDialogPresentation {
  readonly content?: ReactNode;
  readonly confirmLabel?: string;
}

export type ConfirmDialogState =
  | { readonly status: "idle" }
  | {
      readonly status: "confirming";
      readonly message: string;
      readonly variant: ConfirmDialogVariant;
      readonly content?: ReactNode;
      readonly confirmLabel?: string;
    }
  | {
      readonly status: "closing";
      readonly message: string;
      readonly variant: ConfirmDialogVariant;
      readonly content?: ReactNode;
      readonly confirmLabel?: string;
    };

type PendingConfirmation = {
  readonly message: string;
  readonly variant: ConfirmDialogVariant;
  readonly content?: ReactNode;
  readonly confirmLabel?: string;
  readonly resolve: (confirmed: boolean) => void;
};

const idleState: ConfirmDialogState = { status: "idle" };
let state: ConfirmDialogState = idleState;
let activeConfirmation: PendingConfirmation | null = null;
let queuedConfirmations: PendingConfirmation[] = [];
let registeredHostCount = 0;
const listeners = new Set<() => void>();

function publish(next: ConfirmDialogState): void {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

function resolvePendingConfirmations(confirmed: boolean): void {
  activeConfirmation?.resolve(confirmed);
  for (const confirmation of queuedConfirmations) {
    confirmation.resolve(confirmed);
  }
  activeConfirmation = null;
  queuedConfirmations = [];
}

export function readConfirmDialogState(): ConfirmDialogState {
  return state;
}

export function subscribeConfirmDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function registerConfirmDialogHost(): () => void {
  registeredHostCount += 1;
  let registered = true;

  return () => {
    if (!registered) return;
    registered = false;
    registeredHostCount = Math.max(0, registeredHostCount - 1);

    if (registeredHostCount === 0) {
      resolvePendingConfirmations(false);
      publish(idleState);
    }
  };
}

/**
 * An undefined result means no themed host is currently available.
 */
export function requestConfirmDialog(
  message: string,
  options?: ConfirmDialogOptions,
  presentation?: ConfirmDialogPresentation,
): Promise<boolean> | undefined {
  if (registeredHostCount === 0) return undefined;

  const confirmation = new Promise<boolean>((resolve) => {
    const pending = {
      message,
      variant: options?.variant ?? "default",
      ...(presentation?.content === undefined ? {} : { content: presentation.content }),
      ...(presentation?.confirmLabel === undefined
        ? {}
        : { confirmLabel: presentation.confirmLabel }),
      resolve,
    } satisfies PendingConfirmation;
    if (activeConfirmation || state.status === "closing") {
      queuedConfirmations.push(pending);
      return;
    }

    activeConfirmation = pending;
    publish({
      status: "confirming",
      message,
      variant: pending.variant,
      ...(pending.content === undefined ? {} : { content: pending.content }),
      ...(pending.confirmLabel === undefined ? {} : { confirmLabel: pending.confirmLabel }),
    });
  });

  return confirmation;
}

export function isConfirmDialogActive(): boolean {
  return state.status !== "idle" || activeConfirmation !== null || queuedConfirmations.length > 0;
}

export function respondToConfirmDialog(confirmed: boolean): void {
  if (state.status !== "confirming" || !activeConfirmation) return;

  const confirmation = activeConfirmation;
  activeConfirmation = null;
  confirmation.resolve(confirmed);
  publish({
    status: "closing",
    message: state.message,
    variant: state.variant,
    ...(state.content === undefined ? {} : { content: state.content }),
    ...(state.confirmLabel === undefined ? {} : { confirmLabel: state.confirmLabel }),
  });
}

export function completeConfirmDialogClose(): void {
  if (state.status !== "closing") return;

  const next = queuedConfirmations.shift();
  if (!next) {
    publish(idleState);
    return;
  }

  activeConfirmation = next;
  publish({
    status: "confirming",
    message: next.message,
    variant: next.variant,
    ...(next.content === undefined ? {} : { content: next.content }),
    ...(next.confirmLabel === undefined ? {} : { confirmLabel: next.confirmLabel }),
  });
}

export function resetConfirmDialogForTests(): void {
  resolvePendingConfirmations(false);
  registeredHostCount = 0;
  publish(idleState);
  listeners.clear();
}
