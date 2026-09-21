# laminar-relay

A local OTLP relay that sits between `restored-src` and Laminar.

```
restored-src/bin/claude  --(OTLP/HTTP JSON)-->  relay.ts  --(OTLP/HTTP protobuf)-->  api.lmnr.ai
```

Without it, Claude Code's beta-tracing export and Laminar disagree in three
places. None of them can be fixed from either side alone, which is why a relay
exists rather than an env-var.

## 1. Attribute names

Claude Code emits `claude_code.*`-flavoured attributes; Laminar's typed columns,
transcript view and cost rollups read `lmnr.span.*` and `gen_ai.*`.

Connected directly, a span that genuinely has 24 113 input tokens, a model name
and both sides of the conversation lands like this:

| column | direct | through the relay |
|---|---|---|
| `span_type` | `DEFAULT` | `LLM` |
| `model` | `""` | `deepseek-v4-flash` |
| `input_tokens` | `0` | `24113` |
| `input` (conversation) | `""` | `[{"role":"user","parts":[…]}]` |
| `output` (conversation) | `""` | `[{"role":"assistant",…}]` |

Nothing is missing from the payload — every value Laminar wants is already
there, under another name. So this is a rename, never a reconstruction.
`mapping.ts` is the whole of it.

## 2. Serialisation

Laminar's logs route accepts **protobuf only**. Its published API reference
declares a single media type for `POST /v1/logs` (`application/x-protobuf`,
operationId `ingestLogs`) — unlike `POST /v1/traces`, which also takes JSON.
A JSON body gets:

```
500 Failed to decode ExportLogsServiceRequest from bytes.
    failed to decode Protobuf message: invalid wire type value: 6
```

Claude Code's beta exporters serialise to JSON, so **every log record was being
dropped server-side**, with no error surfaced anywhere — the exporter saw a
response, the CLI saw a clean exit, and Laminar kept nothing. That is 25+ records
per run: user prompts, full system prompts, per-request token counts and exact
costs, tool inputs, tool results, permission decisions.

Re-encoding the same payload as protobuf recovers them. `otlp.ts` is the schema
plus the encoder.

## 3. Trace shape

One `bin/claude -p` run emits *several* trace roots: every
`claude_code.llm_request` and every `claude_code.tool` starts its own trace, with
the tool sub-spans hanging off the tool. They are related only by a shared
`session.id` attribute, which Laminar has no reason to group on. The result is a
scatter of one-span traces.

The relay rewrites every span of a session to one deterministic trace id
(`sha256(session.id)`) and adds a synthetic `session` root, modelled on what an
SDK user gets from wrapping their agent loop in `observe()`:

```
session                                  DEFAULT
├── claude_code.llm_request              LLM     24 123 in / 113 out
├── Bash                                 TOOL
│   ├── claude_code.tool.blocked_on_user DEFAULT
│   └── claude_code.tool.execution       DEFAULT
└── claude_code.llm_request              LLM     24 064 in / 28 out
```

Deriving the id from the session rather than remembering the first one seen
keeps it deterministic: an exporter retry or a relay restart lands on the same
trace instead of forking a new one.

## If the relay is not running, nothing tells you

With `BETA_TRACING_ENDPOINT` pointed at the relay, a stopped relay means the
exporter cannot connect. Verified: `bin/claude -p '…'` still exits `0`, still
prints its answer, and prints no warning of any kind. Telemetry just stops.
This is the same class of failure as the JSON-on-`/v1/logs` bug that motivated
the relay — a silently swallowed export error.

So: if traces stop appearing, check the relay first.

```sh
curl -s http://127.0.0.1:4319/health
```

The health endpoint reports live counters, which also makes it the fastest way
to answer "did that run export anything?":

```json
{"ok":true,"upstream":"https://api.lmnr.ai","grouping":"session",
 "counters":{"traces":2,"spans":10,"llm":4,"tool":2,"logs":50,"dropped":0,"failed":0}}
```

A non-zero `failed` means the upstream rejected something — the relay logs the
status and the response body when that happens, and returns the failure to the
exporter rather than a 200.

## Running it

```sh
./run.sh                          # listens on 127.0.0.1:4319
```

Then, in `restored-src/.claude/telemetry.env`:

```sh
export ENABLE_BETA_TRACING_DETAILED=1
export BETA_TRACING_ENDPOINT=http://127.0.0.1:4319
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer ${LMNR_PROJECT_API_KEY}"
```

The project key is read from the repo-root `.env` (written by `lmnr-cli setup`),
or from `LMNR_PROJECT_API_KEY` in the environment.

Verify a run landed:

```sh
npx lmnr-cli sql query \
  "SELECT name, span_type, model, input_tokens, input, output
   FROM spans WHERE start_time > now() - INTERVAL 10 MINUTE ORDER BY start_time" --json
```

### Options

