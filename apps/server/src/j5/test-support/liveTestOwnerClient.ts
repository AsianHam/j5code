// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalConsole:off - a standalone client for a test server: two plain HTTP calls, then RPC.
/**
 * Adds a guest to a running live-test server as its owner would, over the same
 * WebSocket requests the People page makes:
 *
 *   node apps/server/src/j5/test-support/liveTestOwnerClient.ts --origin http://127.0.0.1:<server port> \
 *     --token <pairing token> --name <name> (--project <id> | --thread <id>) [--level view|collaborate] \
 *     [--web-origin http://localhost:<web port>]
 *
 * The token is a one-time owner pairing token (`setup-agent-live-test.ts`
 * prints the `pair` command that mints one; the token follows `#token=`). It
 * prints one line of JSON: the person, the grant, and their share link, as the
 * Share dialog would give it, at `--web-origin` (the address a browser opens;
 * `--origin` when left out). `setup-agent-live-test.ts guest` runs this and
 * adds the guards.
 *
 * It is for a disposable test server only: run directly, it acts on whatever
 * server `--origin` names, and the pairing token and the returned link pass on
 * the command line and through stdout.
 */
import {
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@t3tools/contracts";
import {
  J5_SHARING_WS_METHODS,
  J5SharingRpcGroup,
  markedAsShareLink,
  SharingGrantLevel,
  SharingGrantTarget,
} from "@t3tools/contracts/j5";
import { setPairingTokenOnUrl } from "@t3tools/shared/remote";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import * as NodeUtil from "node:util";

/** Exchanges a pairing token for a session and opens the WebSocket the web client uses. */
const ownerConnection = (origin: string, token: string) =>
  Layer.unwrap(
    Effect.promise(async () => {
      const post = async (path: string, init: RequestInit) => {
        const response = await fetch(`${origin}${path}`, { method: "POST", ...init });
        if (!response.ok) throw new Error(`${path} answered ${response.status}`);
        return (await response.json()) as Record<string, string>;
      };
      const session = await post("/oauth/token", {
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token: token,
          subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
          requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        }),
      });
      const { ticket } = await post("/api/auth/websocket-ticket", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const url = new URL("/ws", origin.replace(/^http/, "ws"));
      url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, `${ORCHESTRATION_PROTOCOL_VERSION}`);
      url.searchParams.set("wsTicket", ticket ?? "");
      return RpcClient.layerProtocolSocket().pipe(
        Layer.provide(Socket.layerWebSocket(url.toString())),
        Layer.provide(Socket.layerWebSocketConstructorGlobal),
        Layer.provide(RpcSerialization.layerJson),
      );
    }),
  );

/**
 * The link a member would copy from the Share dialog for a server reached at `webOrigin`:
 * upstream's pairing address for the credential, with J5's mark on it. Without the mark the
 * page takes upstream's pairing path and a guest does not land on what was shared.
 */
export const guestShareLink = (webOrigin: string, credential: string) =>
  markedAsShareLink(setPairingTokenOnUrl(new URL("/pair", webOrigin), credential).toString());

const decodeTarget = Schema.decodeUnknownEffect(SharingGrantTarget);
const decodeLevel = Schema.decodeUnknownEffect(SharingGrantLevel);

/** Makes a guest, gives them one grant, and makes the link that pairs their first device. */
const addGuest = Effect.fn("liveTestOwnerClient.addGuest")(function* (input: {
  readonly name: string;
  readonly target: unknown;
  readonly level: unknown;
  readonly webOrigin: string;
}) {
  // Checked before anyone is made, so a mistyped level leaves no guest behind.
  const target = yield* decodeTarget(input.target);
  const level = yield* decodeLevel(input.level);
  const owner = yield* RpcClient.make(J5SharingRpcGroup);
  const guest = yield* owner[J5_SHARING_WS_METHODS.createGuest]({ displayName: input.name });
  const { personId, displayName } = guest;
  // A refused grant takes the person back out, so their name is free for the next try.
  const link = yield* owner[J5_SHARING_WS_METHODS.putGrant]({ personId, target, level }).pipe(
    Effect.andThen(owner[J5_SHARING_WS_METHODS.createLink]({ personId })),
    Effect.tapError(() => Effect.ignore(owner[J5_SHARING_WS_METHODS.removePerson]({ personId }))),
  );
  const pairingUrl = guestShareLink(input.webOrigin, link.credential);
  return { personId, displayName, target, level, pairingUrl };
});

if (import.meta.main) {
  const text = { type: "string" } as const;
  const { values } = NodeUtil.parseArgs({
    options: {
      origin: text,
      "web-origin": text,
      token: text,
      name: text,
      project: text,
      thread: text,
      level: text,
    },
  });
  const { origin = "", token = "", name = "", project, thread, level = "view" } = values;
  const webOrigin = values["web-origin"] ?? origin;
  const target =
    thread === undefined
      ? { kind: "project", projectId: project }
      : { kind: "thread", threadId: thread };
  Effect.runPromise(
    addGuest({ name, target, level, webOrigin }).pipe(
      Effect.provide(ownerConnection(origin, token)),
      Effect.scoped,
    ),
  ).then(
    (added) => {
      console.log(JSON.stringify(added));
      process.exit(0);
    },
    (cause: unknown) => {
      // A refusal from the server says what was wrong in its message.
      console.error(cause instanceof Error ? cause.message : String(cause));
      process.exit(1);
    },
  );
}
