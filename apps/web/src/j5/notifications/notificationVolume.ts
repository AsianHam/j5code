const KEY = "j5:notification-volume";
const listeners = new Set<() => void>();

export function getNotificationVolume() {
  try {
    const raw = window.localStorage.getItem(KEY);
    const value = raw === null || raw.trim() === "" ? 1 : Number(raw);
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 1;
  } catch {
    return 1;
  }
}

export function setNotificationVolume(volume: number) {
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) return;
  window.localStorage.setItem(KEY, String(volume));
  for (const listener of listeners) listener();
}

export function subscribeNotificationVolume(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function connectNotificationSound(source: AudioBufferSourceNode, context: AudioContext) {
  const gain = context.createGain();
  gain.gain.value = getNotificationVolume();
  source.connect(gain);
  gain.connect(context.destination);
  // Long custom previews respond to the slider without restarting playback.
  const unsubscribe = subscribeNotificationVolume(() => {
    gain.gain.setTargetAtTime(getNotificationVolume(), context.currentTime, 0.01);
  });
  source.addEventListener(
    "ended",
    () => {
      unsubscribe();
      source.disconnect();
      gain.disconnect();
    },
    { once: true },
  );
}
