import { useRelativeTimeState } from "../hooks/useRelativeTimeState";

// J5's compact age ("2m", "just now") on upstream's clock. Formatting it inline in render
// freezes: the React Compiler caches the label on the timestamp alone.
export function RelativeAge(props: { readonly timestamp: string | null; readonly fallback: string }) {
  const relative = useRelativeTimeState(props.timestamp);
  return relative.status === "relative" ? relative.value : props.fallback;
}
