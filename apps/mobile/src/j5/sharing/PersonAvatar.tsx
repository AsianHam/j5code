import { presentPersonAvatar } from "@t3tools/client-runtime/j5/person-avatar";
import type { ProjectIconColor } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";

// Literal class names, so the style compiler sees each one.
const BACKGROUND: Record<Exclude<ProjectIconColor, "gray">, string> = {
  red: "bg-red-500",
  orange: "bg-orange-500",
  amber: "bg-amber-500",
  yellow: "bg-yellow-500",
  lime: "bg-lime-500",
  green: "bg-green-500",
  emerald: "bg-emerald-500",
  teal: "bg-teal-500",
  cyan: "bg-cyan-500",
  sky: "bg-sky-500",
  blue: "bg-blue-500",
  indigo: "bg-indigo-500",
  violet: "bg-violet-500",
  purple: "bg-purple-500",
  fuchsia: "bg-fuchsia-500",
  pink: "bg-pink-500",
  rose: "bg-rose-500",
};

/** A person's initials on their colour, as web draws it beside their name. */
export function PersonAvatar(props: { readonly name: string | null }) {
  const avatar = presentPersonAvatar(props.name);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className={cn(
        "size-5 items-center justify-center rounded-full",
        avatar === null ? "bg-subtle-strong" : BACKGROUND[avatar.color],
      )}
    >
      {avatar === null ? null : (
        <Text className="font-t3-bold text-3xs text-white">{avatar.initials}</Text>
      )}
    </View>
  );
}
