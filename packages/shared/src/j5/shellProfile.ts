/**
 * The line J5 adds to a shell's startup file so `j5` resolves in new terminals.
 * `scripts/install.sh` writes the same marker; keep the two in step.
 * `j5 uninstall` removes every line that ends with it.
 */
export const J5_PATH_MARKER = "# Added by J5 Code; `j5 uninstall` removes this line.";

/** Startup files an installer may have added the line to (POSIX shells only). */
export function shellProfilePaths(input: {
  readonly home: string;
  readonly zdotdir?: string | undefined;
  readonly xdgConfigHome?: string | undefined;
}): ReadonlyArray<string> {
  return [
    `${input.zdotdir || input.home}/.zshrc`,
    `${input.home}/.bashrc`,
    `${input.home}/.bash_profile`,
    `${input.home}/.bash_login`,
    `${input.home}/.profile`,
    `${input.xdgConfigHome || `${input.home}/.config`}/fish/config.fish`,
  ];
}

export function hasJ5PathLine(contents: string): boolean {
  return contents.split("\n").some((line) => line.endsWith(J5_PATH_MARKER));
}

export function withoutJ5PathLines(contents: string): string {
  return contents
    .split("\n")
    .filter((line) => !line.endsWith(J5_PATH_MARKER))
    .join("\n");
}
