import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as McpOAuth from "../../auth/McpOAuth.ts";
import { Access, type McpClientApproval } from "./Access.ts";
import { PairingIntents } from "./PairingIntents.ts";
import { PersonAccess } from "./PersonAccess.ts";

/**
 * What an MCP client's approval was checked against, and who gave it, given to the exchange of
 * its code. Upstream's exchange then issues the session through the access gate, which refuses
 * it if the Owners changed since and records it as the approver's (`Access.issueMcpClient`). An
 * issue with none is refused.
 */
export class McpExchangeApproval extends Context.Service<McpExchangeApproval, McpClientApproval>()(
  "t3/j5/sharing/McpApproval/McpExchangeApproval",
) {}

/**
 * Longer than upstream's code lives, so a code is never forgotten while it can be exchanged; one
 * forgotten early is refused, never let through.
 */
const KEPT_MS = 10 * 60_000;

/**
 * Upstream's MCP sign-in with each approval tied to its code. The generation is read before
 * upstream checks the approval, so a change of Owners after the read, however soon, voids it.
 * The approver is read before upstream spends a pairing code: the person the code was made for,
 * or the person whose browser approves.
 */
export const layerGatedMcpOAuth = Layer.effect(
  McpOAuth.McpOAuth,
  Effect.gen(function* () {
    const inner = yield* McpOAuth.McpOAuth;
    const access = yield* Access;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const people = yield* PersonAccess;
    const intents = yield* PairingIntents;
    const approved = yield* Ref.make(
      new Map<string, McpClientApproval & { readonly atMs: number }>(),
    );
    const approverOf = Effect.fn("j5.sharing.mcpApproval.approverOf")(function* (
      input: Parameters<McpOAuth.McpOAuth["Service"]["approve"]>[0],
    ) {
      if (input.decision._tag === "pairing-code") {
        return (yield* intents.intentOf(input.decision.code))?.personId ?? null;
      }
      return yield* auth.authenticateBrowserSession(input.request).pipe(
        Effect.flatMap((session) => people.sessionReach(session)),
        Effect.map((reach) => (reach.kind === "person" ? reach.person.personId : null)),
        // Upstream's approve refuses a browser that is not signed in.
        Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, () => Effect.succeed(null)),
      );
    });
    return McpOAuth.McpOAuth.of({
      ...inner,
      approve: (input) =>
        Effect.gen(function* () {
          const unchecked = () =>
            new McpOAuth.McpOAuthPageError({
              description: "The approval could not be checked. Try again.",
            });
          const generation = yield* access.ownersGeneration.pipe(Effect.mapError(unchecked));
          const approver = yield* approverOf(input).pipe(Effect.mapError(unchecked));
          const redirect = yield* inner.approve(input);
          const code = new URL(redirect).searchParams.get("code");
          const now = yield* Clock.currentTimeMillis;
          if (code !== null) {
            yield* Ref.update(approved, (current) => {
              const next = new Map(
                Array.from(current).filter(([, entry]) => now - entry.atMs < KEPT_MS),
              );
              next.set(code, { generation, approver, atMs: now });
              return next;
            });
          }
          return redirect;
        }),
      exchangeCode: (input) =>
        Effect.gen(function* () {
          const code = input.token.code;
          const entry =
            code === undefined
              ? undefined
              : yield* Ref.modify(approved, (current) => {
                  const found = current.get(code);
                  if (found === undefined) return [undefined, current] as const;
                  const next = new Map(current);
                  next.delete(code);
                  return [found, next] as const;
                });
          const exchange = inner.exchangeCode(input);
          return yield* entry === undefined
            ? exchange
            : exchange.pipe(
                Effect.provideService(McpExchangeApproval, {
                  generation: entry.generation,
                  approver: entry.approver,
                }),
              );
        }),
    });
  }),
);

/**
 * Upstream's MCP sign-in, `upstream`, behind J5's approval check. Needs `Access`, `PersonAccess`
 * and `PairingIntents`.
 */
export const gateMcpOAuth = <E, R>(upstream: Layer.Layer<McpOAuth.McpOAuth, E, R>) =>
  layerGatedMcpOAuth.pipe(Layer.provide(upstream));
