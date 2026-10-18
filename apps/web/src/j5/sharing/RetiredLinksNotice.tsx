import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useEffect } from "react";

import { toastManager } from "../../components/ui/toast";
import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import { useEnvironments } from "../../state/environments";
import { useConnectionAccess } from "./access";

// Keep an active toast across remounts, including Strict Mode effect replay.
const shown = new Set<EnvironmentId>();

/**
 * Tells an Owner, once per browser, that the share links made before the move to levels stopped
 * working. The server says how many while that is recent enough to matter, and only to an Owner.
 */
function ServerRetiredLinksNotice({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const access = useConnectionAccess(environmentId);
  const navigate = useNavigate();
  const retired = access?.kind === "person" ? access.retiredLinks : null;
  useEffect(() => {
    if (retired === null || retired === 0 || shown.has(environmentId)) return;
    const key = `j5:people:retired-links-notice:v1:${environmentId}`;
    try {
      if (getLocalStorageItem(key, Schema.Boolean)) return;
    } catch {}
    shown.add(environmentId);
    const persistDismissal = () => {
      try {
        setLocalStorageItem(key, true, Schema.Boolean);
      } catch {}
    };
    const dismiss = () => {
      persistDismissal();
      toastManager.close(id);
    };
    const id = toastManager.add({
      title: `Old share links on ${label} stopped working`,
      description: "Share links made before this update no longer work. Make new ones from People.",
      timeout: 0,
      onClose: persistDismissal,
      actionProps: {
        children: "Open People",
        onClick: () => {
          dismiss();
          void navigate({ to: "/settings/people" });
        },
      },
      data: {
        actionLayout: "stacked-end",
        secondaryActionProps: { children: "Dismiss", onClick: dismiss },
        secondaryActionVariant: "ghost",
      },
    });
  }, [environmentId, label, navigate, retired]);
  return null;
}

export function RetiredLinksNotice() {
  const { environments } = useEnvironments();
  return environments.map(({ environmentId, label }) => (
    <ServerRetiredLinksNotice key={environmentId} environmentId={environmentId} label={label} />
  ));
}
