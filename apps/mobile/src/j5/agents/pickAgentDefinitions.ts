import { AGENT_PERSONA_IMPORT_MAX_FILES, isAgentPersonaDefinitionFile } from "@t3tools/contracts";
import { prepareAgentPersonaImport } from "@t3tools/client-runtime/j5/agent-personas";

import { beginForegroundHandoff } from "../../lib/foreground-handoff";

/** Native pickers grant access only to the user-selected files or directory. */
export async function pickAgentDefinitions(kind: "folder" | "agent") {
  const endHandoff = beginForegroundHandoff();
  try {
    const { File, Directory } = await import("expo-file-system");
    if (kind === "agent") {
      const { getDocumentAsync } = await import("expo-document-picker");
      // Android names a picked document by its id in the URI; the picker's asset keeps the file name.
      const selection = await getDocumentAsync({ copyToCacheDirectory: true });
      const asset = selection.canceled ? undefined : selection.assets[0];
      if (asset === undefined) return null;
      const file = new File(asset.uri);
      return await prepareAgentPersonaImport([
        { name: asset.name, size: asset.size ?? file.size, text: () => file.text() },
      ]);
    }
    const root = await Directory.pickDirectoryAsync();
    const pending = [{ directory: root, prefix: root.name }];
    const visited = new Set<string>();
    const files: Array<{ name: string; size: number; text: () => Promise<string> }> = [];
    while (pending.length > 0) {
      const entry = pending.pop()!;
      if (visited.has(entry.directory.uri)) continue;
      visited.add(entry.directory.uri);
      if (visited.size > 1000) throw new Error("Select a smaller folder of persona definitions.");
      for (const child of entry.directory.list()) {
        const name = `${entry.prefix}/${child.name}`;
        if (child instanceof Directory) {
          pending.push({ directory: child, prefix: name });
        } else if (isAgentPersonaDefinitionFile(child.name)) {
          files.push({ name, size: child.size, text: () => child.text() });
          if (files.length > AGENT_PERSONA_IMPORT_MAX_FILES)
            throw new Error(
              `Select at most ${AGENT_PERSONA_IMPORT_MAX_FILES} persona definitions at a time.`,
            );
        }
      }
    }
    return await prepareAgentPersonaImport(files);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ERR_FILE_PICKING_CANCELLED" || error.code === "ERR_PICKER_CANCELLED")
    )
      return null;
    throw error;
  } finally {
    endHandoff();
  }
}
