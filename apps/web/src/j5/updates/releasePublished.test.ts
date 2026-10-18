import { AtomRegistry } from "effect/reactivity";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { afterAll, afterEach, describe, expect, it, vi } from "vite-plus/test";

import { j5ReleasePublishedAtom } from "./releasePublished";

// FetchHttpClient reads globalThis.fetch once and keeps it, so every test shares this mock.
const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

let checks = 0;
async function settledCheck() {
  // A fresh version per check, so the kept-alive family member is never reused.
  const atom = j5ReleasePublishedAtom(`0.0.50-nightly.20261017.${++checks}`);
  const registry = AtomRegistry.make();
  const unmount = registry.mount(atom);
  try {
    await vi.waitFor(() => {
      const result = registry.get(atom);
      expect(AsyncResult.isInitial(result) || result.waiting).toBe(false);
    });
    return AsyncResult.getOrElse(registry.get(atom), () => false);
  } finally {
    unmount();
    registry.dispose();
  }
}

const release = (fields: { readonly draft: boolean; readonly assets: ReadonlyArray<string> }) =>
  Response.json({ draft: fields.draft, assets: fields.assets.map((name) => ({ name })) });

describe("j5ReleasePublishedAtom", () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("reads J5's GitHub release without tracing headers", async () => {
    fetchMock.mockImplementation(async () =>
      release({ draft: false, assets: ["SHA256SUMS", "t3-0.0.50-linux-x64.tar.gz"] }),
    );

    expect(await settledCheck()).toBe(true);
    const request = new Request(fetchMock.mock.calls[0]?.[0] ?? "", fetchMock.mock.calls[0]?.[1]);
    expect(request.url).toBe(
      `https://api.github.com/repos/Jacksondr5/j5code/releases/tags/v0.0.50-nightly.20261017.${checks}`,
    );
    expect(request.headers.get("traceparent")).toBeNull();
    expect(request.headers.get("b3")).toBeNull();
  });

  it("reports a missing release, a draft, or one without checksums as unpublished", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 404 }));
    expect(await settledCheck()).toBe(false);
    fetchMock.mockImplementation(async () => release({ draft: true, assets: ["SHA256SUMS"] }));
    expect(await settledCheck()).toBe(false);
    fetchMock.mockImplementation(async () =>
      release({ draft: false, assets: ["t3-0.0.50-linux-x64.tar.gz"] }),
    );
    expect(await settledCheck()).toBe(false);
  });
});
