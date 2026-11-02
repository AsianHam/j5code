import { ProjectIconColor } from "@t3tools/contracts";

/** The project icon's colours, gray aside, so a person's colour sits with the rest of the app. */
const AVATAR_COLORS = ProjectIconColor.literals.filter(
  (color): color is Exclude<ProjectIconColor, "gray"> => color !== "gray",
);

/**
 * A person's avatar where a picture would go (Shared conversations AC16): their initials on a
 * colour picked from their name, so the same name is the same colour on every client. Null for
 * someone with no name yet, drawn as an empty grey circle.
 */
export function presentPersonAvatar(name: string | null) {
  if (name === null) return null;
  let hash = 0;
  for (const char of name.trim().toLowerCase()) hash = (hash * 31 + char.codePointAt(0)!) | 0;
  return {
    initials: initialsOf(name),
    color: AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]!,
  };
}

export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const letters =
    words.length > 1 ? `${words[0]![0]}${words[words.length - 1]![0]}` : (words[0]?.[0] ?? "?");
  return letters.toUpperCase();
}
