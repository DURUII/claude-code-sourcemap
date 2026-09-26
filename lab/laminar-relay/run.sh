#!/usr/bin/env bash
#
# Launcher for the Laminar OTLP relay.
#
# Claude Code's beta-tracing path ships OTLP/HTTP **JSON**; Laminar's logs route
# accepts protobuf only, and its typed columns read different attribute names.
# This process sits in between and fixes both. See README.md for the full story.
#
# Configure through the environment (all optional):
#   RELAY_PORT             default 4319
#   RELAY_UPSTREAM         default https://api.lmnr.ai
#   RELAY_TRACE_GROUPING   "session" (default) or "none" -- see README
#   RELAY_DUMP_DIR         if set, raw incoming payloads are written here
#   RELAY_VERBOSE          set to 0 to log only failures
#   LMNR_PROJECT_API_KEY   else read from the repo-root .env
#
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${RELAY_PORT:-4319}"

export RELAY_PORT="$PORT"

echo "laminar-relay listening on http://127.0.0.1:${PORT}"
echo "upstream: ${RELAY_UPSTREAM:-https://api.lmnr.ai}  (grouping: ${RELAY_TRACE_GROUPING:-session})"
echo
echo "Feed it from restored-src/.claude/telemetry.env:"
echo "    ENABLE_BETA_TRACING_DETAILED=1"
echo "    BETA_TRACING_ENDPOINT=http://127.0.0.1:${PORT}"
echo
echo "Then run:  ./restored-src/bin/claude -p '...'   (Ctrl-C here stops the relay)"
echo

cd "$DIR"
exec bun relay.ts