| variable | default | meaning |
|---|---|---|
| `RELAY_PORT` | `4319` | listen port |
| `RELAY_UPSTREAM` | `https://api.lmnr.ai` | where mapped payloads go |
| `RELAY_TRACE_GROUPING` | `session` | `none` for a faithful pass-through baseline |
| `RELAY_DUMP_DIR` | unset | write every raw incoming payload here |
| `RELAY_VERBOSE` | `1` | `0` logs failures only |

`RELAY_TRACE_GROUPING=none` disables both grouping and log trace-tagging, which
is useful for A/B-ing what the mapping actually changes.

## Tests

```sh
CAPTURE_DIR=/tmp/beta-capture bun test
```

Tests run against payloads captured from a real run rather than hand-written
fixtures — the point is to catch shapes nobody would think to invent. To
recapture:

```sh
PROBE_PORT=4319 PROBE_OUT=/tmp/beta-capture bun /tmp/otlp-probe.mjs &
CAPTURE_ENDPOINT=http://127.0.0.1:4319 /tmp/capture-run.sh -p "…"
```

`otlp.test.ts` proves the JSON→protobuf round trip preserves ids, span names,
attribute keys and values, resource attributes, instrumentation scope and
nanosecond timestamps. `mapping.test.ts` pins the classification, the
conversation reshaping, trace grouping and idempotency.

## What the relay fixes, measured

All three on one real `bin/claude -p` run, before vs after:

| | direct to Laminar | through the relay |
|---|---|---|
| `span_type` | `DEFAULT` | `LLM` / `TOOL` |
| `model` | `""` | `deepseek-v4-flash` |
| `input_tokens` | `0` | `24413` (incl. cache) |
| conversation panel | empty | both sides, full text |
| traces per `-p` run | 3 disconnected | 1, with a `session` root |
| log records queryable | 0 | all of them |
| `total_cost` | 34× low | exact, to the cent |

The cost line is worth spelling out, because it is the one the relay computes by
joining two streams rather than by renaming. Laminar prices from its own table,
has no entry for `deepseek-v4-flash`, and falls back to a default — on the run
measured here it reported **$0.00755** against a true **$0.258902**. The exact
figure is already arriving as `cost_usd` on the `claude_code.api_request` log
record; it just is not on the span, and Laminar has no documented way to attach
a log record to a span (the records arrive with empty `traceId`/`spanId`). The
relay joins them on the token fingerprint and stamps `gen_ai.usage.cost`, which
Laminar honours over its own calculation. Verified end to end: the relay logged
`cost 2/2 exact`, and Laminar's stored `total_cost` came back `0.123205` and
`0.013376`, bit-for-bit equal to the `cost_usd` in the log stream.

**Rows ingested before a mapping fix stay wrong.** Laminar stores what it is
sent at ingestion time; there is no re-derivation. The `input_tokens` correction
below applies only to spans sent after it.

## Known gaps

**`input_tokens` depends on an undocumented ingestion rule.** Two conventions
disagree about what the number means:

- Claude Code's `input_tokens` **excludes** cached tokens; the cache counts sit
  beside it as separate attributes. `cost_usd` only reconciles at $5/M input /
  $25/M output / $0.5/M cache read when the uncached figure is used, which pins
  this down independently of any doc.
- Laminar's is documented as "the total input count, cached tokens included",
  and Laminar subtracts the cache counts back out itself when pricing.

Sending the uncached figure through unchanged gives Laminar a "total" smaller
than its own cache count. Observed: the relay sent `171` with
`cache_read_input_tokens=24064`, and Laminar stored **`24064`** — neither the
uncached `171` nor the true total `24235`. The relay now sends the inclusive sum,
and Laminar stores it verbatim (`24413` for `221 + 24192`). The two pairs are
consistent with Laminar clamping `input_tokens` to
`max(input_tokens, cache_read + cache_creation)`, but that rule is inferred from
two observations, not documented, so treat it as a hypothesis rather than a
guarantee.

**Per-span conversation is the delta, not the history.** `new_context` carries
only what is new since the previous request, so an individual LLM row shows the
one message that triggered it. The whole session is on the trace.

**No system prompt on LLM spans.** The only system-prompt text on the span is
`system_prompt_preview`, truncated at 500 characters. A truncated prompt
presented as `gen_ai.system_instructions` would read as authoritative and be
wrong, so it is deliberately not set. The full text exists, but only as a
separate `claude_code.system_prompt` log record.

**The synthetic root's duration understates a long session.** The root is sent
once, in the first batch that carries the session, so its end time is that
batch's. Re-sending it per batch with an updated end time would depend on
Laminar treating a repeated span id as an update, which is undocumented.

**`/v1/metrics` is acknowledged and dropped.** Laminar's ingestion accepts the
request and discards it, so forwarding would burn bandwidth to no effect. The
relay says so in the log rather than pretending it went somewhere.

## Reference

- [Span attribute reference](https://laminar.sh/docs/tracing/structure/span-attribute-reference)
- [Ingest OpenTelemetry logs](https://laminar.sh/docs/api-reference/ingestion/ingest-opentelemetry-logs)
- [Ingest OpenTelemetry traces](https://laminar.sh/docs/api-reference/ingestion/ingest-opentelemetry-traces)
