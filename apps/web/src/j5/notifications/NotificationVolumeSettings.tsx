import { useState, useSyncExternalStore, type CSSProperties } from "react";

import { SettingResetButton, SettingsRow } from "../../components/settings/settingsLayout";
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
  // Matches upstream's settings sliders (AppearanceSettingsPanel), which draw the fill from these.
  const sliderStyle = {
    "--settings-slider-progress": `${volume * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - volume}rem`,
  } as CSSProperties;
  const save = (next: number) => {
    try {
      setNotificationVolume(next);
      setError(null);
    } catch {
      setError("Could not save notification volume. Allow local storage and try again.");
    }
  };
  return (
    <SettingsRow
      {...searchableSetting("notification-volume")}
      description="Volume for completion, input and approval sounds, including previews. Saved only on this device. Set to 0% to mute."
      status={error ? <span role="alert">{error}</span> : undefined}
      resetAction={
        volume !== 1 ? (
          <SettingResetButton label="notification volume" onClick={() => save(1)} />
        ) : null
      }
      control={
        <div className="flex w-full items-center gap-3 sm:w-52">
          <output
            className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
            htmlFor="notification-volume-slider"
          >
            {percent}%
          </output>
          <input
            aria-label="Notification volume"
            className="settings-slider min-w-0 flex-1"
            id="notification-volume-slider"
            max={100}
            min={0}
            onChange={(event) => save(Number(event.currentTarget.value) / 100)}
            step={1}
            style={sliderStyle}
            type="range"
            value={percent}
          />
        </div>
      }
    />
  );
}
