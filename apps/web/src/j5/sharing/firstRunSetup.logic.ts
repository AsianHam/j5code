import type { KnownConnectionAccess } from "@t3tools/client-runtime/j5/sharing";

/**
 * Whether the setup wizard may be offered: only to an Owner of the server the client opened
 * first, by that server's answer (People and access AC30), and only once they have given their
 * name, which comes first (AC6). Until it answers nothing is offered, and upstream's gate decides
 * again when it does, so an Owner of a fresh server still gets it. An answer that failed, or never
 * came, offers nothing: it is not an Owner's answer.
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
