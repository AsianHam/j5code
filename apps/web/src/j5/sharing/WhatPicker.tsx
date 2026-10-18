import type { EnvironmentId } from "@t3tools/contracts";
import type { PersonScope } from "@t3tools/contracts/j5";

import { ProjectFavicon } from "../../components/ProjectFavicon";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { useProjects } from "../../state/entities";

const SERVER = "server";

/**
 * What the People page's Share… shares: the whole server or one of its projects. Threads are
 * shared from the thread itself (People and access AC34).
 */
export function WhatPicker({
  environmentId,
  value,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly value: PersonScope | null;
  readonly onChange: (scope: PersonScope) => void;
}) {
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const selected =
    value === null
      ? ""
      : value.kind === "project"
        ? value.projectId
        : value.kind === "server"
          ? SERVER
          : "";
  const picked = projects.find((project) => project.id === selected) ?? null;
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-foreground">What</span>
      <Select
        value={selected}
        onValueChange={(next) =>
          onChange(
            next === SERVER
              ? { kind: "server" }
              : { kind: "project", projectId: projects.find((project) => project.id === next)!.id },
          )
        }
      >
        <SelectTrigger aria-label="What to share">
          <SelectValue>
            {selected === SERVER
              ? "The whole server"
              : picked === null
                ? "Choose the server or a project"
                : picked.title}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          <SelectItem hideIndicator value={SERVER}>
            The whole server
          </SelectItem>
          {projects.map((project) => (
            <SelectItem hideIndicator key={project.id} value={project.id}>
              <span className="flex min-w-0 items-center gap-2">
                <ProjectFavicon project={project} />
                <span className="min-w-0 truncate">{project.title}</span>
              </span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </label>
  );
}
