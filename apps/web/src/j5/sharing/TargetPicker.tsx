import type { EnvironmentId } from "@t3tools/contracts";
import type { SharingGrantTarget } from "@t3tools/contracts/j5";
import { useMemo, useRef, useState } from "react";

import { ProjectFavicon } from "../../components/ProjectFavicon";
import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "../../components/ui/autocomplete";
import { useProjects, useThreadShells } from "../../state/entities";
import { formatRelativeTimeLabel } from "../../timestampFormat";

interface PickerItem {
  readonly key: string;
  readonly title: string;
  readonly detail: string;
  readonly target: SharingGrantTarget;
  readonly project: ReturnType<typeof useProjects>[number] | null;
}

// A server can hold thousands of threads; the list shows the first few that match what is typed.
const MOST_SHOWN = 30;

/**
 * Chooses a project or a thread on one server, by typing part of its title. `threadsOnly` is for
 * a join link, which is made for a thread and never for a project.
 */
export function TargetPicker({
  environmentId,
  threadsOnly = false,
  onPick,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadsOnly?: boolean;
  readonly onPick: (target: SharingGrantTarget | null) => void;
  readonly disabled: boolean;
}) {
  const projects = useProjects();
  const threads = useThreadShells();
  const [typed, setTyped] = useState("");
  const [picked, setPicked] = useState(false);
  // Two threads can share a title, so the pick is the row that was under the pointer or cursor.
  const highlighted = useRef<PickerItem | null>(null);

  const items = useMemo(() => {
    const here = projects.filter((project) => project.environmentId === environmentId);
    const byId = new Map(here.map((project) => [project.id, project]));
    const all: PickerItem[] = [
      ...(threadsOnly
        ? []
        : here.map((project) => ({
            key: `project:${project.id}`,
            title: project.title,
            detail: "Project",
            target: { kind: "project" as const, projectId: project.id },
            project,
          }))),
      ...threads
        .filter((thread) => thread.environmentId === environmentId)
        .map((thread) => {
          const project = byId.get(thread.projectId) ?? null;
          return {
            key: `thread:${thread.id}`,
            title: thread.title,
            // Two threads in a project can share a title; when each was last active tells them
            // apart, as it does in the sidebar.
            detail: [
              "Thread",
              ...(project === null ? [] : [project.title]),
              formatRelativeTimeLabel(thread.latestUserMessageAt ?? thread.updatedAt),
            ].join(" · "),
            target: { kind: "thread" as const, threadId: thread.id },
            project,
          };
        }),
    ];
    const query = typed.trim().toLowerCase();
    return (
      query === "" ? all : all.filter((item) => item.title.toLowerCase().includes(query))
    ).slice(0, MOST_SHOWN);
  }, [environmentId, projects, threads, threadsOnly, typed]);

  return (
    <Autocomplete
      items={items}
      itemToStringValue={(item: PickerItem) => item.title}
      mode="none"
      openOnInputClick
      onItemHighlighted={(item) => {
        highlighted.current = item ?? null;
      }}
      value={typed}
      onValueChange={(value, details) => {
        setTyped(value);
        const item = details.reason === "item-press" ? highlighted.current : null;
        setPicked(item != null);
        onPick(item?.target ?? null);
      }}
    >
      <AutocompleteInput
        placeholder={threadsOnly ? "Search threads" : "Search projects and threads"}
        disabled={disabled}
        aria-label={threadsOnly ? "Thread" : "Project or thread"}
      />
      {picked ? null : (
        <AutocompletePopup>
          {items.length === 0 ? (
            <AutocompleteEmpty>Nothing matches "{typed.trim()}".</AutocompleteEmpty>
          ) : (
            <AutocompleteList>
              {items.map((item) => (
                <AutocompleteItem key={item.key} value={item}>
                  {item.project === null ? null : <ProjectFavicon project={item.project} />}
                  <span className="min-w-0 truncate">{item.title}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {item.detail}
                  </span>
                </AutocompleteItem>
              ))}
            </AutocompleteList>
          )}
        </AutocompletePopup>
      )}
    </Autocomplete>
  );
}
