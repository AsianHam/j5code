import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../config.ts";
import { Access } from "./Access.ts";
import { nameDevOwnerAtStartup } from "./devOwnerName.ts";
import { PersonAccess } from "./PersonAccess.ts";
import { accessLayer } from "./test-support/accessHarness.ts";

const firstOwnerName = PersonAccess.use((people) => people.firstOwner).pipe(
  Effect.map((owner) => owner.displayName),
);

// A server's config, as the dev runner starts one or as a released server runs.
const serverConfig = (devUrl: URL | undefined) =>
  Layer.succeed(ServerConfig, { devUrl } as ServerConfig["Service"]);

// A server started with `env`, after `before` ran on its database: a home's earlier life.
const startedWith = (
  env: Record<string, string>,
  before: Effect.Effect<void, never, Access | PersonAccess> = Effect.void,
  server: "dev" | "released" = "dev",
) =>
  Layer.effectDiscard(before).pipe(
    Layer.provideMerge(accessLayer),
    (home) => nameDevOwnerAtStartup.pipe(Layer.provideMerge(home)),
    Layer.provide(serverConfig(server === "dev" ? new URL("http://localhost:5733") : undefined)),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  );

it.effect("names an unnamed first owner with the dev runner's name", () =>
  firstOwnerName.pipe(
    Effect.provide(startedWith({ J5CODE_DEV_OWNER_NAME: "Dev owner" })),
    Effect.map((name) => assert.strictEqual(name, "Dev owner")),
  ),
);

it.effect("keeps a name the first owner already gave", () =>
  firstOwnerName.pipe(
    Effect.provide(
      startedWith(
        { J5CODE_DEV_OWNER_NAME: "Dev owner" },
        Effect.gen(function* () {
          const owner = yield* PersonAccess.use((people) => people.firstOwner);
          yield* Access.use((access) =>
            access.rename({ personId: owner.personId, displayName: "Priya" }),
          );
        }).pipe(Effect.orDie),
      ),
    ),
    Effect.map((name) => assert.strictEqual(name, "Priya")),
  ),
);

it.effect("leaves the first owner unnamed when the name is blank or not set", () =>
  Effect.gen(function* () {
    for (const env of [{ J5CODE_DEV_OWNER_NAME: "  " }, {}]) {
      const name = yield* firstOwnerName.pipe(Effect.provide(startedWith(env)));
      assert.isNull(name);
    }
  }),
);

it.effect("starts with the first owner unnamed when the name is not one a person may have", () =>
  firstOwnerName.pipe(
    Effect.provide(startedWith({ J5CODE_DEV_OWNER_NAME: "[Dev owner]" })),
    Effect.map((name) => assert.isNull(name)),
  ),
);

it.effect("leaves the first owner unnamed on a server not run from the dev runner", () =>
  firstOwnerName.pipe(
    Effect.provide(startedWith({ J5CODE_DEV_OWNER_NAME: "Dev owner" }, Effect.void, "released")),
    Effect.map((name) => assert.isNull(name)),
  ),
);
