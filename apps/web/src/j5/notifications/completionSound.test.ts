import { describe, expect, it, vi } from "vite-plus/test";

import {
  COMPLETION_SOUND_MAX_BYTES,
  createCompletionSoundManager,
  validateCompletionSound,
} from "./completionSound";
import type { CompletionSound } from "./completionSoundStorage";

function mp3(name = "done.mp3") {
  return new File([new Uint8Array([0x49, 0x44, 0x33, 0, 1])], name, { type: "audio/mpeg" });
}
const decode = async () => ({ duration: 2 });

function storage() {
  let persisted: CompletionSound | null = null;
  return {
    read: vi.fn(async () => structuredClone(persisted)),
    write: vi.fn(async (sound: CompletionSound | null) => {
      persisted = structuredClone(sound);
    }),
  };
}

function context() {
  return { decodeAudioData: vi.fn(async () => ({ duration: 2 })) } as unknown as AudioContext;
}

describe("completion MP3 import", () => {
  it("preserves the actual bytes and decoded metadata", async () => {
    const file = mp3();
    const sound = await validateCompletionSound(file, decode);
    expect(sound).toEqual({ name: "done.mp3", duration: 2, bytes: await file.arrayBuffer() });
  });
  it("accepts MPEG layer III without an ID3 tag", async () => {
    await expect(
      validateCompletionSound(
        new File([new Uint8Array([0xff, 0xfb, 0x90, 0])], "done.MP3"),
        decode,
      ),
    ).resolves.toMatchObject({ duration: 2 });
  });
  it("rejects empty, oversized, wrong-format and undecodable files", async () => {
    await expect(validateCompletionSound(new File([], "empty.mp3"), decode)).rejects.toThrow(
      "non-empty",
    );
    await expect(
      validateCompletionSound(
        new File([new ArrayBuffer(COMPLETION_SOUND_MAX_BYTES + 1)], "big.mp3"),
        decode,
      ),
    ).rejects.toThrow("5 MiB");
    await expect(validateCompletionSound(mp3("done.wav"), decode)).rejects.toThrow("MP3");
    await expect(
      validateCompletionSound(new File(["garbage"], "done.mp3"), decode),
    ).rejects.toThrow("not an MP3");
    await expect(
      validateCompletionSound(mp3(), async () => {
        throw new Error("decode");
      }),
    ).rejects.toThrow("could not be decoded");
  });
  it.each([0, -1, NaN, Infinity, 30.01])("rejects invalid duration %s", async (duration) => {
    await expect(validateCompletionSound(mp3(), async () => ({ duration }))).rejects.toThrow(
      "30 seconds",
    );
  });
});

describe("completion sound lifecycle", () => {
  it("persists bytes across manager reloads and clears the decoded cache on replacement/reset", async () => {
    const disk = storage();
    const manager = createCompletionSoundManager(disk);
    const first = await validateCompletionSound(mp3(), decode);
    await manager.replace(first);
    const audio = context();
    await Promise.all([manager.getBuffer(audio), manager.getBuffer(audio)]);
    expect(audio.decodeAudioData).toHaveBeenCalledTimes(1);
    const reloaded = createCompletionSoundManager(disk);
    expect(await reloaded.read()).toEqual(first);
    await reloaded.getBuffer(audio);
    await manager.replace({ ...first, name: "replacement.mp3" });
    await manager.getBuffer(audio);
    expect(audio.decodeAudioData).toHaveBeenCalledTimes(3);
    await manager.replace(null);
    expect(await manager.getBuffer(audio)).toBeNull();
    expect(await createCompletionSoundManager(disk).read()).toBeNull();
  });
  it("discards a decoded result when the sound is reset during decoding", async () => {
    const disk = storage();
    const manager = createCompletionSoundManager(disk);
    await manager.replace(await validateCompletionSound(mp3(), decode));
    let finish: ((buffer: AudioBuffer) => void) | undefined;
    let started: (() => void) | undefined;
    const decoding = new Promise<void>((resolve) => {
      started = resolve;
    });
    const audio = context();
    vi.mocked(audio.decodeAudioData).mockImplementationOnce(() => {
      started?.();
      return new Promise<AudioBuffer>((resolve) => {
        finish = resolve;
      });
    });
    const pending = manager.getBuffer(audio);
    await decoding;
    await manager.replace(null);
    finish?.({ duration: 2 } as AudioBuffer);
    expect(await pending).toBeNull();
    expect(await manager.getBuffer(audio)).toBeNull();
  });
  it("keeps the previous sound if saving fails", async () => {
    const disk = storage();
    const manager = createCompletionSoundManager(disk);
    const sound = await validateCompletionSound(mp3(), decode);
    await manager.replace(sound);
    disk.write.mockRejectedValueOnce(new Error("quota"));
    await expect(manager.replace(null)).rejects.toThrow("quota");
    expect(await manager.read()).toEqual(sound);
  });
  it("falls back for missing, unreadable or undecodable custom data", async () => {
    const disk = storage();
    const audio = context();
    expect(await createCompletionSoundManager(disk).getBuffer(audio)).toBeNull();
    disk.read.mockRejectedValueOnce(new Error("unavailable"));
    expect(await createCompletionSoundManager(disk).getBuffer(audio)).toBeNull();
    await disk.write(await validateCompletionSound(mp3(), decode));
    vi.mocked(audio.decodeAudioData).mockRejectedValueOnce(new Error("decode"));
    expect(await createCompletionSoundManager(disk).getBuffer(audio)).toBeNull();
  });
});
