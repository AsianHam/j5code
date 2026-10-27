import { useSyncExternalStore } from "react";
import type { ReactNode } from "react";

import {
  completeConfirmDialogClose,
  readConfirmDialogState,
  respondToConfirmDialog,
  subscribeConfirmDialogHost,
} from "../confirmDialog";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";

type ConfirmationCopy = {
  readonly title: string;
  readonly description: string | null;
};

export const resolveConfirmDialogActionLabel = (confirmLabel?: string) => confirmLabel ?? "Confirm";

export function resolveConfirmDialogCopy(message: string): ConfirmationCopy {
  const normalizedMessage = message.trim();
  const lines = normalizedMessage.split("\n");
  const questionLineIndex = lines.findIndex((line) => line.trim().endsWith("?"));

  if (questionLineIndex >= 0) {
    const title = lines[questionLineIndex]!.trim();
    const description = lines
      .filter((_, index) => index !== questionLineIndex)
      .join("\n")
      .trim();
    return { title, description: description || null };
  }

  const questionMarkIndex = normalizedMessage.indexOf("?");
  if (questionMarkIndex >= 0) {
    return {
      title: normalizedMessage.slice(0, questionMarkIndex + 1).trim(),
      description: normalizedMessage.slice(questionMarkIndex + 1).trim() || null,
    };
  }

  return {
    title: "Confirm action",
    description: normalizedMessage || "This action requires your confirmation.",
  };
}

export function ConfirmationDescription({
  message,
  content,
}: {
  readonly message: string;
  readonly content?: ReactNode;
}) {
  if (content !== undefined) {
    return content;
  }
  return resolveConfirmDialogCopy(message).description;
}

export function ConfirmDialogHost() {
  const state = useSyncExternalStore(
    subscribeConfirmDialogHost,
    readConfirmDialogState,
    readConfirmDialogState,
  );

  const message = state.status === "idle" ? "" : state.message;
  const copy = resolveConfirmDialogCopy(message);
  const content = state.status === "idle" ? undefined : state.content;
  const description = <ConfirmationDescription content={content} message={message} />;
  const confirmVariant = state.status === "idle" ? "default" : state.variant;
  const confirmLabel =
    state.status === "idle" ? "Confirm" : resolveConfirmDialogActionLabel(state.confirmLabel);
  const onCancel = () => respondToConfirmDialog(false);
  const onConfirm = () => respondToConfirmDialog(true);

  return (
    <AlertDialog
      open={state.status === "confirming"}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      onOpenChangeComplete={(open) => {
        if (!open) completeConfirmDialogClose();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          {content !== undefined ? (
            <AlertDialogDescription render={<div className="text-muted-foreground text-sm" />}>
              {description}
            </AlertDialogDescription>
          ) : copy.description ? (
            <AlertDialogDescription className="whitespace-pre-line">
              {description}
            </AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button variant={confirmVariant} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
