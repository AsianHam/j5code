import { presentPersonAvatar } from "@t3tools/client-runtime/j5/person-avatar";

import { PROJECT_ICON_COLORS } from "../../projectIconColors";

const SWATCH_BY_COLOR = new Map(
  PROJECT_ICON_COLORS.map((color) => [color.value, color.swatchClassName] as const),
);

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
  const avatar = presentPersonAvatar(name);
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${SIZES[size]} ${avatar === null ? "bg-muted" : SWATCH_BY_COLOR.get(avatar.color)}`}
    >
      {avatar?.initials ?? ""}
    </span>
  );
}
