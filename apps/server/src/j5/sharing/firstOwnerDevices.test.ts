import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { humanPersonRegistryLayer } from "../a2a/HumanPersonRegistry.ts";
import { gateEnvironmentAuth } from "./AccessGate.ts";
import { peopleLayer as recordsLayer } from "./PairingIntents.ts";
import { People } from "./People.ts";
import * as PersonAccess from "./PersonAccess.ts";

/**
 * The startup link's and the desktop app's devices, paired through upstream's own exchange, as
 * the server composes it (`server.ts`).
 */
const DESKTOP_TOKEN = "desktop-bootstrap-token";
const layer = gateEnvironmentAuth(
  EnvironmentAuth.layer.pipe(
    Layer.provideMerge(recordsLayer),
    Layer.provideMerge(humanPersonRegistryLayer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provideMerge(
      Layer.effect(
        ServerConfig.ServerConfig,
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          return { ...config, desktopBootstrapToken: DESKTOP_TOKEN };
        }),
      ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "j5-first-owner-" }))),
    ),
  ),
).pipe(Layer.provideMerge(NodeServices.layer));

const requestMetadata = { deviceType: "desktop" as const, os: "Linux", browser: "Chrome" };

it.layer(layer)("the first owner's devices", (it) => {
  it.effect("lists the startup link's and the desktop app's devices, and ends them", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const people = yield* People;
      const owner = yield* (yield* PersonAccess.PersonAccess).firstOwner;
      const asker = { sessionId: "session:asker" as never, subject: "desktop-bootstrap" };

      const startup = yield* auth.issueStartupPairingCredential();
      yield* auth.createBrowserSession(startup.credential, requestMetadata);
      yield* auth.exchangeBootstrapCredentialForAccessToken(
        DESKTOP_TOKEN,
        undefined,
        requestMetadata,
      );

      const devicesOf = Effect.gen(function* () {
        const entry = (yield* people.list(asker)).find(
          (candidate) => candidate.personId === owner.personId,
        );
        return entry?.devices ?? [];
      });
      const devices = yield* devicesOf;
      assert.strictEqual(devices.length, 2);

      for (const device of devices) yield* people.revokeDevice(device.sessionId);
      assert.deepStrictEqual(yield* devicesOf, []);
    }),
  );
});
