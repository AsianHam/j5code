import { useEffect, useRef, useState } from "react";

import { getClientSettings } from "../../hooks/useSettings";
import { Button } from "../../components/ui/button";
import { SettingsRow } from "../../components/settings/settingsLayout";
import { searchableSetting } from "../../components/settings/settingsSearch";
import { useScopedSettings } from "../../components/settings/useScopedSettings";
import {
  hasNotificationSound,
  playNotificationSound,
  unlockNotificationAudio,
} from "../../threadNotifications";
import { completionSoundManager, importCompletionSound } from "./completionSound";
import type { CompletionSound } from "./completionSoundStorage";

export function CompletionSoundSettings() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mode = useScopedSettings((settings) => settings.notificationMode);
  const [sound, setSound] = useState<CompletionSound | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // oxlint-disable-next-line t3code/react-effect-budget -- reads the saved sound from browser storage when the row mounts.
  useEffect(() => {
    let active = true;
    void completionSoundManager.read().then(
      (value) => {
        if (active) {
          setSound(value);
          setBusy(false);
        }
      },
      () => {
        if (active) {
          setError("Could not read the saved sound. Restore the default or choose another MP3.");
          setBusy(false);
        }
      },
    );
    return () => {
      active = false;
    };
  }, []);

  async function change(file: File | null) {
    setBusy(true);
    setError(null);
    try {
      if (file) setSound(await importCompletionSound(file));
      else {
        await completionSoundManager.replace(null);
        setSound(null);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the completion sound.");
    }
    setBusy(false);
  }

  return (
    <SettingsRow
      {...searchableSetting("completion-sound")}
      description={
        <span className="block space-y-2">
          <span className="block">
            Choose an MP3 up to 5 MiB and 30 seconds. Saved only in this browser profile or desktop
            installation, for this app address; it does not sync to other devices. Input and
            approval alerts keep their default sound.
          </span>
          <span className="block">
            {sound ? `${sound.name} (${sound.duration.toFixed(1)} seconds)` : "Bundled default"}
          </span>
          {!hasNotificationSound(mode) && (
            <span className="block">
              Enable a notification mode with sound to preview or hear completion alerts.
            </span>
          )}
          {error && (
            <span className="block" role="alert">
              {error}
            </span>
          )}
        </span>
      }
      control={
        <div className="flex w-full flex-col items-start gap-2 sm:w-auto sm:items-end">
          <input
            ref={fileInputRef}
            hidden
            type="file"
            accept=".mp3,audio/mpeg"
            aria-label={sound ? "Replace completion MP3" : "Choose completion MP3"}
            disabled={busy}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void change(file);
            }}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
          >
            {sound ? "Replace MP3" : "Choose MP3"}
          </Button>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !hasNotificationSound(mode)}
              onClick={async () => {
                await unlockNotificationAudio();
                await playNotificationSound("completion", () =>
                  hasNotificationSound(getClientSettings().notificationMode),
                );
              }}
            >
              Preview
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || (!sound && !error)}
              onClick={() => void change(null)}
            >
              Restore default
            </Button>
          </div>
        </div>
      }
    />
  );
}
