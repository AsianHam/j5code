import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { J5_BRANDING } from "../../../../scripts/lib/j5-branding.ts";

export class DesktopUserDataInitializationError extends Schema.TaggedError<DesktopUserDataInitializationError>()(
  "DesktopUserDataInitializationError",
  {
    operation: Schema.Literals(["inspect", "read", "create-directory", "write"]),
    resourcePath: Schema.String,
    category: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Could not initialize Electron user data during ${this.operation} at ${this.resourcePath} (${this.category}).`;
  }

  static fromFileSystem(
    cause: PlatformError.PlatformError,
    operation: DesktopUserDataInitializationError["operation"],
    resourcePath: string,
  ) {
    return new DesktopUserDataInitializationError({
      operation,
      resourcePath,
      category: cause.reason._tag,
      cause,
    });
  }
}

/**
 * J5 (FORK.md case 25): the profile stays `j5code` / `j5code-dev`, or the older `J5 Code` /
 * `J5 Code (Dev)` directory an install already lives in. Upstream's `t3code-v2` profile and its
 * Windows seeding exist to run two T3 Code versions side by side; J5 never does, and must never
 * read T3 Code's profiles.
 */
export const resolveUserDataPath = Effect.fn("desktop.userData.resolveUserDataPath")(
  function* (input: {
    readonly appDataDirectory: string;
    readonly isDevelopment: boolean;
    readonly platform: NodeJS.Platform;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const names = input.isDevelopment
      ? {
          current: J5_BRANDING.desktop.developmentUserDataDirName,
          legacy: J5_BRANDING.desktop.developmentName,
        }
      : {
          current: J5_BRANDING.desktop.productionUserDataDirName,
          legacy: J5_BRANDING.desktop.baseName,
        };
    const destinationPath = path.join(input.appDataDirectory, names.current);
    const legacyPath = path.join(input.appDataDirectory, names.legacy);
    const legacyExists = yield* fs
      .exists(legacyPath)
      .pipe(
        Effect.mapError((cause) =>
          DesktopUserDataInitializationError.fromFileSystem(cause, "inspect", legacyPath),
        ),
      );
    return legacyExists ? legacyPath : destinationPath;
  },
);
