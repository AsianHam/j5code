import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readServiceEnvironment } from "../../serviceLauncher.ts";
import { SERVICE_ENV_FILE } from "../serviceProtocol.ts";

it.layer(NodeServices.layer)("service.env in a J5 home", (it) => {
  it.effect("cannot move the service to another J5 home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "j5-service-env-" });
      yield* fs.writeFileString(
        path.join(root, SERVICE_ENV_FILE),
        ["J5CODE_HOME=/elsewhere", "j5code_home=/elsewhere", "T3CODE_PORT=1234"].join("\n"),
      );

      assert.deepEqual(
        yield* Effect.promise(() => readServiceEnvironment(root, { J5CODE_HOME: root })),
        { J5CODE_HOME: root, T3CODE_PORT: "1234" },
      );
    }),
  );
});
