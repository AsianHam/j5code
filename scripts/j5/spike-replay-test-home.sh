#!/usr/bin/env bash
# SPIKE (Jacksondr5/j5code#546): build a model-free test home from upstream's
# provider replay kit plus J5's delivery seed, and time it.
#
#   scripts/j5/spike-replay-test-home.sh <absolute home> [--clock epoch]
#
# The home must not exist yet, and no server may be running on it.
#
# Then start the server with the inherited variables unset and with
# T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false: without it the dev server adds
# this checkout's apps/server as a project, a real repo, and opens a draft in it.
# Findings: artifact test-reports/spike-replay-test-home.md.
set -euo pipefail

[[ $# -ge 1 && "$1" = /* ]] || { echo "Usage: $0 <absolute home> [--clock epoch]" >&2; exit 64; }
base_dir="$1"
shift
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
unset T3CODE_PORT T3CODE_HOST J5CODE_HOME

started=$(date +%s%N)
node apps/server/src/j5/test-support/spikeReplayTestHome.ts --base-dir "$base_dir" "$@"
replayed=$(date +%s%N)
# The seed stamps process.cwd() as its project root and its threads' worktree,
# so run it from the scratch repo, never from this checkout.
(cd "$base_dir/test-repo" && node "$repo_root/apps/server/src/j5/a2a/test-support/devDeliverySeedRunner.ts" --base-dir "$base_dir") \
  > "$base_dir/seed-receipt.json"
finished=$(date +%s%N)
echo "replay: $(((replayed - started) / 1000000)) ms, delivery seed: $(((finished - replayed) / 1000000)) ms, total: $(((finished - started) / 1000000)) ms" >&2
