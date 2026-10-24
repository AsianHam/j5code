import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../test/render";
import { createVisibleRefreshHook, useVisibleRefresh } from "./useVisibleRefresh";

// The test page is always visible, so each test overrides the document's own getter.
function stubVisibility(): Disposable & { set: (state: DocumentVisibilityState) => void } {
  let current: DocumentVisibilityState = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => current,
  });
  return {
    set: (state) => {
      current = state;
    },
    [Symbol.dispose]: () => void Reflect.deleteProperty(document, "visibilityState"),
  };
}

const focus = () => act(() => void window.dispatchEvent(new Event("focus")));

it("refreshes on focus and on return, not during a read or while hidden, and stops on unmount", async () => {
  using _timers = fakeTimers();
  vi.setSystemTime(new Date("2026-09-21T12:00:00Z"));
  using visibility = stubVisibility();
  const refresh = vi.fn();
  function Consumer({ pending }: { pending: boolean }) {
    useVisibleRefresh(refresh, !pending);
    return null;
  }
  await using screen = await render(<Consumer pending />, { router: false });
  // A read in flight is left to finish.
  vi.advanceTimersByTime(10_000);
  await focus();
  expect(refresh).not.toHaveBeenCalled();
  await screen.rerender(<Consumer pending={false} />);
  // Time alone refreshes nothing: there is no timer.
  vi.advanceTimersByTime(60_000);
  expect(refresh).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  await focus();
  expect(refresh).toHaveBeenCalledTimes(1);
  // A second focus inside a second is the same return.
  vi.advanceTimersByTime(500);
  await focus();
  expect(refresh).toHaveBeenCalledTimes(1);
  visibility.set("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  vi.advanceTimersByTime(10_000);
  await focus();
  expect(refresh).toHaveBeenCalledTimes(1);
  visibility.set("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  await focus();
  expect(refresh).toHaveBeenCalledTimes(2);
  await screen.unmount();
  vi.advanceTimersByTime(10_000);
  await focus();
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("refreshes when its key changes, including a change that arrived during a read", async () => {
  using _timers = fakeTimers();
  vi.setSystemTime(new Date("2026-09-21T12:00:00Z"));
  using _visibility = stubVisibility();
  const refresh = vi.fn();
  function Consumer({ enabled, turn }: { enabled: boolean; turn: string }) {
    useVisibleRefresh(refresh, enabled, turn);
    return null;
  }
  await using screen = await render(<Consumer enabled turn="idle" />, { router: false });
  vi.advanceTimersByTime(60_000);
  expect(refresh).not.toHaveBeenCalled();
  await focus();
  expect(refresh).toHaveBeenCalledTimes(1);
  await screen.rerender(<Consumer enabled={false} turn="running" />);
  vi.advanceTimersByTime(60_000);
  await focus();
  expect(refresh).toHaveBeenCalledTimes(1);
  await screen.rerender(<Consumer enabled turn="completed" />);
  expect(refresh).toHaveBeenCalledTimes(2);
  // The same key again is no change.
  await screen.rerender(<Consumer enabled turn="completed" />);
  vi.advanceTimersByTime(60_000);
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("shares one focus refresh among factory consumers and keeps per-instance refreshes independent", async () => {
  using _timers = fakeTimers();
  vi.setSystemTime(new Date("2026-09-21T12:00:00Z"));
  using _visibility = stubVisibility();
  const shared = vi.fn();
  const instance = vi.fn();
  const useSharedRefresh = createVisibleRefreshHook(shared);
  function SharedConsumer() {
    useSharedRefresh();
    return null;
  }
  function Consumers({ second }: { second: boolean }) {
    useVisibleRefresh(instance);
    return (
      <div>
        <SharedConsumer key="first" />
        {second ? <SharedConsumer key="second" /> : null}
      </div>
    );
  }
  await using screen = await render(<Consumers second />, { router: false });
  // Neither holds a timer; both wait for focus.
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(7_500);
  expect(shared).not.toHaveBeenCalled();
  expect(instance).not.toHaveBeenCalled();
  // Two consumers, one listener: a focus refreshes once.
  await focus();
  expect(shared).toHaveBeenCalledTimes(1);
  expect(instance).toHaveBeenCalledTimes(1);
  await screen.rerender(<Consumers second={false} />);
  vi.advanceTimersByTime(7_500);
  await focus();
  expect(shared).toHaveBeenCalledTimes(2);
  expect(instance).toHaveBeenCalledTimes(2);
  await screen.unmount();
  expect(vi.getTimerCount()).toBe(0);
  await focus();
  expect(shared).toHaveBeenCalledTimes(2);
});
