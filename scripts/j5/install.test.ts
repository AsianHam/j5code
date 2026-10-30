// @effect-diagnostics nodeBuiltinImport:off - Drives the real shell installer through a PTY and a gated HTTP fixture.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { J5_PATH_MARKER } from "@t3tools/shared/j5/shellProfile";
import { describe, expect, it } from "vite-plus/test";

// J5's installer: its home, the `j5` link and the PATH line (FORK.md cases 25, 40, 50, 52).
const INSTALLER = NodePath.resolve(import.meta.dirname, "..", "install.sh");

// J5 publishes Linux archives for x64 only; the installer refuses other architectures.
describe.skipIf(
  HostProcess.Platform.defaultValue() !== "linux" ||
    HostProcess.Architecture.defaultValue() !== "x64",
)("installer terminal", () => {
  // Releases before the rename ship the executable as `t3`; the installer links whichever is there.
  it.each([
    { fail: false, executable: "j5" },
    { fail: true, executable: "j5" },
    { fail: false, executable: "t3" },
  ])(
    "preserves download and install behavior (HTTP failure: $fail, executable: $executable)",
    async ({ fail, executable }) => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-progress-"));
      const version = "1.2.3";
      const stem = `t3-${version}-linux-${HostProcess.Architecture.defaultValue()}`;
      const archiveName = `${stem}.tar.gz`;
      let resumeDownload: (() => void) | undefined;
      let sawPartialProgress = false;
      let output = "";
      await NodeFSP.mkdir(NodePath.join(root, stem));
      await NodeFSP.writeFile(
        NodePath.join(root, stem, executable),
        `#!/bin/sh\necho '${executable} v1.2.3'\n`,
        { mode: 0o755 },
      );
      await NodeFSP.writeFile(
        NodePath.join(root, stem, "payload"),
        NodeCrypto.randomBytes(64 * 1024),
      );
      NodeChildProcess.execFileSync("tar", [
        "-czf",
        NodePath.join(root, archiveName),
        "-C",
        root,
        stem,
      ]);
      const archive = await NodeFSP.readFile(NodePath.join(root, archiveName));
      const checksum = NodeCrypto.createHash("sha256").update(archive).digest("hex");
      const server = NodeHttp.createServer((request, response) => {
        if (request.url?.endsWith("/SHA256SUMS")) {
          response.end(`${checksum}  ${archiveName}\n`);
        } else if (fail) {
          response.writeHead(500).end();
        } else {
          response.writeHead(200, { "Content-Length": archive.length });
          resumeDownload = () => response.end(archive.subarray(Math.floor(archive.length / 2)));
          response.write(archive.subarray(0, Math.floor(archive.length / 2)));
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      const installer = INSTALLER.replaceAll("'", "'\\''");
      // The installer edits the shell's startup file, so give it a scratch home and shell.
      const userHome = NodePath.join(root, "user");
      await NodeFSP.mkdir(userHome);
      await NodeFSP.writeFile(NodePath.join(userHome, ".bashrc"), "alias ll='ls -l'");
      const child = NodeChildProcess.spawn("script", ["-qec", `sh '${installer}'`, "/dev/null"], {
        env: {
          ...process.env,
          HOME: userHome,
          SHELL: "/bin/bash",
          TERM: "xterm",
          NO_COLOR: "1",
          T3CODE_VERSION: version,
          J5CODE_HOME: NodePath.join(root, "home"),
          // T3 Code's home variable must never steer a J5 install (FORK.md case 25).
          T3CODE_HOME: NodePath.join(root, "t3-home"),
          T3CODE_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
          T3CODE_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const collect = (chunk: Buffer) => {
        output += chunk.toString();
        if (!sawPartialProgress && /\b[1-9]\d?%/.test(output)) {
          sawPartialProgress = true;
          resumeDownload?.();
        }
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          child.on("error", reject);
          child.on("close", resolve);
        });
        const versions = NodePath.join(root, "home/runtime/versions");
        if (fail) {
          expect(code).not.toBe(0);
          expect(output).toContain("500");
          expect(output).not.toContain("100%");
          expect(output).not.toContain("Installed J5 Code");
          expect(await NodeFSP.readdir(versions)).toEqual([]);
        } else {
          expect(code).toBe(0);
          expect(sawPartialProgress).toBe(true);
          expect(output).toContain("100%");
          expect(output).toContain("0.1 / 0.1 MB");
          expect(output).toContain("Installed J5 Code 1.2.3");
          expect(
            await NodeFSP.readFile(NodePath.join(versions, version, ".install-complete"), "utf8"),
          ).toBe("1.2.3\n");
          expect(
            NodeChildProcess.execFileSync(NodePath.join(root, "bin/j5"), ["--version"], {
              encoding: "utf8",
            }).trim(),
          ).toBe(`${executable} v1.2.3`);
          expect(await NodeFSP.readlink(NodePath.join(root, "bin/j5"))).toBe(
            NodePath.join(versions, version, executable),
          );
          expect(await NodeFSP.readdir(versions)).toEqual([version]);
          expect(await NodeFSP.readdir(NodePath.join(root, "bin"))).toEqual(["j5"]);
          // Pruning keeps the runtime the recorded `j5` launcher points at.
          expect(
            await NodeFSP.readFile(NodePath.join(root, "home/runtime/launchers"), "utf8"),
          ).toBe(`${await NodeFSP.realpath(NodePath.join(root, "bin"))}/j5\n`);
          expect(await NodeFSP.readFile(NodePath.join(userHome, ".bashrc"), "utf8")).toBe(
            `alias ll='ls -l'\nexport PATH="$PATH:${NodePath.join(root, "bin")}" ${J5_PATH_MARKER}\n`,
          );
          expect(output).toContain(`in ${NodePath.join(userHome, ".bashrc")}`);
        }
        await expect(NodeFSP.access(NodePath.join(root, "t3-home"))).rejects.toThrow();
      } finally {
        if (child.exitCode === null) child.kill();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    },
  );
});

// J5: the PATH step, run against an already-downloaded version so nothing is fetched.
describe.skipIf(
  HostProcess.Platform.defaultValue() !== "linux" ||
    HostProcess.Architecture.defaultValue() !== "x64",
)("installer PATH line", () => {
  const runInstaller = async (
    configure: (paths: { readonly home: string; readonly bin: string }) => Promise<void>,
    environment: (paths: { readonly home: string }) => Record<string, string>,
  ) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j5-install-path-"));
    const home = NodePath.join(root, "user");
    const bin = NodePath.join(root, "bin");
    const versionDir = NodePath.join(root, "j5home/runtime/versions/1.2.3");
    await NodeFSP.mkdir(home);
    await NodeFSP.mkdir(versionDir, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(versionDir, "j5"), "#!/bin/sh\n", { mode: 0o755 });
    await NodeFSP.writeFile(NodePath.join(versionDir, ".install-complete"), "1.2.3\n");
    await configure({ home, bin });
    const output = NodeChildProcess.execFileSync("sh", [INSTALLER], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: "/usr/bin:/bin",
        HOME: home,
        T3CODE_VERSION: "1.2.3",
        J5CODE_HOME: NodePath.join(root, "j5home"),
        T3CODE_INSTALL_BIN_DIR: bin,
        ...environment({ home }),
      },
    });
    return { root, home, bin, output };
  };

  it("falls back to the hint when the profile can't be written", async () => {
    const { root, home, bin, output } = await runInstaller(
      async ({ home }) => {
        await NodeFSP.writeFile(NodePath.join(home, ".bashrc"), "alias ll='ls -l'\n", {
          mode: 0o444,
        });
      },
      () => ({ SHELL: "/bin/bash" }),
    );
    try {
      expect(output).toContain(`Add ${bin} to your PATH`);
      expect(await NodeFSP.readFile(NodePath.join(home, ".bashrc"), "utf8")).toBe(
        "alias ll='ls -l'\n",
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("writes fish's line under XDG_CONFIG_HOME, scoped to the shell's PATH", async () => {
    const { root, bin, output } = await runInstaller(
      async () => {},
      ({ home }) => ({ SHELL: "/usr/bin/fish", XDG_CONFIG_HOME: NodePath.join(home, "xdg") }),
    );
    try {
      const config = NodePath.join(root, "user/xdg/fish/config.fish");
      expect(await NodeFSP.readFile(config, "utf8")).toBe(
        `fish_add_path --path --append "${bin}" ${J5_PATH_MARKER}\n`,
      );
      expect(output).toContain(`in ${config}`);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("leaves startup files alone when asked to", async () => {
    const { root, home, bin, output } = await runInstaller(
      async ({ home }) => {
        await NodeFSP.writeFile(NodePath.join(home, ".zshrc"), "alias ll='ls -l'\n");
      },
      () => ({ SHELL: "/bin/zsh", J5CODE_NO_MODIFY_PATH: "1" }),
    );
    try {
      expect(output).toContain(`Add ${bin} to your PATH`);
      expect(await NodeFSP.readFile(NodePath.join(home, ".zshrc"), "utf8")).toBe(
        "alias ll='ls -l'\n",
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("prints the hint for a directory the shell would expand in the line", async () => {
    const { root, home, output } = await runInstaller(
      async ({ home }) => {
        await NodeFSP.writeFile(NodePath.join(home, ".zshrc"), "alias ll='ls -l'\n");
      },
      ({ home }) => ({
        SHELL: "/bin/zsh",
        T3CODE_INSTALL_BIN_DIR: NodePath.join(home, "cli$tools"),
      }),
    );
    try {
      expect(output).toContain(`Add ${NodePath.join(home, "cli$tools")} to your PATH`);
      expect(await NodeFSP.readFile(NodePath.join(home, ".zshrc"), "utf8")).toBe(
        "alias ll='ls -l'\n",
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
