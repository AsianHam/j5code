import * as Layer from "effect/Layer";

import { machineSenderHttpRouteLayer } from "./MachineSenderHttp.ts";
import { peerHttpRouteLayer } from "./PeerHttp.ts";
import { artifactHttpRouteLayer } from "../artifacts/ArtifactHttp.ts";
import { layer as artifactWorkspaceLayer } from "../artifacts/ArtifactWorkspace.ts";
import { cliPairingHttpRouteLayer } from "../sharing/CliPairingHttp.ts";
import { guestProjectIconRouteLayer } from "../sharing/GuestProjectIcons.ts";
import { linkHttpRouteLayer } from "../sharing/LinkHttp.ts";
import { sessionRenewalRouteLayer } from "../sharing/SessionRenewal.ts";

/**
 * One authenticated J5 route aggregate. New J5 HTTP route layers enter here
 * rather than adding another upstream server composition seam. What a client reads and what a
 * person does from one are not here: those are WebSocket RPCs (`wsRpc.ts`). These routes are
 * what another server, a script or the `j5` CLI calls, and the read of one artifact, whose size
 * keeps it off the socket. Three routes take no sign-in: renewing a session J5 ended
 * (`SessionRenewal.ts`), which trusts the old session's signed token, and describing and joining
 * by a link (`LinkHttp.ts`), which trust the link's token alone.
 */
export const j5AuthenticatedRoutesLayer = Layer.mergeAll(
  artifactHttpRouteLayer,
  machineSenderHttpRouteLayer,
  peerHttpRouteLayer,
  guestProjectIconRouteLayer,
  sessionRenewalRouteLayer,
  linkHttpRouteLayer,
  cliPairingHttpRouteLayer,
).pipe(Layer.provide(artifactWorkspaceLayer));
