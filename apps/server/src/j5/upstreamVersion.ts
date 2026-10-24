/**
 * The T3 Code release the pinned upstream code will ship as. J5 keeps its own version line, so
 * anything upstream keys by its app version (the provider compatibility table's `t3CodeRange`) is
 * looked up with this instead of J5's own `package.json` version. Set it at every upstream advance.
 *
 * Upstream's `package.json` holds its last release, and `main` is already the next one: its
 * nightlies are stamped with the next patch version. A pin on `main` or a nightly tag takes that
 * next version, and a pin on a release tag takes the tag's.
 */
export const J5_UPSTREAM_T3_CODE_VERSION = "0.1.3";
