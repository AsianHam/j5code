import { artifactPathFromWorkspaceRelativePath } from "@t3tools/client-runtime/j5/artifacts";
import { StackActions } from "@react-navigation/native";

import {
  fileRoutePathSegments,
  resolveWorkspaceRelativeFilePath,
} from "../../features/files/filePath";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { resolveMarkdownLinkPresentation } from "../../lib/markdownLinks";
import type { MarkdownFileContextMenu } from "../../native/SelectableMarkdownText.types";

/** The artifact a chat link names (`artifacts/…` in the thread's workspace), or null. */
export function artifactPathForMarkdownLink(
  href: string,
  workspaceRoot: string | null | undefined,
): string | null {
  const presentation = resolveMarkdownLinkPresentation(href);
  if (presentation.kind !== "file") return null;
  return artifactPathFromWorkspaceRelativePath(
    resolveWorkspaceRelativeFilePath(workspaceRoot, presentation.path),
  );
}

export interface ArtifactLinkContext {
  readonly navigation: {
    readonly dispatch: (action: ReturnType<typeof StackActions.push>) => void;
  };
  readonly environmentId: string;
  readonly threadId: string;
  readonly workspaceRoot: string | null | undefined;
}

/**
 * Opens an `artifacts/…` link in J5's artifact viewer instead of as a workspace file, which
 * isn't there: artifacts live in the server's state, not the repository. False for any other
 * link. A push, so a link from one artifact to another keeps the first one to go back to.
 */
export function openArtifactLink(href: string, context: ArtifactLinkContext): boolean {
  const path = artifactPathForMarkdownLink(href, context.workspaceRoot);
  if (path === null) return false;
  context.navigation.dispatch(
    StackActions.push("ThreadArtifact", {
      environmentId: context.environmentId,
      threadId: context.threadId,
      path: fileRoutePathSegments(path),
    }),
  );
  return true;
}

/** An artifact link's long-press menu: no workspace-file actions, which would find nothing. */
export function artifactLinkContextMenu(
  href: string,
  workspaceRoot: string | null | undefined,
): MarkdownFileContextMenu | undefined {
  const path = artifactPathForMarkdownLink(href, workspaceRoot);
  if (path === null) return undefined;
  return {
    title: `artifacts/${path}`,
    actions: [
      { id: "open-artifact", title: "Open artifact" },
      { id: "copy-artifact-path", title: "Copy path" },
    ],
  };
}

/** Handles the menu above; false when the link isn't an artifact. */
export function onArtifactLinkMenuAction(
  href: string,
  actionId: string,
  context: ArtifactLinkContext,
): boolean {
  const path = artifactPathForMarkdownLink(href, context.workspaceRoot);
  if (path === null) return false;
  if (actionId === "open-artifact") openArtifactLink(href, context);
  else if (actionId === "copy-artifact-path") copyTextWithHaptic(`artifacts/${path}`);
  return true;
}
