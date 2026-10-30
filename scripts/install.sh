#!/bin/sh
# Installs the J5 Code CLI from a GitHub Release archive. Needs only sh, tar,
# sha256sum or shasum, and curl or wget; no Node, npm, or compiler.
#
#   curl -fsSL https://github.com/Jacksondr5/j5code/releases/latest/download/install.sh | sh
#
# J5 publishes archives for macOS (Apple silicon) and Linux x64. The archive's
# executable is `j5`; releases before the rename named it `t3`.
#
# Environment:
#   T3CODE_CHANNEL           release train to follow: stable, nightly, or preview
#                            (default: stable; preview is a maintainers' test train)
#   T3CODE_VERSION           exact version to install (overrides T3CODE_CHANNEL)
#   J5CODE_HOME              J5 home directory (default: ~/.j5code). T3CODE_HOME
#                            belongs to T3 Code and is never read.
#   T3CODE_INSTALL_BIN_DIR   where the `j5` symlink goes (default: ~/.local/bin)
#   J5CODE_NO_MODIFY_PATH    set to leave shell startup files alone and only print
#                            the PATH line to add
#   T3CODE_RELEASE_BASE_URL  mirror for releases/download (default: GitHub)
#
# The archive is unpacked into $J5CODE_HOME/runtime/versions/<version>, the
# same layout `j5 service install` uses, so the service reuses this download
# instead of fetching the release again.
set -eu

repo="Jacksondr5/j5code"
base_url="${T3CODE_RELEASE_BASE_URL:-https://github.com/${repo}/releases/download}"
t3_home="${J5CODE_HOME:-$HOME/.j5code}"
bin_dir="${T3CODE_INSTALL_BIN_DIR:-$HOME/.local/bin}"

fail() {
  printf '\nj5 install: %s\n' "$1" >&2
  exit 1
}

# ANSI stays on stderr, so `curl ... | sh` still gets progress.
interactive=false
if [ -t 2 ] && [ "${TERM:-}" != dumb ]; then interactive=true; fi
reset= bold= muted= accent= green=
if "$interactive" && [ -z "${NO_COLOR:-}" ]; then
  reset="$(printf '\033[0m')"; bold="$(printf '\033[1m')"
  muted="$(printf '\033[2m')"; accent="$(printf '\033[94m')"; green="$(printf '\033[32m')"
fi
step() {
  if "$interactive"; then printf '\r\033[2K  %s%s%s' "$muted" "$1" "$reset" >&2
  else printf '  %s\n' "$1" >&2; fi
}
if "$interactive"; then
  printf '\n%s' "$bold" >&2
  printf '  %s%s  %sCLI installer%s\n' 'J5 Code' "$reset" "$muted" "$reset$bold" >&2
  printf '%s\n' "$reset" >&2
fi
step "Finding your release..."

# Exit 44 on a 404 so callers can tell "no such asset" from a network failure.
fetch() {
  if command -v curl >/dev/null 2>&1; then
    status="$(curl -sSL -H "Accept: ${3:-*/*}" -w '%{http_code}' "$1" -o "$2")" || return 1
    case "$status" in
      2??) return 0 ;;
      404) return 44 ;;
      *) printf 'GET %s returned HTTP %s\n' "$1" "$status" >&2; return 1 ;;
    esac
  elif command -v wget >/dev/null 2>&1; then
    wget -q --server-response --header="Accept: ${3:-*/*}" "$1" -O "$2" 2>"$2.headers" && rm -f "$2.headers" && return 0
    if grep -q ' 404 ' "$2.headers" 2>/dev/null; then rm -f "$2.headers"; return 44; fi
    cat "$2.headers" >&2; rm -f "$2.headers"; return 1
  else
    fail "curl or wget is required"
  fi
}

