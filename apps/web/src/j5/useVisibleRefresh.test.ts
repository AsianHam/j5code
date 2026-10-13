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

it("lets slow reads finish, pauses when hidden, refreshes on return, and stops on unmount", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-21T12:00:00Z"));
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const window = new EventTarget();
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const refresh = vi.fn();
  function Consumer({ pending }: { pending: boolean }) {
    useVisibleRefresh(refresh, 7_500, !pending);
    return null;
  }
  await act(async () => {
    renderer = create(createElement(Consumer, { pending: true }));
  });
  await act(async () => {
    vi.advanceTimersByTime(10_000);
  });
  expect(refresh).not.toHaveBeenCalled();
  await act(async () => {
    renderer!.update(createElement(Consumer, { pending: false }));
  });
  await act(async () => {
    vi.advanceTimersByTime(7_500);
  });
  expect(refresh).toHaveBeenCalledTimes(1);
  await act(async () => {
    renderer!.update(createElement(Consumer, { pending: true }));
  });
  await act(async () => {
    vi.advanceTimersByTime(10_000);
  });
  expect(refresh).toHaveBeenCalledTimes(1);
  await act(async () => {
    renderer!.update(createElement(Consumer, { pending: false }));
  });
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
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("refreshes idle views on focus and turn changes without polling, including changes during a read", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-21T12:00:00Z"));
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const window = new EventTarget();
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const refresh = vi.fn();
  function Consumer({
    enabled,
    active,
    turn,
  }: {
    enabled: boolean;
    active: boolean;
    turn: string;
  }) {
    useVisibleRefresh(refresh, active ? 7_500 : null, enabled, turn);
    return null;
  }
  const render = async (enabled: boolean, active: boolean, turn = "idle") => {
    await act(async () => {
      const element = createElement(Consumer, { enabled, active, turn });
      if (renderer) renderer.update(element);
      else renderer = create(element);
    });
  };
  await render(true, false);
  await act(async () => {
    vi.advanceTimersByTime(60_000);
  });
  expect(refresh).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(refresh).toHaveBeenCalledTimes(1);
  await render(false, false, "running");
  await act(async () => {
    vi.advanceTimersByTime(60_000);
    window.dispatchEvent(new Event("focus"));
  });
  expect(refresh).toHaveBeenCalledTimes(1);
  await render(true, false, "completed");
  expect(refresh).toHaveBeenCalledTimes(2);
  await render(true, true, "completed");
  await act(async () => {
    vi.advanceTimersByTime(7_500);
  });
  expect(refresh).toHaveBeenCalledTimes(3);
  await render(true, false, "completed");
  await act(async () => {
    vi.advanceTimersByTime(60_000);
  });
  expect(refresh).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});

it("shares one focus refresh, with no timer, among factory consumers and keeps per-instance refreshes independent", async () => {
  vi.useFakeTimers();
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
    useVisibleRefresh(instance, 7_500);
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
  // Only the per-instance refresh holds a timer; the shared one waits for focus.
  expect(vi.getTimerCount()).toBe(1);
  await act(async () => {
    vi.advanceTimersByTime(7_500);
  });
  expect(shared).not.toHaveBeenCalled();
  expect(instance).toHaveBeenCalledTimes(1);
  // Two consumers, one listener: a focus refreshes once.
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(shared).toHaveBeenCalledTimes(1);
  await act(async () => renderer!.update(createElement(Consumers, { second: false })));
  await act(async () => {
    vi.advanceTimersByTime(7_500);
    window.dispatchEvent(new Event("focus"));
  });
  expect(shared).toHaveBeenCalledTimes(2);
  await act(async () => renderer!.unmount());
  renderer = undefined;
  expect(vi.getTimerCount()).toBe(0);
  window.dispatchEvent(new Event("focus"));
  expect(shared).toHaveBeenCalledTimes(2);
});
