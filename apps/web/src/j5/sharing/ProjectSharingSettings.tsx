import { useAtomValue } from "@effect/atom-react";
import { AuthAccessReadScope, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import type { SharingGrant, SharingPerson } from "@t3tools/contracts/j5";
import { XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { ITEM_ROW_CLASSNAME } from "../../components/settings/itemRows";
import { SettingsRow, SettingsSection } from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
import { toastManager } from "../../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { requestConfirmDialog } from "../../confirmDialog";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { ConfirmNameTag } from "./ConfirmNameTag";
import { j5Sharing } from "./guestAccess";
import { LevelControl } from "./LevelControl";
import { peopleWithGrantOn, removeGrantWarning } from "./people.logic";
import { openSharingDialog } from "./sharingDialogs";
import { peopleQuery, refreshSharing, refusalMessage, sharingManage } from "./sharingManage";

interface SharedProject {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly title: string;
}

/**
 * The Sharing section of a project's settings page (Shared server AC18): who holds a grant on the
 * project, at what level, and the way to share it. A project kept on several servers has one
 * block for each, since each server has its own people.
 */
export function ProjectSharingSettings({
  projects,
}: {
  readonly projects: ReadonlyArray<SharedProject>;
}) {
  return (
    <SettingsSection id="project-sharing" title="Sharing">
      {projects.map((project) => (
        <ProjectSharing
          key={`${project.environmentId}:${project.id}`}
          project={project}
          showServer={projects.length > 1}
        />
      ))}
    </SettingsSection>
  );
}

function ProjectSharing({
  project,
  showServer,
}: {
  readonly project: SharedProject;
  readonly showServer: boolean;
}) {
  const { environmentId } = project;
  const server = useEnvironment(environmentId);
  const isGuest = useAtomValue(j5Sharing.isGuest(environmentId));
  const canRead = useEnvironmentScope(environmentId, AuthAccessReadScope);
  const canManage = useAtomValue(sharingManage.putGrant.permissionAtom(environmentId));
  const people = useEnvironmentQuery(canRead ? peopleQuery(environmentId) : null);
  useEffect(() => {
    if (canRead) refreshSharing(environmentId);
  }, [canRead, environmentId]);
  const target = { kind: "project" as const, projectId: project.id };
  const holders = peopleWithGrantOn(people.data?.people ?? [], target);
  const where = showServer && server !== null ? ` on ${server.label}` : "";

  if (isGuest) return null;
  return (
    <>
      <SettingsRow
        title={`People with access${where}`}
        description={
          !canRead
            ? "This connection cannot see who this project is shared with."
            : people.data === null
              ? (people.error ?? "Reading who this project is shared with…")
              : holders.length === 0
                ? "Only members reach this project."
                : "Each person reaches every thread in this project and its artifacts."
        }
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={!canManage}
            onClick={() => openSharingDialog({ kind: "share", environmentId, target })}
          >
            Share project…
          </Button>
        }
      />
      {holders.map(({ person, grant }) => (
        <HolderRow
          key={person.personId}
          environmentId={environmentId}
          projectTitle={project.title}
          person={person}
          grant={grant}
          canManage={canManage}
        />
      ))}
    </>
  );
}

function HolderRow({
  environmentId,
  projectTitle,
  person,
  grant,
  canManage,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectTitle: string;
  readonly person: SharingPerson;
  readonly grant: SharingGrant;
  readonly canManage: boolean;
}) {
  const name = person.displayName ?? "Unnamed guest";
  const [confirmingName, setConfirmingName] = useState(false);
  const removeGrant = useAtomCommand(sharingManage.removeGrant, { reportFailure: false });

  const remove = async () => {
    const confirmed = await requestConfirmDialog(
      removeGrantWarning(name, projectTitle),
      { variant: "destructive" },
      { confirmLabel: "Stop sharing" },
    );
    if (confirmed !== true) return;
    const result = await removeGrant({
      environmentId,
      input: { personId: person.personId, target: grant.target },
    });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: `Could not stop sharing ${projectTitle}`,
        description: refusalMessage(result),
      });
    }
    refreshSharing(environmentId);
  };

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate text-sm text-foreground">{name}</span>
        {person.nameSelfGiven ? (
          <ConfirmNameTag
            environmentId={environmentId}
            person={person}
            canManage={canManage}
            open={confirmingName}
            onOpenChange={setConfirmingName}
          />
        ) : null}
        <span className="flex-1" />
        <LevelControl
          environmentId={environmentId}
          person={person}
          grant={grant}
          canManage={canManage}
        />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                disabled={!canManage}
                aria-label={`Stop sharing ${projectTitle} with ${name}`}
                onClick={() => void remove()}
              />
            }
          >
            <XIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">Remove</TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
}
