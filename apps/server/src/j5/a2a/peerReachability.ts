import type * as NodeOS from "node:os";

import { formatHostForUrl, isLoopbackHost, isWildcardHost } from "../../startupAccess.ts";

/**
 * The origins others might reach this server at, for the client's pre-peering check: its bound
 * address, or each non-loopback address (IPv4 only if bound to every IPv4 interface), or none when
 * it listens on loopback only, which the client reads as untestable. The client compares who
 * answers, so a guess that lands on another server is only a miss.
 */
export const peerAddressOrigins = (input: {
  readonly host: string | undefined;
  readonly port: number;
  readonly interfaces: ReturnType<typeof NodeOS.networkInterfaces>;
}): ReadonlyArray<string> => {
  const origin = (host: string) => `http://${formatHostForUrl(host)}:${String(input.port)}`;
  if (isLoopbackHost(input.host)) return [];
  if (input.host !== undefined && !isWildcardHost(input.host)) return [origin(input.host)];
  return Object.values(input.interfaces)
    .flatMap((entries) => entries ?? [])
    .filter((entry) => !entry.internal && !entry.address.startsWith("fe80:"))
    .filter((entry) => input.host !== "0.0.0.0" || entry.family === "IPv4")
    .map((entry) => origin(entry.address));
};
