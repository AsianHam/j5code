import { useCallback } from "react";

import { ensureClientSettingsHydrated, persistClientSettingsUpdate } from "../hooks/useSettings";
import { markAllHighlightsSeen } from "../j5/highlights/seenHighlights";

export function useCompleteOnboarding(): () => Promise<void> {
  return useCallback(async () => {
    await ensureClientSettingsHydrated();
    // J5: a new client's highlights are recorded as seen before the flag that shows them.
    markAllHighlightsSeen();
    const onboardingCompletedAt = new Date().toISOString();
    await persistClientSettingsUpdate((current) => ({ ...current, onboardingCompletedAt }));
  }, []);
}
