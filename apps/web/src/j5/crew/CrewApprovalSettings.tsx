import {
  SettingsRow,
  SettingsSection,
  SettingResetButton,
} from "../../components/settings/settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "../../components/settings/useScopedSettings";
import { Switch } from "../../components/ui/switch";

export function CrewApprovalSettings() {
  const settings = useScopedSettings();
  const mixed = useScopedSettingsMixed(["crewAutoApprove"]);
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsSection title="Crews" id="crews">
      <SettingsRow
        id="crew-auto-approve"
        title="Auto-approve new Crews"
        description="Launch the Captain's proposed roster without asking you first. Captains can always add members to their running Crews. Each member's access still controls tool approvals."
        serverScoped
        settingKeys={["crewAutoApprove"]}
        mixed={mixed}
        resetAction={
          settings.crewAutoApprove ? (
            <SettingResetButton
              label="Crew auto-approval"
              tooltip="Reset Crew auto-approval to off"
              onClick={() => updateSettings({ crewAutoApprove: false })}
            />
          ) : null
        }
        control={
          <Switch
            aria-label="Auto-approve new Crews"
            mixed={mixed}
            checked={!mixed && settings.crewAutoApprove}
            onCheckedChange={(enabled) => updateSettings({ crewAutoApprove: enabled })}
          />
        }
      />
    </SettingsSection>
  );
}
