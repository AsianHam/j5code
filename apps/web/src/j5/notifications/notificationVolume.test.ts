import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  getNotificationVolume,
  setNotificationVolume,
  subscribeNotificationVolume,
} from "./notificationVolume";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          values.set(key, value);
        },
      },
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("defaults to full volume and persists the selected level across reloads", async () => {
  expect(getNotificationVolume()).toBe(1);
  setNotificationVolume(0.37);
  vi.resetModules();
  const reloaded = await import("./notificationVolume");
  expect(reloaded.getNotificationVolume()).toBe(0.37);
});

it.each(["garbage", "NaN", "Infinity", "-0.1", "1.1", "", " "])(
  "ignores invalid stored volume %s",
  (raw) => {
    window.localStorage.setItem("j5:notification-volume", raw);
    expect(getNotificationVolume()).toBe(1);
  },
);

it.each([-1, 2, NaN, Infinity])("rejects invalid updates %s", (value) => {
  setNotificationVolume(0.5);
  setNotificationVolume(value);
  expect(getNotificationVolume()).toBe(0.5);
});

it("notifies this tab, other tabs and storage clears, then unsubscribes", () => {
  const listener = vi.fn();
  const unsubscribe = subscribeNotificationVolume(listener);
  setNotificationVolume(0.2);
  window.dispatchEvent(Object.assign(new Event("storage"), { key: "j5:notification-volume" }));
  window.dispatchEvent(Object.assign(new Event("storage"), { key: "another-setting" }));
  window.dispatchEvent(Object.assign(new Event("storage"), { key: null }));
  expect(listener).toHaveBeenCalledTimes(3);
  unsubscribe();
  setNotificationVolume(1);
  window.dispatchEvent(Object.assign(new Event("storage"), { key: "j5:notification-volume" }));
  expect(listener).toHaveBeenCalledTimes(3);
});

it("keeps playback available when storage cannot be read and reports failed writes", () => {
  vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(getNotificationVolume()).toBe(1);
  vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(() => setNotificationVolume(0.4)).toThrow("blocked");
});
