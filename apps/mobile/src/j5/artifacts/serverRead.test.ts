import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import { useServerRead, visibleRead, type SettledRead } from "./serverRead";

const planRead: SettledRead<string> = {
  resource: "env:project:plan.md",
  refresh: 0,
  load: { status: "ready", value: "# Plan" },
};

describe("which artifact read the screen shows", () => {
  it("shows a settled read for its own resource", () => {
    expect(visibleRead(planRead, "env:project:plan.md", 0)).toEqual({
      load: planRead.load,
      refreshing: false,
    });
  });

  it("keeps the body on screen while the same artifact refreshes", () => {
    expect(visibleRead(planRead, "env:project:plan.md", 1)).toEqual({
      load: planRead.load,
      refreshing: true,
    });
  });

  it("never shows one artifact's body while another one opens", () => {
    expect(visibleRead(planRead, "env:project:spec.md", 0)).toEqual({
      load: { status: "loading" },
      refreshing: false,
    });
  });

  it("retries a failed read as loading, not as the old error", () => {
    const failed: SettledRead<string> = { ...planRead, load: { status: "error", message: "x" } };
    expect(visibleRead(failed, "env:project:plan.md", 1).load).toEqual({ status: "loading" });
  });
});

describe("reading an artifact while the route changes", () => {
  type Deferred = { resolve: (value: string) => void };
  const reads = new Map<string, Deferred>();
  const read = (resource: string) => () =>
    new Promise<string>((resolve) => reads.set(resource, { resolve }));

  let seen: ReturnType<typeof useServerRead<string>> | undefined;
  function Viewer(props: { readonly resource: string }) {
    seen = useServerRead(props.resource, read(props.resource));
    return null;
  }

  it("shows loading for B, not A's body, until B's read settles", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(createElement(Viewer, { resource: "plan.md" }));
    });
    await act(async () => reads.get("plan.md")?.resolve("# Plan"));
    expect(seen?.load).toEqual({ status: "ready", value: "# Plan" });

    await act(async () => renderer?.update(createElement(Viewer, { resource: "spec.md" })));
    expect(seen?.load).toEqual({ status: "loading" });

    await act(async () => reads.get("spec.md")?.resolve("# Spec"));
    expect(seen?.load).toEqual({ status: "ready", value: "# Spec" });

    await act(async () => seen?.refresh());
    expect(seen).toMatchObject({ load: { status: "ready", value: "# Spec" }, refreshing: true });
    await act(async () => renderer?.unmount());
    vi.unstubAllGlobals();
  });
});
