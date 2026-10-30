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
 * One authenticated J5 route aggregate, so new J5 HTTP routes add no upstream seam. Client reads
 * and acts are WebSocket RPCs (`wsRpc.ts`); these serve other servers, scripts, the `j5` CLI, and
 * artifact reads too large for the socket. Session renewal (`SessionRenewal.ts`) and link describe
 * and join (`LinkHttp.ts`) need no sign-in: they trust their own tokens.
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
