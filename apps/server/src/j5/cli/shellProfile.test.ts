import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { J5_PATH_MARKER } from "@t3tools/shared/j5/shellProfile";

import { planShellCleanup, removeAppLinks, removeJ5PathLines } from "./shellProfile.ts";

// A person's home with an installed J5: the installer's link, a profile
// carrying J5's line, and one without.
const makeHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "j5-shell-cleanup-" });
  const baseDir = path.join(home, ".j5code");
  const command = path.join(home, ".local/bin/j5");
  const executable = path.join(baseDir, "runtime/versions/1.0.0/j5");
  yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
  yield* fs.writeFileString(executable, "");
  yield* fs.makeDirectory(path.dirname(command), { recursive: true });
  yield* fs.symlink(executable, command);
  const before = "alias ll='ls -l'\nexport EDITOR=vim\n";
  yield* fs.writeFileString(
    path.join(home, ".zshrc"),
    `${before}export PATH="$PATH:${home}/.local/bin" ${J5_PATH_MARKER}\n`,
  );
  yield* fs.writeFileString(path.join(home, ".bashrc"), before);
  return { home, baseDir, command, before };
});

const plan = (home: string, baseDir: string, folders?: ReadonlyArray<string>) =>
  planShellCleanup(baseDir, folders).pipe(
    Effect.provideService(HostProcess.Environment, { HOME: home }),
  );

it.layer(NodeServices.layer)("j5 uninstall's shell cleanup", (it) => {
  it.effect("takes the installer's link and only J5's line, however uninstall was started", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { home, baseDir, command, before } = yield* makeHome;

      const { profiles, installerLink } = yield* plan(home, baseDir);
      assert.equal(installerLink, command);
      assert.deepStrictEqual(profiles, [path.join(home, ".zshrc")]);

      yield* removeJ5PathLines(profiles);
      assert.equal(yield* fs.readFileString(path.join(home, ".zshrc")), before);
      assert.equal(yield* fs.readFileString(path.join(home, ".bashrc")), before);
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("takes the link the desktop app's install command made", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { home, baseDir, command } = yield* makeHome;
      yield* fs.remove(command);
      yield* fs.symlink(path.join(baseDir, "bin/j5"), command);

      const { profiles, installerLink } = yield* plan(home, baseDir);
      assert.equal(installerLink, command);
      assert.deepStrictEqual(profiles, [path.join(home, ".zshrc")]);
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("leaves another home's j5 and its line alone", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { home } = yield* makeHome;
      // An agent uninstalling its scratch home while the real install stays.
      assert.deepStrictEqual(yield* plan(home, path.join(home, "scratch/.j5code")), {
        profiles: [],
        installerLink: undefined,
        appLinks: [],
      });
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("keeps every other byte of a non-UTF-8 profile, including .profile", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "j5-shell-cleanup-bytes-" });
      const profile = path.join(home, ".profile");
      // "export NAME=Ren\xe9" in latin1, which isn't valid UTF-8.
      const before = Uint8Array.from([...Buffer.from("export NAME=Ren"), 0xe9, 0x0a]);
      const line = Buffer.from(`export PATH="$PATH:${home}/.local/bin" ${J5_PATH_MARKER}\n`);
      yield* fs.writeFile(profile, Uint8Array.from([...before, ...line]));

      // No `j5` is left at all, so the orphaned line goes.
      const { profiles } = yield* plan(home, path.join(home, ".j5code"));
      assert.deepStrictEqual(profiles, [profile]);

      yield* removeJ5PathLines(profiles);
      assert.deepStrictEqual([...(yield* fs.readFile(profile))], [...before]);
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );

  // The app can link into any of four folders; the tests stand in for the
  // absolute ones with folders under the temp home.
  const makeAppFolders = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { home, baseDir } = yield* makeHome;
    const folders = ["brew", "usr-local", "bin"].map((name) => path.join(home, "app", name));
    for (const folder of folders) yield* fs.makeDirectory(folder, { recursive: true });
    const launcher = path.join(baseDir, "bin/j5");
    yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
    yield* fs.writeFileString(launcher, "");
    return { home, baseDir, folders, launcher };
  });

  it.effect("takes the app's link from each folder that points at this home's launcher", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { home, baseDir, folders, launcher } = yield* makeAppFolders;
      for (const folder of folders) yield* fs.symlink(launcher, path.join(folder, "j5"));

      const { appLinks } = yield* plan(home, baseDir, folders);
      assert.deepStrictEqual(
        appLinks,
        folders.map((folder) => path.join(folder, "j5")),
      );
      yield* removeAppLinks(appLinks);
      for (const link of appLinks) assert.isFalse(yield* fs.exists(link));
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("leaves another home's link, and a regular file named j5", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { home, baseDir, folders } = yield* makeAppFolders;
      yield* fs.symlink(path.join(home, "other/.j5code/bin/j5"), path.join(folders[0]!, "j5"));
      yield* fs.writeFileString(path.join(folders[1]!, "j5"), "#!/bin/sh\n");

      assert.deepStrictEqual((yield* plan(home, baseDir, folders)).appLinks, []);
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("reports a folder it can't write to and carries on", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { home, baseDir, folders, launcher } = yield* makeAppFolders;
      for (const folder of folders) yield* fs.symlink(launcher, path.join(folder, "j5"));
      yield* fs.chmod(folders[0]!, 0o555);

      const { appLinks } = yield* plan(home, baseDir, folders);
      const lines: Array<string> = [];
      yield* removeAppLinks(appLinks).pipe(
        Effect.provideService(Console.Console, {
          ...globalThis.console,
          log: (m: string) => void lines.push(m),
        } as Console.Console),
      );
      yield* fs.chmod(folders[0]!, 0o755);

      assert.isTrue(yield* fs.exists(path.join(folders[0]!, "j5")));
      assert.isFalse(yield* fs.exists(path.join(folders[1]!, "j5")));
      assert.include(
        lines.join("\n"),
        `${path.join(folders[0]!, "j5")}; the desktop app's j5 link is left behind`,
      );
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );
});
