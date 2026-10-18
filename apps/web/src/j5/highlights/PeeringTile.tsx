import { Boat, Device, HighlightArtTile, Message, Route, Water } from "./HighlightArt";

/**
 * The Peering highlight: two devices, an agent on each, an ask crossing the
 * network and a reply coming back. Same subject as the peering page's first scene.
 */
export function PeeringTile() {
  return (
    <HighlightArtTile>
      <Device x={4} y={12} width={66} height={102} />
      <Device x={80} y={12} width={66} height={102} />
      {/* the network between them */}
      <path
        d="M75 18v90"
        stroke="var(--hl-dim)"
        strokeOpacity="0.45"
        strokeWidth="1.2"
        strokeDasharray="1.5 4"
        strokeLinecap="round"
      />
      <Water x0={8} x1={68} y={94} />
      <Water x0={8} x1={68} y={104} faint />
      <Water x0={84} x1={144} y={94} />
      <Water x0={84} x1={144} y={104} faint />
      <Route d="M37 45 Q 75 2 113 45" />
      <Route d="M113 45 Q 75 24 37 45" />
      <Boat x={8} y={52} scale={0.9} pennant="ask" />
      <Boat x={84} y={52} scale={0.9} pennant="reply" />
      <Message x={62} y={21} kind="ask" />
      <Message x={96} y={36} kind="reply" />
    </HighlightArtTile>
  );
}
