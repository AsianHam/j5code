import { useAtomValue } from "@effect/atom-react";
import { CLI_RELEASE_CHECKSUMS_FILE, CLI_RELEASE_REPOSITORY } from "@t3tools/shared/cliRelease";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { AsyncResult, Atom } from "effect/reactivity";

/**
 * Whether a J5 release can be installed by a server: J5 ships from its GitHub releases, not npm,
 * so upstream's npm check would skip every J5 server. Published means what J5 Release publishes:
 * not a draft, and carrying the checksums file the installers verify against.
 */
export const j5ReleasePublishedAtom = Atom.family((version: string) =>
  Atom.make(
    Effect.gen(function* () {
      const response = yield* HttpClient.get(
        `https://api.github.com/repos/${CLI_RELEASE_REPOSITORY}/releases/tags/v${encodeURIComponent(version)}`,
      );
      if (response.status === 404) return false;
      const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
        Effect.flatMap((ok) => ok.json),
      );
      if (typeof body !== "object" || body === null) return false;
      const release = body as { readonly draft?: unknown; readonly assets?: unknown };
      return (
        release.draft === false &&
        Array.isArray(release.assets) &&
        release.assets.some(
          (asset: unknown) =>
            typeof asset === "object" &&
            asset !== null &&
            (asset as { readonly name?: unknown }).name === CLI_RELEASE_CHECKSUMS_FILE,
        )
      );
    }).pipe(
      // Tracing headers would make the browser send a CORS preflight for a public read.
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.provide(FetchHttpClient.layer),
    ),
  ).pipe(
    Atom.withRefresh("5 minutes"),
    Atom.keepAlive,
    Atom.withLabel(`j5-release-published:${version}`),
  ),
);

const NO_VERSION_ATOM = Atom.make(AsyncResult.success(false)).pipe(
  Atom.withLabel("j5-release-published:none"),
);

export function useJ5ReleasePublished(version: string | null): boolean {
  const result = useAtomValue(version ? j5ReleasePublishedAtom(version) : NO_VERSION_ATOM);
  return AsyncResult.getOrElse(result, () => false);
}
