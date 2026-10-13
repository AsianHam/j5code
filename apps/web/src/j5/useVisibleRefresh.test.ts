import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { createVisibleRefreshHook, useVisibleRefresh } from "./useVisibleRefresh";

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("refreshes on focus and on return, not during a read or while hidden, and stops on unmount", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-21T12:00:00Z"));
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const window = new EventTarget();
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const refresh = vi.fn();
  function Consumer({ pending }: { pending: boolean }) {
    useVisibleRefresh(refresh, !pending);
    return null;
  }
  const focusAfter = async (ms: number) => {
    await act(async () => {
      vi.advanceTimersByTime(ms);
      window.dispatchEvent(new Event("focus"));
    });
  };
  await act(async () => {
    renderer = create(createElement(Consumer, { pending: true }));
  });
  // A read in flight is left to finish.
  await focusAfter(10_000);
  expect(refresh).not.toHaveBeenCalled();
  await act(async () => {
    renderer!.update(createElement(Consumer, { pending: false }));
  });
  // Time alone refreshes nothing: there is no timer.
  await act(async () => {
    vi.advanceTimersByTime(60_000);
  });
  expect(refresh).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  await focusAfter(0);
  expect(refresh).toHaveBeenCalledTimes(1);
  // A second focus inside a second is the same return.
  await focusAfter(500);
  expect(refresh).toHaveBeenCalledTimes(1);
  document.visibilityState = "hidden";
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(10_000);
    window.dispatchEvent(new Event("focus"));
  });
  expect(refresh).toHaveBeenCalledTimes(1);
  document.visibilityState = "visible";
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
  expect(refresh).toHaveBeenCalledTimes(2);
  await act(async () => renderer!.unmount());
  renderer = undefined;
  vi.advanceTimersByTime(10_000);
  window.dispatchEvent(new Event("focus"));
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("refreshes when its key changes, including a change that arrived during a read", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-21T12:00:00Z"));
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const window = new EventTarget();
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const refresh = vi.fn();
  function Consumer({ enabled, turn }: { enabled: boolean; turn: string }) {
    useVisibleRefresh(refresh, enabled, turn);
    return null;
  }
  const render = async (enabled: boolean, turn = "idle") => {
    await act(async () => {
      const element = createElement(Consumer, { enabled, turn });
      if (renderer) renderer.update(element);
      else renderer = create(element);
    });
  };
  await render(true);
  await act(async () => {
    vi.advanceTimersByTime(60_000);
  });
  expect(refresh).not.toHaveBeenCalled();
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(refresh).toHaveBeenCalledTimes(1);
  await render(false, "running");
  await act(async () => {
    vi.advanceTimersByTime(60_000);
    window.dispatchEvent(new Event("focus"));
  });
  expect(refresh).toHaveBeenCalledTimes(1);
  await render(true, "completed");
  expect(refresh).toHaveBeenCalledTimes(2);
  // The same key again is no change.
  await render(true, "completed");
  await act(async () => {
    vi.advanceTimersByTime(60_000);
  });
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("shares one focus refresh among factory consumers and keeps per-instance refreshes independent", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-21T12:00:00Z"));
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const shared = vi.fn();
  const instance = vi.fn();
  const useSharedRefresh = createVisibleRefreshHook(shared);
  function SharedConsumer() {
    useSharedRefresh();
    return null;
  }
  function Consumers({ second }: { second: boolean }) {
    useVisibleRefresh(instance);
    return createElement(
      "div",
      null,
      createElement(SharedConsumer, { key: "first" }),
      second ? createElement(SharedConsumer, { key: "second" }) : null,
    );
  }
  await act(async () => {
    renderer = create(createElement(Consumers, { second: true }));
  });
  // Neither holds a timer; both wait for focus.
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => {
    vi.advanceTimersByTime(7_500);
  });
  expect(shared).not.toHaveBeenCalled();
  expect(instance).not.toHaveBeenCalled();
  // Two consumers, one listener: a focus refreshes once.
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(shared).toHaveBeenCalledTimes(1);
  expect(instance).toHaveBeenCalledTimes(1);
  await act(async () => renderer!.update(createElement(Consumers, { second: false })));
  await act(async () => {
    vi.advanceTimersByTime(7_500);
    window.dispatchEvent(new Event("focus"));
  });
  expect(shared).toHaveBeenCalledTimes(2);
  expect(instance).toHaveBeenCalledTimes(2);
  await act(async () => renderer!.unmount());
  renderer = undefined;
  expect(vi.getTimerCount()).toBe(0);
  window.dispatchEvent(new Event("focus"));
  expect(shared).toHaveBeenCalledTimes(2);
});
