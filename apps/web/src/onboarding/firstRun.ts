import { ensureClientSettingsHydrated, persistClientSettingsUpdate } from "../hooks/useSettings";
import { markAllHighlightsSeen } from "../j5/highlights/seenHighlights";

export async function completeOnboarding(): Promise<void> {
  await ensureClientSettingsHydrated();
  // J5: a new client's highlights are recorded as seen before the flag that shows them.
  markAllHighlightsSeen();
  const onboardingCompletedAt = new Date().toISOString();
  await persistClientSettingsUpdate((current) => ({ ...current, onboardingCompletedAt }));
}
