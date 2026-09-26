// Local OTLP relay: Claude Code beta tracing -> Laminar.
//
//   bin/claude --(OTLP/HTTP JSON)--> this relay --(OTLP/HTTP protobuf)--> Laminar
//
// It exists because Claude Code's beta-tracing export path and Laminar disagree
// in three places, none of which the CLI or Laminar can fix from their own side:
//
//   1. NAMES. Claude Code emits `claude_code.*` attributes; Laminar's typed
//      columns, transcript view and cost rollups read `lmnr.span.*` and
//      `gen_ai.*`. Connected directly, spans land as span_type=DEFAULT with
//      model="", input_tokens=0 and an empty conversation panel -- even though
//      every value is present, just under another name.
//
//   2. SERIALISATION. Laminar's logs route accepts protobuf only (its published
//      spec declares a single media type for POST /v1/logs, and a JSON body
//      gets a 500 "failed to decode Protobuf message"). Claude Code's beta
//      exporters serialise to JSON, so every log record -- user prompts,
//      api_request tokens/cost, tool results -- was being dropped server-side
//      with no error surfaced anywhere. Re-encoding as protobuf recovers them.
//
//   3. TRACE SHAPE. One `-p` run emits several trace roots (every LLM request
//      and every tool call starts its own trace) that share only a `session.id`
//      attribute. Laminar shows a scatter of one-span traces. The relay groups
//      them under one trace id per session with a synthetic root.
//
// Anything it cannot map it passes through unchanged: a dropped attribute is
// invisible, a renamed one is recoverable.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import zlib from 'node:zlib'
import { CostIndex, costRequestsIn, harvestCosts, stampCosts } from './correlate'
import { mapLogsPayload, mapTracesPayload, type GroupingMode } from './mapping'
import { encodeLogs, encodeTraces } from './otlp'

// ── configuration ──────────────────────────────────────────────────────────

const PORT = Number(process.env.RELAY_PORT ?? 4319)
const UPSTREAM = (process.env.RELAY_UPSTREAM ?? 'https://api.lmnr.ai').replace(/\/+$/, '')
const GROUPING: GroupingMode = process.env.RELAY_TRACE_GROUPING === 'none' ? 'none' : 'session'
const DUMP_DIR = process.env.RELAY_DUMP_DIR ?? ''
const VERBOSE = process.env.RELAY_VERBOSE !== '0'
/**
 * How long to hold a trace batch waiting for the log records that carry its
 * exact costs. Measured in practice the two arrive ~2ms apart, so this timeout
 * is a safety net for when the logs never come, not a routine delay. 0 turns
 * cost correlation off entirely and falls back to Laminar's own calculation,
 * which is wrong for models it does not have prices for.
 */
const CORRELATE_MS = Number(process.env.RELAY_CORRELATE_MS ?? 2000)

/**
 * The project key lives in the repo-root .env, put there by `lmnr-cli setup`.
 * Read it with a regex rather than sourcing the file so that a stray line in
 * .env cannot execute here, and so the key is never copied into a second place
 * that would need updating on rotation.
 */
