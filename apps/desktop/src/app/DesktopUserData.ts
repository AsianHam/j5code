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
 * J5 (FORK.md case 25, merge decision #4): the profile stays `j5code` /
 * `j5code-dev`, or the older productName-derived `J5 Code` / `J5 Code (Dev)`
 * directory when an install already lives there. Upstream moved its production
 * profile to `t3code-v2` so a V1 and a V2 T3 Code could run side by side and
 * seeded it from `t3code/Local State` on Windows; J5 never runs two versions
 * at once and must never read T3 Code's profiles, so none of that applies.
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
