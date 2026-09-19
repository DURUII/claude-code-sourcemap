#!/usr/bin/env bash
#
# Bring restored-src from a clean checkout to a runnable state.
#
# The published claude-code tarball is webpack-compiled: package/cli.js.map
# holds the readable source of the runtime, but node_modules is NOT shipped as
# a usable install — it only existed in the map as per-module sources. So a
# fresh clone needs three things that `git clone` alone cannot provide:
#
#   1. registry dependencies  → `bun install --frozen-lockfile`
#   2. internal, non-published Anthropic packages (@ant/*) that never reach
#      npm → reconstructed from package/cli.js.map by scripts/restore-internal-deps.mjs
#   3. credentials            → copied by you into the gitignored
#      restored-src/.claude/telemetry.env (see the .example template)
#
# Requirements: bun (https://bun.sh) on PATH. Runtime is Bun against the source
# tree via restored-src/bin/claude.
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

command -v bun >/dev/null 2>&1 || {
  echo "error: 'bun' not found on PATH" >&2
  echo "  install it first:  curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
}

echo "[1/4] removing old install"
rm -rf restored-src/node_modules

echo "[2/4] bun install --frozen-lockfile (registry deps)"
(cd restored-src && bun install --frozen-lockfile)

echo "[3/4] restoring internal non-published packages from the source map"
bun scripts/restore-internal-deps.mjs

echo "[4/4] smoke tests"
(cd restored-src && ./bin/claude --version)
(cd restored-src && ./bin/claude --help >/dev/null && echo "  --help OK")

cat <<'EOF'

Done. restored-src is runnable.

Next steps
  * Make a first request by configuring credentials. This runtime speaks the
    Anthropic API (or an Anthropic-compatible gateway, e.g. DeepSeek). Copy the
    template and fill it in — the file is sourced by bin/claude at launch, so
    set exactly ONE auth source (see the auth-conflict note inside):

        cp restored-src/.claude/telemetry.env.example restored-src/.claude/telemetry.env

  * Try it interactively (or `-p "hi"` for one-shot):

        ./restored-src/bin/claude

  * Optionally watch real request payloads by scope with the dev visualizer:

        ./lab/http-visualizer/run.sh
        # then CLAUDE_CODE_HTTP_VISUALIZER_ENDPOINT=http://127.0.0.1:8788/ingest \
        #     ./restored-src/bin/claude
EOF
