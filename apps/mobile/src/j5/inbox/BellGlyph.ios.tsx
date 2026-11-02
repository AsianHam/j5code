import { SymbolView } from "expo-symbols";
import type { ColorValue } from "react-native";
import { withUniwind } from "uniwind";

function Bell(props: { readonly size: number; readonly tintColor?: ColorValue }) {
  return <SymbolView name="bell" size={props.size} tintColor={props.tintColor} type="monochrome" />;
}

export const BellGlyph = withUniwind(Bell);