mb() {
  tenths=$((($1 * 10 + 524288) / 1048576))
  printf '%s.%s' "$((tenths / 10))" "$((tenths % 10))"
}
# Poll the file written by the downloader; no progress-output parsing or extra request.
download() {
  if ! "$interactive"; then fetch "$1" "$2"; return; fi
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -D "$2.headers" "$1" -o "$2" 2>"$2.errors" &
  else
    wget -q --server-response "$1" -O "$2" 2>"$2.headers" &
  fi
  download_pid=$!
  previous=-1
  cr="$(printf '\r')"
  while kill -0 "$download_pid" 2>/dev/null; do
    bytes=0; total=0
    if [ -f "$2" ]; then bytes="$(wc -c < "$2")"; fi
    if [ -f "$2.headers" ]; then
      while read -r key value; do
        case "$key" in
          HTTP/*) total=0 ;;
          [Cc]ontent-[Ll]ength:) total="${value%"$cr"}" ;;
        esac
      done < "$2.headers"
    fi
    case "$total" in ''|*[!0-9]*) total=0 ;; esac
    if [ "$bytes" -ne "$previous" ]; then
      if [ "$total" -gt 0 ]; then
        percent=$((bytes * 100 / total)); [ "$percent" -le 100 ] || percent=100
        filled=$((percent * 32 / 100)); bar=; rest=; n=0
        while [ "$n" -lt 32 ]; do
          if [ "$n" -lt "$filled" ]; then bar="${bar}■"; else rest="${rest}·"; fi
          n=$((n + 1))
        done
        printf '\r\033[2K  %s%s%s%s%s %3d%%  %s%s / %s MB%s' "$accent" "$bar" "$reset$muted" "$rest" "$reset" "$percent" "$muted" "$(mb "$bytes")" "$(mb "$total")" "$reset" >&2
      else
        printf '\r\033[2K  %sDownloading%s  %s MB' "$muted" "$reset" "$(mb "$bytes")" >&2
      fi
      previous="$bytes"
    fi
    sleep 0.1
  done
  result=0; wait "$download_pid" || result=$?
  download_pid=
  if [ "$result" -ne 0 ]; then
    printf '\n' >&2
    if [ -f "$2.errors" ]; then cat "$2.errors" >&2; else cat "$2.headers" >&2; fi
    return "$result"
  fi
  size="$(mb "$(wc -c < "$2")")"
  printf '\r\033[2K  %s■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■%s 100%%  %s%s / %s MB%s\n' "$accent" "$reset" "$muted" "$size" "$size" "$reset" >&2
  rm -f "$2.headers" "$2.errors"
}

case "$(uname -s)" in
  Darwin) platform="darwin" ;;
  Linux) platform="linux" ;;
  *) fail "unsupported operating system $(uname -s); use the desktop app" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac
case "${platform}-${arch}" in
  darwin-arm64 | linux-x64) ;;
  *) fail "J5 Code publishes CLI archives for macOS (Apple silicon) and Linux x64 only, not ${platform}-${arch}" ;;
esac
command -v tar >/dev/null 2>&1 || fail "tar is required"
if command -v sha256sum >/dev/null 2>&1; then
  checksum() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  checksum() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail "sha256sum or shasum is required"
fi

channel="${T3CODE_CHANNEL:-stable}"
version="${T3CODE_VERSION:-}"
if [ -z "$version" ]; then
  case "$channel" in
    stable) tag_pattern='v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)' ;;
    nightly | preview) tag_pattern="v\([0-9][^\"]*-${channel}\.[0-9]*\.[0-9]*\)" ;;
    *) fail "T3CODE_CHANNEL must be stable, nightly, or preview" ;;
  esac
  tmp_index="$(mktemp)"
  if [ "$channel" = stable ]; then
    # release.yml marks only plain stable releases latest. This is a github.com
    # page, so it is not cut off by a page of newer nightlies or the API quota.
    fetch "https://github.com/${repo}/releases/latest" "$tmp_index" application/json
    version="$(sed -n "s/.*\"tag_name\": *\"${tag_pattern}\".*/\1/p" "$tmp_index" | head -n 1)"
  else
    page=1
    while [ -z "$version" ] && [ "$page" -le 10 ]; do
      fetch "https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}" "$tmp_index"
      version="$(sed -n "s/.*\"tag_name\": *\"${tag_pattern}\".*/\1/p" "$tmp_index" | head -n 1)"
      grep -q '"tag_name"' "$tmp_index" || break
      page=$((page + 1))
    done
  fi
  rm -f "$tmp_index"
  [ -n "$version" ] || fail "could not find a ${channel} release; set T3CODE_VERSION"
fi
case "$version" in
  *-preview.*)
    printf '%s\n' \
      "j5 ${version} is a preview build." \
      "  Preview builds are cut by maintainers from unreleased branches to exercise the release" \
      "  pipeline. They can be broken, receive no fixes, and are never offered as updates." \
      "  Set T3CODE_CHANNEL=stable (the default) for a supported build." >&2
    if [ "$channel" != "preview" ] && [ -z "${T3CODE_VERSION:-}" ]; then
      fail "refusing a preview build that was not explicitly requested"
    fi
    ;;
esac

stem="t3-${version}-${platform}-${arch}"
archive="${stem}.tar.gz"
versions_dir="${t3_home}/runtime/versions"
target_dir="${versions_dir}/${version}"

if [ -f "${target_dir}/.install-complete" ] && [ "$(cat "${target_dir}/.install-complete")" = "$version" ]; then
  step "Version ${version} is already downloaded."
