import type { CSSProperties, ReactNode } from "react";

/**
 * Shared art kit for highlight tiles. A highlight's PR adds its scene beside PeeringTile.tsx and
 * names it in HighlightArt (client-runtime) and HighlightsList's table.
 *
 * The marketing site's paper boats, drawn
 * once as a sprite and reused with <use>. Colours come from --hl-* custom
 * properties set on the tile container (see highlightArtThemeClassName), so
 * one sprite serves both themes. Still images only: nothing here animates.
 */

/** Theme tokens for a tile, as Tailwind arbitrary properties. Put this on the tile container. */
export const highlightArtThemeClassName = [
  // chart paper (light)
  "[--hl-bg:#f4efe4] [--hl-bg2:#ebe3d1] [--hl-region:rgb(18_32_47/4.5%)] [--hl-line:rgb(18_32_47/14%)]",
  "[--hl-sea:#3b8fae] [--hl-dim:#5f6a76] [--hl-ink:#12202f] [--hl-hull:#fbf7ee] [--hl-sail-l:#e5ddc8] [--hl-sail-r:#fbf7ee]",
  "[--hl-ask:#e08a3c] [--hl-receive:#3b8fae] [--hl-reply:#2f7d5b] [--hl-brass:#c9a24d] [--hl-porthole:#12202f]",
  // navy (dark)
  "dark:[--hl-bg:#0a1c30] dark:[--hl-bg2:#102a47] dark:[--hl-region:rgb(223_233_238/5%)] dark:[--hl-line:rgb(223_233_238/14%)]",
  "dark:[--hl-dim:rgb(223_233_238/60%)] dark:[--hl-ink:#dfe9ee] dark:[--hl-hull:#f4efe4] dark:[--hl-sail-l:#cfd9df] dark:[--hl-sail-r:#f4efe4]",
  "dark:[--hl-reply:#6fcf9a]",
].join(" ");

/** The tile's own background: paper or navy with a soft radial lift at the top right. */
export const HIGHLIGHT_ART_BACKGROUND_STYLE: CSSProperties = {
  backgroundColor: "var(--hl-bg)",
  backgroundImage: "radial-gradient(120% 90% at 80% 20%, var(--hl-bg2) 0%, transparent 60%)",
};

const HIGHLIGHT_BOAT_ID = "j5-highlight-boat";
const HIGHLIGHT_CAPTAIN_ID = "j5-highlight-captain";

/**
 * Render once per document (the highlights popover is enough). Every tile's
 * <use> points at these ids.
 */
export function HighlightArtSprite() {
  return (
    <svg aria-hidden className="absolute size-0 overflow-hidden" focusable="false">
      <defs>
        <g id={HIGHLIGHT_BOAT_ID}>
          <polygon
            points="14,30 32,8 32,30"
            fill="var(--hl-sail-l)"
            stroke="var(--hl-ink)"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <polygon
            points="32,8 32,30 50,30"
            fill="var(--hl-sail-r)"
            stroke="var(--hl-ink)"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <polygon
            points="4,30 60,30 50,44 14,44"
            fill="var(--hl-hull)"
            stroke="var(--hl-ink)"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <path d="M8 35h48" stroke="var(--hl-ink)" strokeOpacity="0.25" strokeWidth="1" />
          <circle cx="24" cy="37" r="1.4" fill="var(--hl-porthole)" />
          <circle cx="40" cy="37" r="1.4" fill="var(--hl-porthole)" />
          <path d="M32 8v-7" stroke="var(--hl-ink)" strokeWidth="1.4" />
          <polygon
            points="32,0 45,3.5 32,7"
            fill="var(--hl-pennant-fill)"
            stroke="var(--hl-pennant)"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </g>
        <g id={HIGHLIGHT_CAPTAIN_ID}>
          <polygon
            points="14,30 32,4 32,30"
            fill="var(--hl-sail-l)"
            stroke="var(--hl-ink)"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <polygon
            points="32,4 32,30 50,30"
            fill="var(--hl-sail-r)"
            stroke="var(--hl-ink)"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <polygon
            points="2,30 62,30 51,46 13,46"
            fill="var(--hl-hull)"
            stroke="var(--hl-ink)"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <polygon points="4,33 60,33 58.6,35.5 5.4,35.5" fill="var(--hl-brass)" />
          <path d="M9 40h46" stroke="var(--hl-ink)" strokeOpacity="0.25" strokeWidth="1" />
          <circle cx="24" cy="40.5" r="1.5" fill="var(--hl-porthole)" />
          <circle cx="40" cy="40.5" r="1.5" fill="var(--hl-porthole)" />
          <path
            d="M32 19l1.6 3.3 3.6.5-2.6 2.5.6 3.6-3.2-1.7-3.2 1.7.6-3.6-2.6-2.5 3.6-.5z"
            fill="var(--hl-brass)"
          />
          <path d="M32 4v-7" stroke="var(--hl-ink)" strokeWidth="1.4" />
          <polygon points="32,-4 46,-1.5 41,1 46,3.5 32,3" fill="var(--hl-brass)" />
        </g>
      </defs>
    </svg>
  );
}

