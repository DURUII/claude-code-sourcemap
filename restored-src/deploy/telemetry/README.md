# Telemetry Stack

This directory is a reference deployment for studying Claude Code telemetry,
performance, logs, traces, and feature flags. It is intentionally host-neutral:
run it on a laptop, NAS, homelab machine, VPS, or cloud VM.

Do not commit real deployment values. Put hostnames, Tailscale domains, public
IPs, passwords, and GrowthBook SDK keys in private env files only.

## Components

- OpenTelemetry Collector receives Claude Code OTLP on `4317` and `4318`.
- Prometheus stores metrics scraped from the Collector.
- Loki stores logs.
- Tempo stores traces.
- Grafana queries Prometheus, Loki, and Tempo.
- GrowthBook + MongoDB provides feature flags, remote config, and experiments.
- `apollo/router.telemetry.yaml` is only a template for a future Apollo Router;
  Claude Code does not need Apollo Router today.

## Start

```bash
cd deploy/telemetry
cp .env.example .env
$EDITOR .env

docker compose pull
docker compose up -d
docker compose ps
```

Use your deployment host in `.env`:

```env
GROWTHBOOK_APP_ORIGIN=http://<host>:3000
GROWTHBOOK_API_HOST=http://<host>:3100
```

For a same-machine development setup, `<host>` can be `localhost`.

`deploy/telemetry/.env` is for the Docker Compose stack only. It configures
Grafana, GrowthBook, MongoDB, and service origins on the deployment host.

## Open

Replace `<host>` with your own host:

- Grafana: `http://<host>:3001`
- GrowthBook app: `http://<host>:3000`
- GrowthBook API: `http://<host>:3100`
- Prometheus: `http://<host>:9090`
- Tempo status/API: `http://<host>:3200/status`,
  `http://<host>:3200/api/search`

Tempo does not serve a standalone UI at `/`; a `404` from
`http://<host>:3200/` is normal. Query traces through Grafana Explore or Tempo
HTTP APIs.

Loki is not published on the host because GrowthBook uses host port `3100`.
Query Loki through Grafana Explore. Inside the compose network, Loki is
`http://loki:3100`.

## Point Claude Code At The Stack

Claude runtime env belongs in the restored checkout, not in
`deploy/telemetry/.env`. Copy the runtime example into the ignored local
`.claude` directory:

```bash
cd restored-src
mkdir -p .claude
cp deploy/telemetry/claude.telemetry.env.example .claude/telemetry.env
$EDITOR .claude/telemetry.env
./bin/claude
```

For a local development stack, use `127.0.0.1` or `localhost` for `<host>`.
For a remote deployment, use your private host and add proxy bypass rules:

```bash
export NO_PROXY="<host>,localhost,127.0.0.1"
export no_proxy="$NO_PROXY"
```

`bin/claude` only applies telemetry defaults when
`CLAUDE_RESTORED_TELEMETRY=1`. Public checkouts do not send telemetry anywhere
by default.

The ignored local file should look like:

```env
CLAUDE_RESTORED_TELEMETRY=1
OTEL_EXPORTER_OTLP_ENDPOINT=http://<host>:4318
OTEL_LOG_USER_PROMPTS=1
OTEL_LOG_TOOL_DETAILS=1
OTEL_LOG_TOOL_CONTENT=1
CLAUDE_CODE_GB_BASE_URL=http://<host>:3100
CLAUDE_CODE_GB_CLIENT_KEY=<growthbook-sdk-client-key>
CLAUDE_CODE_PERFETTO_TRACE=1
```

This example explicitly enables sensitive OTLP payloads for source-study diagnostics:

```bash
OTEL_LOG_USER_PROMPTS=1
OTEL_LOG_TOOL_DETAILS=1
OTEL_LOG_TOOL_CONTENT=1
```

Unset those variables, or set them to `0`, when the telemetry backend should not receive prompt text, tool parameters, or tool output/content.

## HTTP Request Visualizer

`lab/http-visualizer` is a local browser tool for inspecting the actual Claude
API request payload as it leaves `src/services/api/claude.ts`. It is separate
from OTLP/Grafana telemetry and is intended for source-study debugging.

Start the visualizer:

```bash
cd lab/http-visualizer
npm test
npm start
```

Then enable the sink in `restored-src/.claude/telemetry.env`:

```env
CLAUDE_CODE_HTTP_VISUALIZER_ENDPOINT=http://127.0.0.1:8788/ingest
```

Open `http://127.0.0.1:8788` and run `./bin/claude`. The restored runtime
emits request events through `src/services/api/apiRequestObserver.ts`. The
observer name is intentional: the code observes API requests and can feed a
visualizer, but the API layer itself is not coupled to a UI.

## GrowthBook Notes

Claude Code's GrowthBook client uses remote evaluation. The SDK connection must
have remote evaluation enabled, otherwise `/api/eval/<client-key>` returns an
error even if `/api/features/<client-key>` works.

The runtime reads:

```bash
CLAUDE_CODE_GB_BASE_URL=http://<host>:3100
CLAUDE_CODE_GB_CLIENT_KEY=<growthbook-sdk-client-key>
```

GrowthBook is a remote configuration and experimentation layer. It does not
implement behavior by itself. It only supplies values for keys already read by
the source through helpers such as `getFeatureValue_CACHED_MAY_BE_STALE`,
`getFeatureValue_DEPRECATED`, and related dynamic-config helpers.

The local cache is written into the Claude global config for the selected
`CLAUDE_CONFIG_DIR`, under:

```text
cachedGrowthBookFeatures
```

In this restored checkout, `bin/claude` defaults `CLAUDE_CONFIG_DIR` to the
repo-local `.claude`, so the cache usually lands in:

```text
.claude/.claude.json
```

## Apollo Boundary

Apollo GraphOS is not the local analytics backend for Claude Code. Apollo Router
can be self-hosted and can export OpenTelemetry metrics/traces, so
`apollo/router.telemetry.yaml` is included as a template for a future GraphQL
router. It is not started by this compose file because there is no supergraph in
the current Claude Code runtime.

## Verification

After `docker compose up -d`:

```bash
curl -fsS http://localhost:9090/-/ready
docker compose exec loki wget -qO- http://localhost:3100/ready
curl -fsS http://localhost:3200/status
curl -fsS 'http://localhost:3200/api/search?limit=1'
curl -fsS http://localhost:3001/api/health
curl -fsS http://localhost:3000/
```

Then run Claude Code with the OTLP env above and check:

- Grafana Explore > Prometheus for `claude_code_*` metrics.
- Grafana Explore > Loki for `{service_name="claude-code"}` logs.
- Grafana Explore > Tempo for traces.
