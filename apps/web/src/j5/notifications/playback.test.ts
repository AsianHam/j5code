import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const custom = vi.hoisted(() => ({ getBuffer: vi.fn() }));
vi.mock("./completionSound", () => ({ completionSoundManager: custom }));

const audio = {
  time: 0,
  buffers: [] as unknown[],
  gains: [] as { value: number; setTargetAtTime: ReturnType<typeof vi.fn> }[],
  sources: [] as EventTarget[],
};
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
  createGain() {
    const gain = { value: 1, setTargetAtTime: vi.fn() };
    audio.gains.push(gain);
    return { gain, connect: vi.fn(), disconnect: vi.fn() };
  }
  createBufferSource() {
    const source = Object.assign(new EventTarget(), {
      buffer: null,
      connect() {},
      disconnect() {},
      start() {
        audio.buffers.push(this.buffer);
      },
    });
    audio.sources.push(source);
    return source;
  }
}

beforeEach(() => {
  vi.resetModules();
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
  audio.gains = [];
  audio.sources = [];
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

describe("notification volume playback", () => {
  it("applies the saved level to bundled, custom and input sounds", async () => {
    const volume = await import("./notificationVolume");
    volume.setNotificationVolume(0.25);
    const helper = await unlocked();
    await helper.playNotificationSound("completion", () => true);
    await helper.playNotificationSound("input", () => true);
    audio.time = 2;
    custom.getBuffer.mockResolvedValue({ duration: 3 });
    await helper.playNotificationSound("completion", () => true);
    expect(audio.gains.map((gain) => gain.value)).toEqual([0.25, 0.25, 0.25]);
  });
  it("mutes playback at zero and restores full volume", async () => {
    const volume = await import("./notificationVolume");
    const helper = await unlocked();
    volume.setNotificationVolume(0);
    await helper.playNotificationSound("completion", () => true);
    expect(audio.gains[0]?.value).toBe(0);
    volume.setNotificationVolume(1);
    expect(audio.gains[0]?.setTargetAtTime).toHaveBeenLastCalledWith(1, 0, 0.01);
    audio.time = 2;
    await helper.playNotificationSound("input", () => true);
    expect(audio.gains[1]?.value).toBe(1);
  });
  it("updates active playback and unsubscribes when the sound ends", async () => {
    const volume = await import("./notificationVolume");
    const helper = await unlocked();
    await helper.playNotificationSound("completion", () => true);
    volume.setNotificationVolume(0.4);
    const update = audio.gains[0]?.setTargetAtTime;
    expect(update).toHaveBeenLastCalledWith(0.4, 0, 0.01);
    audio.sources[0]?.dispatchEvent(new Event("ended"));
    volume.setNotificationVolume(0.8);
    expect(update).toHaveBeenCalledTimes(1);
  });
});
