import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const custom = vi.hoisted(() => ({ getBuffer: vi.fn() }));
vi.mock("./completionSound", () => ({ completionSoundManager: custom }));

const audio = { time: 0, buffers: [] as unknown[] };
class FakeAudioContext {
  state = "running";
  destination = {};
  get currentTime() {
    return audio.time;
  }
  async resume() {}
  async decodeAudioData() {
    return { duration: 1, bundled: true };
  }
  createBufferSource() {
    return {
      buffer: null,
      connect() {},
      start() {
        audio.buffers.push(this.buffer);
      },
    };
  }
}

beforeEach(() => {
  vi.resetModules();
  audio.time = 0;
  audio.buffers = [];
  custom.getBuffer.mockReset().mockResolvedValue(null);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(0) })),
  );
});
afterEach(() => vi.unstubAllGlobals());
async function unlocked() {
  const helper = await import("../../threadNotifications");
  helper.unlockNotificationAudio();
  return helper;
}

describe("completion playback integration", () => {
  it("uses custom audio only for completion; input retains its bundled asset", async () => {
    const buffer = { duration: 3, custom: true };
    custom.getBuffer.mockResolvedValue(buffer);
    const helper = await unlocked();
    await helper.playNotificationSound("completion", () => true);
    await helper.playNotificationSound("input", () => true);
    expect(audio.buffers).toEqual([buffer, { duration: 1, bundled: true }]);
    expect(custom.getBuffer).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("lets a preview wait until gesture unlock has resumed the audio context", async () => {
    let finishResume: (() => void) | undefined;
    class SuspendedAudioContext extends FakeAudioContext {
      override state = "suspended";
      override resume() {
        return new Promise<void>((resolve) => {
          finishResume = () => {
            this.state = "running";
            resolve();
          };
        });
      }
    }
    vi.stubGlobal("AudioContext", SuspendedAudioContext);
    const helper = await import("../../threadNotifications");
    const preview = Promise.resolve(helper.unlockNotificationAudio()).then(() =>
      helper.playNotificationSound("completion", () => true),
    );
    await Promise.resolve();
    expect(audio.buffers).toHaveLength(0);
    finishResume?.();
    await preview;
    expect(audio.buffers).toHaveLength(1);
  });
  it("uses the bundled fallback when no custom buffer is available", async () => {
    const helper = await unlocked();
    await helper.playNotificationSound("completion", () => true);
    expect(audio.buffers).toEqual([{ duration: 1, bundled: true }]);
  });
  it("keeps gesture unlock and sound modes authoritative, including cancellation during decode", async () => {
    const helper = await import("../../threadNotifications");
    await helper.playNotificationSound("completion", () => true);
    expect(custom.getBuffer).not.toHaveBeenCalled();
    helper.unlockNotificationAudio();
    for (const mode of ["off", "notifications"] as const) {
      await helper.playNotificationSound("completion", () => helper.hasNotificationSound(mode));
    }
    expect(audio.buffers).toEqual([]);
    let enabled = true;
    custom.getBuffer.mockImplementationOnce(async () => {
      enabled = false;
      return { duration: 2 };
    });
    await helper.playNotificationSound("completion", () => enabled);
    expect(audio.buffers).toEqual([]);
    await helper.playNotificationSound("completion", () => true);
    expect(audio.buffers).toHaveLength(1);
  });
  it("coalesces concurrent completions for the custom duration while allowing input", async () => {
    custom.getBuffer.mockResolvedValue({ duration: 3 });
    const helper = await unlocked();
    await Promise.all(
      Array.from({ length: 4 }, () => helper.playNotificationSound("completion", () => true)),
    );
    expect(audio.buffers).toHaveLength(1);
    audio.time = 1;
    await helper.playNotificationSound("completion", () => true);
    await helper.playNotificationSound("input", () => true);
    expect(audio.buffers).toHaveLength(2);
    audio.time = 3;
    await helper.playNotificationSound("completion", () => true);
    expect(audio.buffers).toHaveLength(3);
  });
  it("shares a burst slot across replacement and reset", async () => {
    const helper = await unlocked();
    custom.getBuffer.mockResolvedValueOnce({ duration: 3 }).mockResolvedValueOnce({ duration: 2 });
    await helper.playNotificationSound("completion", () => true);
    audio.time = 1;
    await helper.playNotificationSound("completion", () => true);
    await helper.playNotificationSound("completion", () => true);
    expect(audio.buffers).toHaveLength(1);
    audio.time = 3;
    await helper.playNotificationSound("completion", () => true);
    expect(audio.buffers).toHaveLength(2);
  });
});
