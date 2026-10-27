import type { KnownConnectionAccess } from "@t3tools/client-runtime/j5/sharing";

/**
 * Offered only to an Owner of the server the client opened first (People and access AC30), once
 * they have given their name (AC6). Nothing is offered until it answers, and upstream's gate
 * decides again when it does, so an Owner of a fresh server still gets it. A failed or missing
 * answer offers nothing: it is not an Owner's answer.
 */
export const firstRunSetupOffered = (input: {
  readonly authenticated: boolean;
  readonly settled: boolean;
  readonly access: KnownConnectionAccess;
}) =>
  input.authenticated &&
  input.settled &&
  input.access?.kind === "person" &&
  input.access.owner &&
  input.access.name !== null;
