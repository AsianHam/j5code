import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { toastManager } from "../../components/ui/toast";
import { useEnvironments } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { useConnectionAccess } from "./access";
import { refreshSharing, sharingManage } from "./sharingManage";

// Keep an active toast across remounts, including Strict Mode effect replay. Whether it was seen
// is the server's: once an Owner closes it, it reads as seen on every browser of theirs.
const shown = new Set<EnvironmentId>();

/**
 * Tells an Owner, once, that the share links made before the move to levels stopped working. The
 * server says how many until they mark it seen, and only to an Owner.
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
  const markSeen = useAtomCommand(sharingManage.markRetiredLinksSeen, { reportFailure: false });
  const retired = access?.kind === "person" ? access.retiredLinks : null;
  useEffect(() => {
    if (retired === null || retired === 0 || shown.has(environmentId)) return;
    shown.add(environmentId);
    let seen = false;
    const persistSeen = () => {
      if (seen) return;
      seen = true;
      void markSeen({ environmentId, input: {} }).then(() => refreshSharing(environmentId));
    };
    const dismiss = () => {
      persistSeen();
      toastManager.close(id);
    };
    const id = toastManager.add({
      title: `Old share links on ${label} stopped working`,
      description: "Share links made before this update no longer work. Make new ones from People.",
      timeout: 0,
      onClose: persistSeen,
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
  }, [environmentId, label, markSeen, navigate, retired]);
  return null;
}

export function RetiredLinksNotice() {
  const { environments } = useEnvironments();
  return environments.map(({ environmentId, label }) => (
    <ServerRetiredLinksNotice key={environmentId} environmentId={environmentId} label={label} />
  ));
}