function loadApiKey(): string | undefined {
  if (process.env.LMNR_PROJECT_API_KEY) return process.env.LMNR_PROJECT_API_KEY
  const envPath = path.resolve(import.meta.dir, '../../.env')
  try {
    const m = /^LMNR_PROJECT_API_KEY=(.*)$/m.exec(fs.readFileSync(envPath, 'utf8'))
    return m?.[1].trim().replace(/^["']|["']$/g, '')
  } catch {
    return undefined
  }
}

const API_KEY = loadApiKey()
if (!API_KEY) {
  console.error(
    `[relay] no LMNR_PROJECT_API_KEY (checked the environment and the repo-root .env).\n` +
      `[relay] upstream would reject every request with 401. Run \`npx lmnr-cli setup\`, or export the key.`,
  )
  process.exit(1)
}

// ── state ──────────────────────────────────────────────────────────────────

/** Sessions already given a synthetic root span. In-memory by design: the
 *  worst case after a restart is one redundant root, and nothing else. */
const rootedSessions = new Set<string>()

/** Exact `cost_usd` values harvested from api_request log records, waiting to
 *  be stamped onto the LLM spans they belong to. */
const costIndex = new CostIndex()

const counters = {
  traces: 0,
  spans: 0,
  llm: 0,
  tool: 0,
  logs: 0,
  dropped: 0,
  failed: 0,
  costStamped: 0,
  costMissing: 0,
}

/** Requests currently awaiting a forward, so a shutdown can drain them. */
let inFlight = 0

// ── request handling ───────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      if (req.headers['content-encoding'] === 'gzip') {
        try {
          resolve(zlib.gunzipSync(raw))
        } catch (err) {
          reject(new Error(`failed to gunzip request body: ${err}`))
        }
        return
      }
      resolve(raw)
    })
    req.on('error', reject)
  })
}

async function forward(endpoint: string, body: Buffer, contentType: string): Promise<Response> {
  return fetch(`${UPSTREAM}${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': contentType, authorization: `Bearer ${API_KEY}` },
    body,
  })
}

/** Report a failed forward loudly and completely.
 *
 *  This is the single most important behaviour in the file. The bug that
 *  motivated the whole relay was invisible precisely because a telemetry
 *  exporter swallowed a 401 and carried on. A failure here must be impossible
 *  to miss, and must reach the exporter as a failure rather than a 200. */
async function reportFailure(endpoint: string, res: Response, sent: string): Promise<void> {
  counters.failed++
  const snippet = (await res.text().catch(() => '')).slice(0, 500)
  console.error(`[relay] ✗ ${endpoint} -> ${res.status} ${res.statusText} (${sent})\n[relay]   ${snippet}`)
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const endpoint = url.pathname

  if (endpoint === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, upstream: UPSTREAM, grouping: GROUPING, counters }))
    return
  }

  if (req.method !== 'POST') {
    res.writeHead(405).end()
    return
  }

  const raw = await readBody(req)
  const incomingJson = (req.headers['content-type'] ?? '').includes('json')

  if (DUMP_DIR) {
    fs.mkdirSync(DUMP_DIR, { recursive: true })
    fs.writeFileSync(`${DUMP_DIR}/${Date.now()}-${endpoint.replace(/\W+/g, '_')}.bin`, raw)
  }

  // Laminar has no metrics handler -- its ingestion accepts the request and
  // discards it. Forwarding would burn bandwidth to no effect, so acknowledge
  // and drop, and say so once in the log rather than pretending it went
  // somewhere. (The CLI's own /v1/metrics traffic carries token/cost counters
  // that Laminar recomputes from spans anyway.)
  if (endpoint === '/v1/metrics') {
    counters.dropped++
    res.writeHead(200, { 'content-type': 'application/x-protobuf' }).end()
    return
  }

  const known = endpoint === '/v1/traces' || endpoint === '/v1/logs'
  if (!known) {
    res.writeHead(404).end()
    return
  }

  let outBody: Buffer
  let summary: string

  if (!incomingJson) {
    // Already protobuf -- the customer-OTLP path, or a replayed capture.
    outBody = raw
    summary = `${raw.length}B already-protobuf`
  } else {
    let parsed: any
    try {
      parsed = JSON.parse(raw.toString('utf8'))
    } catch (err) {
      counters.failed++
      console.error(`[relay] ✗ ${endpoint}: body is not JSON: ${err}`)
      res.writeHead(400).end()
      return
    }

    if (endpoint === '/v1/traces') {
      const stats = mapTracesPayload(parsed, { grouping: GROUPING, rootedSessions })
      counters.traces++
      counters.spans += stats.spans
      counters.llm += stats.llmSpans
      counters.tool += stats.toolSpans

      // Hold the batch if it needs costs that have not arrived yet. In practice
      // the matching logs land milliseconds later; the timeout only fires when
      // they are never coming.
      const requests = costRequestsIn(parsed)
      if (CORRELATE_MS > 0 && requests.length > 0) {
        const complete = await costIndex.waitFor(requests, CORRELATE_MS)
        if (!complete) {
          console.error(
            `[relay] ! ${requests.length} LLM span(s) in this batch had no matching ` +
              `api_request log record after ${CORRELATE_MS}ms; forwarding without an exact ` +
              `cost, so Laminar's own (possibly wrong) calculation applies`,
          )
        }
      }
      const cost = stampCosts(parsed, costIndex)
      counters.costStamped += cost.stamped
      counters.costMissing += cost.unstamped

      summary =
        `${stats.spans} spans (${stats.llmSpans} LLM, ${stats.toolSpans} TOOL, ` +
        `${stats.skippedAlreadyMapped} already mapped), grouping=${GROUPING}, ` +
        `cost ${cost.stamped}/${requests.length} exact`
    } else {
      const stats = mapLogsPayload(parsed, { grouping: GROUPING, rootedSessions })
      counters.logs += stats.records
      const harvested = harvestCosts(parsed, costIndex)
      summary = `${stats.records} log records (${stats.tagged} trace-tagged, ${harvested} with cost)`
    }

    try {
      outBody = endpoint === '/v1/traces' ? encodeTraces(parsed) : encodeLogs(parsed)
    } catch (err) {
      counters.failed++
      console.error(`[relay] ✗ ${endpoint}: failed to re-encode as protobuf: ${err}`)
      res.writeHead(500).end()
      return
    }
  }

  let upstream: Response
  try {
    upstream = await forward(endpoint, outBody, 'application/x-protobuf')
  } catch (err) {
    counters.failed++
    console.error(`[relay] ✗ ${endpoint}: cannot reach ${UPSTREAM}: ${err}`)
    res.writeHead(502).end()
    return
  }

  if (!upstream.ok) {
    await reportFailure(endpoint, upstream, summary)
    // Propagate the failure instead of swallowing it: a 200 here would tell the
    // OTel exporter everything is fine, which is how the original silent-drop
    // bug worked.
    res.writeHead(upstream.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: `upstream ${upstream.status}` }))
    return
  }

  if (VERBOSE) {
    console.log(`[relay] ✓ ${endpoint} ${summary} -> ${outBody.length}B protobuf -> ${UPSTREAM}`)
  }
  res.writeHead(200, { 'content-type': 'application/x-protobuf' }).end()
}

