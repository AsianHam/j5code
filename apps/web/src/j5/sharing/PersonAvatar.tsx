import { PROJECT_ICON_COLORS } from "../../projectIconColors";
import { initialsOf } from "./shareLink.logic";

// The project icon's swatches, gray aside, so a person's colour sits with the rest of the app.
const SWATCHES = PROJECT_ICON_COLORS.filter((color) => color.value !== "gray").map(
  (color) => color.swatchClassName,
);

/** The same name is always the same colour, on every client. */
export function avatarSwatch(name: string): string {
  let hash = 0;
  for (const char of name.trim().toLowerCase()) hash = (hash * 31 + char.codePointAt(0)!) | 0;
  return SWATCHES[Math.abs(hash) % SWATCHES.length]!;
}

const SIZES = {
  xs: "size-5 text-4xs",
  sm: "size-6 text-3xs",
  md: "size-7 text-2xs",
} as const;

/**
 * A person's initials on a coloured circle, where a picture would go (Shared conversations AC16;
 * pictures are on the Later list). Someone with no name yet gets an empty grey circle.
 */
export function PersonAvatar({
  name,
  size,
}: {
  readonly name: string | null;
  readonly size: keyof typeof SIZES;
}) {
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${SIZES[size]} ${name === null ? "bg-muted" : avatarSwatch(name)}`}
    >
      {name === null ? "" : initialsOf(name)}
    </span>
  );
}
