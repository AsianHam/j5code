import { isOwnerAccess, type KnownConnectionAccess } from "@t3tools/client-runtime/j5/sharing";

/**
 * Whether the setup wizard may be offered: only to an Owner of the server the client opened
 * first, by that server's answer (People and access AC30). Until it answers nothing is offered;
 * upstream's gate decides again when it does, so an Owner of a fresh server still gets it. A
 * server that cannot answer, one from before people, is upstream's to decide.
 */
export const firstRunSetupOffered = (input: {
  readonly authenticated: boolean;
  readonly settled: boolean;
  readonly access: KnownConnectionAccess;
}) => input.authenticated && input.settled && isOwnerAccess(input.access);
