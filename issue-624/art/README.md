# Highlight art: Peering tile and shared kit

Files, intended for `apps/web/src/j5/highlights/`:

- `HighlightArt.tsx`: the kit. `HighlightArtSprite` (render once, in the popover), `highlightArtThemeClassName` (put on the tile container), `HighlightArtTile` (the 150x124 viewBox), and props: `Boat`, `Device`, `Water`, `Route`, `Message`.
- `PeeringTile.tsx`: the Peering scene, composed from the kit.
- `peering-tile.svg`: the same scene as one standalone SVG, the source of truth for the geometry.
- `peering-tile-preview.png`: both themes, at 2x and at actual size.

## Tile

- 150 x 124 CSS px: the right-hand column of an entry in the 384px popover (`grid-template-columns: 1fr 150px`).
- The container carries the background and the theme vars (`highlightArtThemeClassName`). The SVG fills the container with `preserveAspectRatio="xMidYMid meet"`, so an entry taller than 124px shows more background, never a stretched scene.
- The 22px fade from the text into the tile is a `::before` on the tile: `linear-gradient(90deg, var(--popover) 0, transparent 22px)`.
- Still images only. No animation anywhere in the kit.

## Colours

| token            | light (chart paper)    | dark (navy)               |
| ---------------- | ---------------------- | ------------------------- |
| `--hl-bg`        | `#f4efe4`              | `#0a1c30`                 |
| `--hl-bg2`       | `#ebe3d1`              | `#102a47`                 |
| `--hl-region`    | `rgb(18 32 47 / 4.5%)` | `rgb(223 233 238 / 5%)`   |
| `--hl-line`      | `rgb(18 32 47 / 14%)`  | `rgb(223 233 238 / 14%)`  |
| `--hl-sea`       | `#3b8fae`              | `#3b8fae`                 |
| `--hl-dim`       | `#5f6a76`              | `rgb(223 233 238 / 60%)`  |
| `--hl-ink`       | `#12202f`              | `#dfe9ee`                 |
| `--hl-hull`      | `#fbf7ee`              | `#f4efe4`                 |
| `--hl-sail-l`    | `#e5ddc8`              | `#cfd9df`                 |
| `--hl-sail-r`    | `#fbf7ee`              | `#f4efe4`                 |
| `--hl-ask`       | `#e08a3c`              | `#e08a3c`                 |
| `--hl-receive`   | `#3b8fae`              | `#3b8fae`                 |
| `--hl-reply`     | `#2f7d5b`              | `#6fcf9a`                 |
| `--hl-brass`     | `#c9a24d`              | `#c9a24d`                 |

These are the marketing site's own values (`apps/marketing/src/layouts/Layout.astro` and `Boat.astro`), so the tiles match the pages "Learn more" opens. The portholes stay `#12202f` in both themes, as on the site.

## Usage

```tsx
<HighlightArtSprite />   {/* once, inside the popover */}
...
<div className={cn("relative overflow-hidden", highlightArtThemeClassName)}>
  <PeeringTile />
</div>
```

The sprite ids are `j5-highlight-boat` and `j5-highlight-captain`, prefixed so they cannot collide with anything else in the document.
