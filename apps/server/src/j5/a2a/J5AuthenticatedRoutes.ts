import * as Layer from "effect/Layer";

import { machineSenderHttpRouteLayer } from "./MachineSenderHttp.ts";
import { peerHttpRouteLayer } from "./PeerHttp.ts";
import { artifactHttpRouteLayer } from "../artifacts/ArtifactHttp.ts";
import { layer as artifactWorkspaceLayer } from "../artifacts/ArtifactWorkspace.ts";

/**
 * One authenticated J5 route aggregate. New J5 HTTP route layers enter here
 * rather than adding another upstream server composition seam. What a client reads and what a
 * person does from one are not here: those are WebSocket RPCs (`wsRpc.ts`). These routes are
 * what another server, a script or the `j5` CLI calls, and the read of one artifact, whose size
 * keeps it off the socket.
 */
export const j5AuthenticatedRoutesLayer = Layer.mergeAll(
  artifactHttpRouteLayer,
  machineSenderHttpRouteLayer,
  peerHttpRouteLayer,
).pipe(Layer.provide(artifactWorkspaceLayer));
