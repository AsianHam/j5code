import { completionSoundStorage, type CompletionSound } from "./completionSoundStorage";

export const COMPLETION_SOUND_MAX_BYTES = 5 * 1024 * 1024;
export const COMPLETION_SOUND_MAX_SECONDS = 30;

export async function validateCompletionSound(
  file: File,
  decode: (bytes: ArrayBuffer) => Promise<{ readonly duration: number }>,
): Promise<CompletionSound> {
  if (!/\.mp3$/i.test(file.name)) throw new Error("Choose an MP3 file.");
  if (file.size === 0 || file.size > COMPLETION_SOUND_MAX_BYTES)
    throw new Error("Choose a non-empty MP3 no larger than 5 MiB.");
  const bytes = await file.arrayBuffer();
  const header = new Uint8Array(bytes);
  const id3 = header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33;
  const frame =
    header[0] === 0xff &&
    header[1] !== undefined &&
    (header[1] & 0xe0) === 0xe0 &&
    (header[1] & 0x18) !== 0x08 &&
    (header[1] & 0x06) === 0x02;
  if (!id3 && !frame) throw new Error("This file is not an MP3.");
  let decoded;
  try {
    decoded = await decode(bytes.slice(0));
  } catch {
    throw new Error("This MP3 could not be decoded. Choose another file.");
  }
  if (
    !Number.isFinite(decoded.duration) ||
    decoded.duration <= 0 ||
    decoded.duration > COMPLETION_SOUND_MAX_SECONDS
  )
    throw new Error("Choose an MP3 that is at most 30 seconds long.");
  return { name: file.name, bytes, duration: decoded.duration };
}

export function createCompletionSoundManager(storage: typeof completionSoundStorage) {
  let revision = 0;
  let saved: Promise<CompletionSound | null> | undefined;
  let cached:
    | {
        readonly sound: CompletionSound;
        readonly context: AudioContext;
        readonly buffer: Promise<AudioBuffer>;
      }
    | undefined;
  const read = () =>
    (saved ??= storage.read().catch((error: unknown) => {
      saved = undefined;
      throw error;
    }));
  return {
    read,
    async replace(sound: CompletionSound | null) {
      await storage.write(sound);
      revision += 1;
      saved = Promise.resolve(sound);
      cached = undefined;
    },
    async getBuffer(context: AudioContext) {
      try {
        const requestedRevision = revision;
        const sound = await read();
        if (!sound || requestedRevision !== revision) return null;
        if (cached?.sound !== sound || cached.context !== context) {
          cached = { sound, context, buffer: context.decodeAudioData(sound.bytes.slice(0)) };
        }
        const buffer = await cached.buffer;
        // A reset or replacement during decode must not play the superseded sound.
        return requestedRevision === revision ? buffer : null;
      } catch {
        // Storage can be cleared or decoding support can change between visits.
        return null;
      }
    },
  };
}

export const completionSoundManager = createCompletionSoundManager(completionSoundStorage);

export async function importCompletionSound(file: File) {
  const context = new AudioContext();
  try {
    const sound = await validateCompletionSound(file, (bytes) => context.decodeAudioData(bytes));
    await completionSoundManager.replace(sound);
    return sound;
  } finally {
    await context.close();
  }
}
