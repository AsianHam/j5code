import { FolderArchiveIcon } from "lucide-react";

/** A chat link to `artifacts/…` reads as a project artifact, not a workspace file (case 33). */
export const ARTIFACT_FILE_LINK_CLASS_NAME =
  "border-info/35 bg-info/10 text-info-foreground hover:bg-info/18";

export function ArtifactFileChipContent({ label }: { readonly label: string }) {
  return (
    <>
      <FolderArchiveIcon aria-hidden className="size-[1.17em] shrink-0 opacity-85" />
      <span className="truncate leading-tight">Artifact · {label}</span>
    </>
  );
}