type Pennant = "ask" | "receive" | "reply" | "brass";

function pennantStyle(pennant: Pennant): CSSProperties {
  const colour = `var(--hl-${pennant})`;
  return { "--hl-pennant": colour, "--hl-pennant-fill": colour } as CSSProperties;
}

/** One boat, 64 x 52 user units at scale 1, with its deck at y 30 and pennant at y 0. */
export function Boat({
  x,
  y,
  scale = 1,
  pennant = "reply",
  captain = false,
}: {
  x: number;
  y: number;
  scale?: number;
  pennant?: Pennant;
  captain?: boolean;
}) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`} style={pennantStyle(pennant)}>
      <use href={`#${captain ? HIGHLIGHT_CAPTAIN_ID : HIGHLIGHT_BOAT_ID}`} />
    </g>
  );
}

/** A wave line from x0 to x1 at height y, in the sea colour. */
export function Water({
  x0,
  x1,
  y,
  faint = false,
}: {
  x0: number;
  x1: number;
  y: number;
  faint?: boolean;
}) {
  const step = 10;
  let d = `M${x0} ${y} Q ${x0 + step} ${y - 5} ${x0 + 2 * step} ${y}`;
  for (let x = x0 + 4 * step; x <= x1; x += 2 * step) d += ` T ${x} ${y}`;
  return (
    <path
      d={d}
      stroke="var(--hl-sea)"
      strokeOpacity={faint ? 0.3 : 0.5}
      strokeWidth="1.2"
      fill="none"
    />
  );
}

/** A dashed message route between two points, arched through a control point. */
export function Route({ d }: { d: string }) {
  return (
    <path
      d={d}
      stroke="var(--hl-dim)"
      strokeOpacity="0.6"
      strokeWidth="1.2"
      strokeDasharray="3 5"
      fill="none"
    />
  );
}

/** A message in flight. */
export function Message({
  x,
  y,
  kind,
}: {
  x: number;
  y: number;
  kind: "ask" | "receive" | "reply";
}) {
  return <circle cx={x} cy={y} r="4.5" fill={`var(--hl-${kind})`} />;
}

/** A device: the rounded region a boat sits in on the peering page. */
export function Device({
  x,
  y,
  width,
  height,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  return (
    <rect
      x={x}
      y={y}
      width={width}
      height={height}
      rx="10"
      fill="var(--hl-region)"
      stroke="var(--hl-line)"
    />
  );
}

/**
 * The art column of a highlight entry: 150 x 124 CSS px in the 384px popover.
 * The container owns the background; the scene is centred inside it and keeps
 * its aspect, so a taller entry shows more background rather than a stretched scene.
 */
export function HighlightArtTile({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 150 124"
      preserveAspectRatio="xMidYMid meet"
      className="block size-full"
      aria-hidden
      focusable="false"
    >
      {children}
    </svg>
  );
}
