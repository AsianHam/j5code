import {
  ARTIFACT_READ_PATH,
  ArtifactContent,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClientRequest, HttpClientResponse } from "effect/http";

import type { PreparedConnection } from "../connection/model.ts";
import { executeJ5Request } from "./http.ts";

/** The artifact an `artifacts/…` workspace link names, or null for any other path. */
export function artifactPathFromWorkspaceRelativePath(
  workspaceRelativePath: string | null,
): string | null {
  if (workspaceRelativePath === null) return null;
  const normalized = workspaceRelativePath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized.startsWith("artifacts/")) return null;
  const artifactPath = normalized.slice("artifacts/".length);
  return artifactPath.length > 0 ? artifactPath : null;
}

/**
 * When the selected artifact's body must be read again. The list carries each file's size and
 * modification time, so a change to the selected file shows up there; a change to any other file
 * refreshes the list but must not re-read this body. The person's Refresh is the one other
 * trigger, because modifiedAt may be null and a same-size rewrite is invisible to the size.
 */
export const artifactPreviewRevision = (
  entry: { readonly modifiedAt: string | null; readonly byteLength: number } | undefined,
  manualRefreshes: number,
): string => `${entry?.modifiedAt ?? ""}:${entry?.byteLength ?? ""}:${manualRefreshes}`;

export const ARTIFACT_MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set(["md", "markdown", "mdx"]);
export const ARTIFACT_IMAGE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

export const artifactExtension = (path: string) => path.split(".").at(-1)?.toLowerCase() ?? "";

export type ArtifactPreviewKind = "image" | "html" | "markdown" | "text" | "binary";

/** How a client shows an artifact; a non-image body that isn't UTF-8 has no preview. */
export function artifactPreviewKind(
  content: Pick<ArtifactContent, "path" | "encoding">,
): ArtifactPreviewKind {
  const extension = artifactExtension(content.path);
  if (ARTIFACT_IMAGE_MEDIA_TYPES[extension] !== undefined) return "image";
  if (content.encoding !== "utf8") return "binary";
  if (extension === "html" || extension === "htm") return "html";
  if (ARTIFACT_MARKDOWN_EXTENSIONS.has(extension)) return "markdown";
  return "text";
}

export function artifactDataUrl(content: ArtifactContent) {
  const mediaType =
    ARTIFACT_IMAGE_MEDIA_TYPES[artifactExtension(content.path)] ?? "application/octet-stream";
  if (content.encoding === "base64") return `data:${mediaType};base64,${content.content}`;
  return `data:${mediaType};charset=utf-8,${encodeURIComponent(content.content)}`;
}

export class ArtifactHttpError extends Schema.TaggedError<ArtifactHttpError>()(
  "ArtifactHttpError",
  { status: Schema.Number, detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * One artifact's content can be megabytes, so it stays an HTTP read while the list is an RPC. The
 * shared J5 request helper resolves the credential at request time and refreshes a rejected relay
 * token once; a token captured at page load would 401 on T3 Connect once it expired.
 */
export const readArtifact = Effect.fn("j5.artifacts.client.read")(function* (
  prepared: PreparedConnection | null,
  input: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly path: string;
  },
) {
  if (prepared === null) {
    return yield* new ArtifactHttpError({
      status: 0,
      detail: "The project environment is not connected.",
    });
  }
  const request = yield* HttpClientRequest.post(ARTIFACT_READ_PATH).pipe(
    HttpClientRequest.bodyJson({ projectId: input.projectId, path: input.path }),
  );
  const response = yield* executeJ5Request(prepared, request, REQUEST_TIMEOUT_MS).pipe(
    Effect.mapError((error) =>
      error._tag === "J5HttpError"
        ? new ArtifactHttpError({ status: error.status, detail: error.detail })
        : new ArtifactHttpError({ status: 0, detail: String(error) }),
    ),
  );
  return yield* HttpClientResponse.schemaBodyJson(ArtifactContent)(response);
});
