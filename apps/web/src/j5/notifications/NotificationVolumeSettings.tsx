import { useState, useSyncExternalStore } from "react";

import { SettingsRow } from "../../components/settings/settingsLayout";
import { searchableSetting } from "../../components/settings/settingsSearch";
import {
  getNotificationVolume,
  setNotificationVolume,
  subscribeNotificationVolume,
} from "./notificationVolume";

export function NotificationVolumeSettings() {
  const volume = useSyncExternalStore(subscribeNotificationVolume, getNotificationVolume, () => 1);
  const [error, setError] = useState<string | null>(null);
  const percent = Math.round(volume * 100);
  return (
    <SettingsRow
      {...searchableSetting("notification-volume")}
      description="Volume for completion, input and approval sounds, including previews. Saved only on this device. Set to 0% to mute."
      status={error ? <span role="alert">{error}</span> : undefined}
      control={
        <div className="flex w-full items-center gap-3 sm:w-56">
          <input
            className="settings-slider min-w-0 flex-1"
            type="range"
            min={0}
            max={100}
            step={1}
            value={percent}
            aria-label="Notification volume"
            aria-valuetext={`${percent}%`}
            onChange={(event) => {
              try {
                setNotificationVolume(Number(event.currentTarget.value) / 100);
                setError(null);
              } catch {
                setError("Could not save notification volume. Allow local storage and try again.");
              }
            }}
          />
          <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">
            {percent}%
          </span>
        </div>
      }
    />
  );
}
