import IconBell from "@tabler/icons-react-native/IconBell";
import type { ColorValue } from "react-native";
import { withUniwind } from "uniwind";

// Upstream's symbol set has no plain bell on Android, so the Inbox draws its own.
function Bell(props: { readonly size: number; readonly tintColor?: ColorValue }) {
  return <IconBell size={props.size} color={props.tintColor} strokeWidth={2} />;
}

export const BellGlyph = withUniwind(Bell);
