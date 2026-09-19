#!/usr/bin/env bash
#
# Launcher for the http-visualizer dev server.
#
# Starts an SSE + JSON server on 127.0.0.1 (default port 8788, override with
# PORT) that shows real Claude Code API request payloads grouped by querySource.
#
# To feed it, point a restored-src runtime at the ingest endpoint by setting
# CLAUDE_CODE_HTTP_VISUALIZER_ENDPOINT. The endpoint is read from the process
# environment by src/services/api/apiRequestObserver.ts on every LLM request,
# so the easiest spot is the gitignored restored-src/.claude/telemetry.env.
#
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8788}"
INGEST="http://127.0.0.1:${PORT}/ingest"

cd "$DIR"

echo "http-visualizer listening on http://127.0.0.1:${PORT}"
echo
echo "Feed it from restored-src, e.g. in restored-src/.claude/telemetry.env:"
echo "    CLAUDE_CODE_HTTP_VISUALIZER_ENDPOINT=${INGEST}"
echo
echo "Then run:  ./restored-src/bin/claude   (Ctrl-C here stops the server)"
echo

export PORT
exec node server.js
