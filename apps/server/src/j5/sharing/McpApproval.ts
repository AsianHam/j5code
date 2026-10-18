import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as McpOAuth from "../../auth/McpOAuth.ts";
import { Access } from "./Access.ts";

/**
 * The change of the server's Owners an MCP client's approval was checked against, given to the
 * exchange of its code. Upstream's exchange then issues the session through the access gate,
 * which refuses it if the Owners changed since (`Access.issueMcpClient`). An issue with none is
 * refused.
 */
export class McpApprovalGeneration extends Context.Service<McpApprovalGeneration, number>()(
  "t3/j5/sharing/McpApproval/McpApprovalGeneration",
) {}

/**
 * Longer than upstream's code lives, so a code is never forgotten while it can be exchanged; one
 * forgotten early is refused, never let through.
 */
const KEPT_MS = 10 * 60_000;

/**
 * Upstream's MCP sign-in with each approval tied to its code. The generation is read before
 * upstream checks the approval, so a change of Owners after the read, however soon, voids it.
 */
export const layerGatedMcpOAuth = Layer.effect(
  McpOAuth.McpOAuth,
  Effect.gen(function* () {
    const inner = yield* McpOAuth.McpOAuth;
    const access = yield* Access;
    const approved = yield* Ref.make(
      new Map<string, { readonly generation: number; readonly atMs: number }>(),
    );
    return McpOAuth.McpOAuth.of({
      ...inner,
      approve: (input) =>
        Effect.gen(function* () {
          const generation = yield* access.ownersGeneration.pipe(
            Effect.mapError(
              () =>
                new McpOAuth.McpOAuthPageError({
                  description: "The approval could not be checked. Try again.",
                }),
            ),
          );
          const redirect = yield* inner.approve(input);
          const code = new URL(redirect).searchParams.get("code");
          const now = yield* Clock.currentTimeMillis;
          if (code !== null) {
            yield* Ref.update(approved, (current) => {
              const next = new Map(
                Array.from(current).filter(([, entry]) => now - entry.atMs < KEPT_MS),
              );
              next.set(code, { generation, atMs: now });
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
            : exchange.pipe(Effect.provideService(McpApprovalGeneration, entry.generation));
        }),
    });
  }),
);

/** Upstream's MCP sign-in, `upstream`, behind J5's approval check. Needs `Access`. */
export const gateMcpOAuth = <E, R>(upstream: Layer.Layer<McpOAuth.McpOAuth, E, R>) =>
  layerGatedMcpOAuth.pipe(Layer.provide(upstream));
