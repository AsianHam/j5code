// @effect-diagnostics nodeBuiltinImport:off
import type * as NodeHttp from "node:http";

/**
 * Closes the HTTP connection after each MCP response. A provider client reusing the socket can
 * race Node's idle keep-alive timeout, and a failed POST cannot be retried once a tool may have
 * run. MCP sessions live above HTTP connections, so the next request just opens a fresh one.
 */
export function configureMcpHttpConnections<T extends NodeHttp.Server>(server: T): T {
  server.on("request", (request, response) => {
    if (request.url?.split("?", 1)[0] === "/mcp") {
      response.shouldKeepAlive = false;
    }
  });
  return server;
}