const server = http.createServer((req, res) => {
  inFlight++
  handle(req, res)
    .catch((err) => {
      counters.failed++
      console.error('[relay] ✗ unhandled:', err)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
    .finally(() => {
      inFlight--
    })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[relay] listening on http://127.0.0.1:${PORT}`)
  console.log(`[relay] upstream: ${UPSTREAM}`)
  console.log(`[relay] trace grouping: ${GROUPING}`)
  if (DUMP_DIR) console.log(`[relay] dumping raw payloads to ${DUMP_DIR}`)
  console.log(
    `[relay] point the CLI at it with:\n` +
      `[relay]   ENABLE_BETA_TRACING_DETAILED=1\n` +
      `[relay]   BETA_TRACING_ENDPOINT=http://127.0.0.1:${PORT}`,
  )
})

/**
 * On shutdown, release any batches still waiting on costs and let them forward,
 * rather than dropping the last thing that happened -- which for a `-p` run is
 * the entire session. Bounded, because a wedged upstream must not make the
 * relay unkillable.
 */
let shuttingDown = false
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[relay] ${sig}: draining ${inFlight} in-flight request(s)…`)
    costIndex.releaseAll()
    const started = Date.now()
    const drain = setInterval(() => {
      if (inFlight === 0 || Date.now() - started > 3000) {
        clearInterval(drain)
        console.log(`[relay] totals: ${JSON.stringify(counters)}`)
        process.exit(0)
      }
    }, 50)
  })
}