else
  mkdir -p "$versions_dir"
  staging="$(mktemp -d "${versions_dir}/.staging-XXXXXX")"
  download_pid=
  trap '[ -z "$download_pid" ] || { kill "$download_pid" 2>/dev/null || true; wait "$download_pid" 2>/dev/null || true; }; rm -rf "$staging"' EXIT
  trap 'printf "\n" >&2; exit 130' INT
  trap 'printf "\n" >&2; exit 143' TERM

  if "$interactive"; then printf '\r\033[2K' >&2; fi
  printf '  %sInstalling%s J5 Code %s%s%s\n\n' "$muted" "$reset" "$bold" "$version" "$reset" >&2
  step "Downloading..."
  fetch_status=0
  fetch "${base_url}/v${version}/SHA256SUMS" "${staging}/SHA256SUMS" || fetch_status=$?
  if [ "$fetch_status" -eq 44 ]; then
    fail "j5 ${version} has no release archive for ${platform}-${arch}; J5 releases 0.0.43 and earlier were published to npm as @jacksondr5/j5code"
  elif [ "$fetch_status" -ne 0 ]; then
    fail "could not download the release checksums"
  fi
  download "${base_url}/v${version}/${archive}" "${staging}/${archive}"

  step "Verifying the download..."
  expected="$(grep " \*\{0,1\}${archive}\$" "${staging}/SHA256SUMS" | cut -d' ' -f1)"
  [ -n "$expected" ] || fail "${archive} is not listed in SHA256SUMS"
  actual="$(checksum "${staging}/${archive}")"
  [ "$actual" = "$expected" ] || fail "checksum mismatch for ${archive}"

  step "Extracting J5 Code..."
  tar -xzf "${staging}/${archive}" -C "$staging" --strip-components=1
  rm -f "${staging}/${archive}" "${staging}/SHA256SUMS"
  if [ -e "${staging}/j5" ]; then exe=j5; else exe=t3; fi
  "${staging}/${exe}" --version >/dev/null || fail "the downloaded executable does not run"
  printf '%s\n' "$version" > "${staging}/.install-complete"

  rm -rf "$target_dir"
  mv "$staging" "$target_dir"
  trap - EXIT
fi

step "Setting up the j5 command..."
mkdir -p "$bin_dir"
if [ -e "${target_dir}/j5" ]; then exe=j5; else exe=t3; fi
ln -sfn "${target_dir}/${exe}" "${bin_dir}/j5"
# Pruning keeps what this launcher points at; a background service cannot see bin_dir otherwise.
launcher="$(CDPATH='' cd -P -- "$bin_dir" && pwd)/j5"
launchers="${t3_home}/runtime/launchers"
grep -qxF "$launcher" "$launchers" 2>/dev/null || printf '%s\n' "$launcher" >> "$launchers"
if "$interactive"; then printf '\r\033[2K' >&2; fi
printf '  %sInstalled J5 Code %s%s\n\n' "$green" "$version" "$reset" >&2
case ":${PATH}:" in
  *":${bin_dir}:"*) printf '  Run %sj5%s to get started.\n\n' "$bold" "$reset"; exit 0 ;;
esac

# J5: put bin_dir on PATH for new terminals with one marked line in the shell's
# startup file. `j5 uninstall` removes lines ending with this marker; keep it
# in step with packages/shared/src/j5/shellProfile.ts.
marker='# Added by J5 Code; `j5 uninstall` removes this line.'
profile=
# The directory goes last: `j5` replaces nothing, so it has no reason to take
# precedence over what is already on PATH.
line="export PATH=\"\$PATH:${bin_dir}\" ${marker}"
case "$(basename "${SHELL:-}")" in
  zsh) profile="${ZDOTDIR:-$HOME}/.zshrc" ;;
  bash)
    if [ "$platform" = darwin ]; then
      # macOS terminals start login shells, which read only the first of these
      # that exists; creating .bash_profile would hide an existing .profile.
      profile="$HOME/.bash_profile"
      for candidate in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
        if [ -e "$candidate" ]; then profile="$candidate"; break; fi
      done
    else
      profile="$HOME/.bashrc"
    fi
    ;;
  fish)
    profile="${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish"
    # --path changes only this shell's PATH, so deleting the line undoes it.
    line="fish_add_path --path --append \"${bin_dir}\" ${marker}"
    ;;
esac
path_hint() {
  printf '  Add %s to your PATH, then run %sj5%s.\n\n' "$bin_dir" "$bold" "$reset"
  exit 0
}
[ -n "$profile" ] || path_hint
[ -z "${J5CODE_NO_MODIFY_PATH:-}" ] || path_hint
# The line quotes bin_dir in double quotes; a directory the shell would expand
# or split there gets the hint instead of a line that points somewhere else.
case "$bin_dir" in
  *[\"\$\`\\]*) path_hint ;;
esac
if grep -qF "$marker" "$profile" 2>/dev/null; then
  printf '  %s already has the PATH line from an earlier J5 Code install.\n  Open a new terminal, then run %sj5%s.\n\n' "$profile" "$bold" "$reset"
  exit 0
fi
# A read-only profile (a home-manager link, say) gets the hint, not a failure.
if ! {
  mkdir -p "$(dirname "$profile")" &&
    {
      # Start on a fresh line when the file doesn't end with one.
      if [ -s "$profile" ] && [ -n "$(tail -c 1 "$profile")" ]; then printf '\n'; fi
      printf '%s\n' "$line"
    } >> "$profile"
} 2>/dev/null; then
  path_hint
fi
printf '  Added %s to your PATH in %s.\n  Open a new terminal, then run %sj5%s.\n\n' "$bin_dir" "$profile" "$bold" "$reset"
