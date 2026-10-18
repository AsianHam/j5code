import type {
  Highlight,
  HighlightArt as HighlightArtName,
} from "@t3tools/client-runtime/j5/highlights";
import { ExternalLinkIcon, XIcon } from "lucide-react";
import { Fragment } from "react";

import { APP_BASE_NAME, APP_VERSION } from "../../branding";
import { Button } from "../../components/ui/button";
import { toastManager } from "../../components/ui/toast";
import { ensureLocalApi } from "../../localApi";
import {
  HIGHLIGHT_ART_BACKGROUND_STYLE,
  HighlightArtSprite,
  highlightArtThemeClassName,
} from "./HighlightArt";
import { PeeringTile } from "./PeeringTile";

const ART: Record<HighlightArtName, () => React.ReactNode> = {
  peering: PeeringTile,
};

function openLearnMore(url: string) {
  ensureLocalApi()
    .shell.openExternal(url)
    .catch(() => toastManager.add({ type: "error", title: "Unable to open the page" }));
}

/** The 150-wide art column; only it carries the art palette, and its edge fades into the text. */
function HighlightTile({ art }: { readonly art: HighlightArtName }) {
  const Scene = ART[art];
  return (
    <div
      className={`relative overflow-hidden before:absolute before:inset-y-0 before:start-0 before:z-1 before:w-5.5 before:bg-linear-to-r before:from-popover before:to-transparent ${highlightArtThemeClassName}`}
      style={HIGHLIGHT_ART_BACKGROUND_STYLE}
    >
      <Scene />
    </div>
  );
}

function HighlightEntry({
  entry,
  onDismiss,
}: {
  readonly entry: Highlight;
  readonly onDismiss: ((id: string) => void) | null;
}) {
  return (
    <section
      aria-label={entry.title}
      className={
        entry.art ? "relative grid min-h-31 grid-cols-[1fr_150px]" : "relative grid grid-cols-1"
      }
    >
      <div className={entry.art ? "py-3.5 ps-3.5 pe-1.5" : "px-3.5 py-3"}>
        <h3 className="text-sm leading-5 font-semibold">{entry.title}</h3>
        <p className="mt-0.5 text-xs leading-4.25 text-muted-foreground">{entry.description}</p>
        {entry.learnMoreUrl ? (
          <Button
            className="mt-2.5"
            onClick={() => openLearnMore(entry.learnMoreUrl!)}
            size="xs"
            variant="outline"
          >
            Learn more
            <ExternalLinkIcon aria-hidden className="ms-0.5 size-3" />
          </Button>
        ) : null}
      </div>
      {entry.art ? <HighlightTile art={entry.art} /> : null}
      {onDismiss ? (
        <Button
          aria-label={`Dismiss ${entry.title}`}
          className="absolute end-2 top-2 z-2"
          onClick={() => onDismiss(entry.id)}
          size="icon-xs"
          variant="ghost-muted"
        >
          <XIcon aria-hidden />
        </Button>
      ) : null}
    </section>
  );
}

/**
 * The list in the highlights popover, newest first. "New in J5 Code" lists the unseen entries
 * with a dismiss on each; "What's new" lists every entry and dismisses nothing.
 */
export function HighlightsList({
  title,
  entries,
  onDismiss,
}: {
  readonly title: string;
  readonly entries: ReadonlyArray<Highlight>;
  readonly onDismiss: ((id: string) => void) | null;
}) {
  return (
    <div className="flex max-h-[min(40rem,calc(var(--available-height)-0.5rem))] min-h-0 flex-col text-xs leading-4">
      <div className="flex shrink-0 items-center justify-between ps-3.5 pe-2.5 pt-2.5 pb-1.5">
        <h2 className="text-sm leading-5 font-medium">{title}</h2>
        <span className="text-2xs text-muted-foreground">
          {APP_BASE_NAME} {APP_VERSION}
        </span>
      </div>
      <HighlightArtSprite />
      <div className="min-h-0 overflow-y-auto">
        {entries.length === 0 ? (
          <p className="px-3.5 pt-1 pb-3.5 text-muted-foreground">Nothing yet.</p>
        ) : (
          entries.map((entry, index) => (
            <Fragment key={entry.id}>
              {index > 0 ? <div className="mx-3.5 h-px bg-border" /> : null}
              <HighlightEntry entry={entry} onDismiss={onDismiss} />
            </Fragment>
          ))
        )}
      </div>
    </div>
  );
}
