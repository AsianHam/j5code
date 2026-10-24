export interface CompletionSound {
  readonly name: string;
  readonly bytes: ArrayBuffer;
  readonly duration: number;
}

const STORE = "sounds";
let database: Promise<IDBDatabase> | undefined;

function openDatabase() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("j5code:completion-sound", 1);
    request.addEventListener("upgradeneeded", () => request.result.createObjectStore(STORE));
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
    request.addEventListener("blocked", () =>
      reject(new Error("Sound storage is blocked. Close other J5 Code tabs and try again.")),
    );
  }).catch((error: unknown) => {
    database = undefined;
    throw error;
  }));
}

async function withStore(mode: IDBTransactionMode, use: (store: IDBObjectStore) => IDBRequest) {
  const transaction = (await openDatabase()).transaction(STORE, mode);
  const request = use(transaction.objectStore(STORE));
  await new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error));
    transaction.addEventListener("error", () => reject(transaction.error));
  });
  return request.result as unknown;
}

export const completionSoundStorage = {
  async read(): Promise<CompletionSound | null> {
    const entry = await withStore("readonly", (store) => store.get("completion"));
    if (entry === undefined) return null;
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("bytes" in entry) ||
      !(entry.bytes instanceof ArrayBuffer) ||
      !("name" in entry) ||
      typeof entry.name !== "string" ||
      !("duration" in entry) ||
      typeof entry.duration !== "number"
    )
      throw new Error(
        "Saved completion sound is invalid. Restore the default or choose another MP3.",
      );
    return { bytes: entry.bytes, name: entry.name, duration: entry.duration };
  },
  async write(sound: CompletionSound | null) {
    await withStore("readwrite", (store) =>
      sound ? store.put(sound, "completion") : store.delete("completion"),
    );
  },
};
