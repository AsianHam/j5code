import {
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
} from "@t3tools/client-runtime/state/filesystem";
import { getAddProjectInitialQuery } from "@t3tools/client-runtime/operations/projects";
import { appendBrowsePathSegment } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentId } from "@t3tools/contracts";
import { CornerLeftUpIcon, FileTextIcon, FolderIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { useServerConfigs } from "../../state/entities";
import { filesystemEnvironment } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";
import { agentPersonaEnvironment } from "./agentPersonaAtoms";

/** Mirrors the platform mapping the command palette uses for path browsing. */
function browsePlatform(os: string | null | undefined): string {
  return os === "windows" ? "Win32" : os === "darwin" ? "MacIntel" : "Linux";
}

/**
 * Pick a folder, or a YAML file in `file` mode, on the environment's machine, not the
 * browser's, by walking the same server directory listing the add-project flow uses. The chosen
 * path is resolved and absolute, so `~` never reaches the library configuration or an import.
 */
export function AgentFolderPickerDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly mode?: "folder" | "file";
  readonly title: string;
  readonly confirmLabel: string;
  readonly onClose: () => void;
  readonly onSelect: (path: string) => void;
}) {
  const pickFile = props.mode === "file";
  const serverConfig = useServerConfigs().get(props.environmentId);
  const platform = browsePlatform(serverConfig?.environment.platform.os);
  const [pathInput, setPathInput] = useState(() =>
    getAddProjectInitialQuery(serverConfig?.settings.addProjectBaseDirectory),
  );
  // The dialog opens on the add-project base folder, often a whole projects tree; folder mode
  // chooses nothing until the person browses or types, so one click cannot import all of it.
  const [browsed, setBrowsed] = useState(false);
  const browseTo = (path: string) => {
    setBrowsed(true);
    setPathInput(path);
  };
  const browsePath = getFilesystemBrowsePath(pathInput, platform);
  const browseState = useEnvironmentQuery(
    browsePath.directoryPath.length === 0
      ? null
      : filesystemEnvironment.browse({
          environmentId: props.environmentId,
          input: { partialPath: browsePath.directoryPath },
        }),
  );
  const { visibleEntries, exactEntry } = filterFilesystemBrowseEntries(
    browseState.data?.entries ?? [],
    browsePath.filterQuery,
  );
  const listedDirectory = browseState.data?.parentPath ?? null;
  const fileState = useEnvironmentQuery(
    !pickFile || listedDirectory === null
      ? null
      : agentPersonaEnvironment.listImportFiles({
          environmentId: props.environmentId,
          input: { directory: listedDirectory },
        }),
  );
  const files = filterFilesystemBrowseEntries(fileState.data?.files ?? [], browsePath.filterQuery);
  // A typed name that matches a listed entry selects it. Folder mode falls back to the listed
  // directory; file mode needs a file.
  const selection = pickFile
    ? (files.exactEntry?.fullPath ?? null)
    : browsed
      ? (exactEntry?.fullPath ?? listedDirectory)
      : null;
  const error = browseState.error ?? (pickFile ? fileState.error : null);

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>
            {pickFile
              ? `Files on ${props.environmentLabel}. Open folders to browse, then choose a YAML file.`
              : `Folders on ${props.environmentLabel}. Open a folder to browse into it, then choose it.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Input
            value={pathInput}
            aria-label={pickFile ? "File path" : "Folder path"}
            font="mono"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => browseTo(event.target.value)}
          />
          <div
            role="listbox"
            aria-label={pickFile ? "Folders and files" : "Folders"}
            className="max-h-72 overflow-y-auto rounded-md border border-border"
          >
            {browsePath.canBrowseUp && browsePath.parentPath ? (
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                onClick={() => browseTo(browsePath.parentPath!)}
              >
                <CornerLeftUpIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                ..
              </button>
            ) : null}
            {error ? (
              <p className="px-3 py-2 text-sm text-destructive-foreground">{error}</p>
            ) : (browseState.isPending && browseState.data === null) ||
              (fileState.isPending && fileState.data === null) ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">Reading folders…</p>
            ) : visibleEntries.length === 0 && files.visibleEntries.length === 0 ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">
                {pickFile ? "No subfolders or YAML files." : "No subfolders."}
              </p>
            ) : (
              <>
                {visibleEntries.map((entry) => (
                  <button
                    key={entry.fullPath}
                    type="button"
                    role="option"
                    aria-selected={entry.fullPath === selection}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent aria-selected:bg-accent/60"
                    onClick={() =>
                      browseTo(appendBrowsePathSegment(browsePath.directoryPath, entry.name))
                    }
                  >
                    <FolderIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                    <span className="truncate">{entry.name}</span>
                  </button>
                ))}
                {files.visibleEntries.map((entry) => (
                  <button
                    key={entry.fullPath}
                    type="button"
                    role="option"
                    aria-selected={entry.fullPath === selection}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent aria-selected:bg-accent/60"
                    onClick={() => browseTo(`${browsePath.directoryPath}${entry.name}`)}
                  >
                    <FileTextIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                    <span className="truncate">{entry.name}</span>
                  </button>
                ))}
              </>
            )}
          </div>
          <p className="break-all font-mono text-xs text-muted-foreground">
            {selection ?? (pickFile ? "Choose a YAML file." : "Open a folder or enter its path.")}
          </p>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            disabled={selection === null}
            onClick={() => selection && props.onSelect(selection)}
          >
            {props.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
