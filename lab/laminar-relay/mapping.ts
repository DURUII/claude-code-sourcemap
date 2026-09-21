// Claude Code telemetry attributes -> Laminar semantic conventions.
//
// Claude Code emits `claude_code.*`-flavoured attributes. Laminar's typed
// columns, transcript view and cost rollups read `lmnr.span.*` and `gen_ai.*`.
// Nothing is missing from the payload -- every value Laminar needs is already
// there under a different name -- so this module is a rename plus a little
// reshaping, never a reconstruction.
//
// Attribute names and value shapes follow the published reference:
//   https://laminar.sh/docs/tracing/structure/span-attribute-reference
import { createHash } from 'node:crypto'

/** A parsed OTLP/JSON AnyValue, as it appears in `attributes[].value`. */
type AnyValue = Record<string, unknown>
export interface OTLPAttribute {
  key: string
  value: AnyValue
}
export type Attrs = OTLPAttribute[]

// ── attribute helpers ──────────────────────────────────────────────────────
//
// An unset protobuf oneof branch still reads back as that branch's default
// (false / 0 / ""), so presence must be tested with an own-property check --
// `value.boolValue !== undefined` is true for every string attribute.

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

export function readAttr(attrs: Attrs, key: string): string | number | boolean | undefined {
  const found = attrs.find((a) => a.key === key)
  if (!found) return undefined
  const v = found.value ?? {}
  if (own(v, 'stringValue')) return v.stringValue as string
  if (own(v, 'intValue')) return Number(v.intValue as string)
  if (own(v, 'doubleValue')) return v.doubleValue as number
  if (own(v, 'boolValue')) return v.boolValue as boolean
  return undefined
}

export function setAttr(attrs: Attrs, key: string, value: string | number | boolean | undefined): void {
  if (value === undefined || value === null) return
  const existing = attrs.find((a) => a.key === key)
  const encoded: AnyValue =
    typeof value === 'boolean'
      ? { boolValue: value }
      : typeof value === 'number'
        ? Number.isInteger(value)
          ? { intValue: value }
          : { doubleValue: value }
        : { stringValue: value }
  if (existing) existing.value = encoded
  else attrs.push({ key, value: encoded })
}

// ── content reshaping ──────────────────────────────────────────────────────

/**
 * Claude Code packs the *new* part of the conversation into a single
 * `new_context` string with a bracketed header:
 *
 *     [USER]\n<the user's prompt>
 *     [TOOL RESULT: Bash]\n{"stdout":"hi",...}
 *     [TOOL RESULT: call_00_ET_Flm...]\nhi
 *     [TOOL INPUT: Bash]\n{"command":"echo hi"}
 *
 * The bracketed tag is the only structure; everything after the first newline
 * is opaque payload (often JSON, sometimes plain text).
 */
const CONTEXT_RE = /^\[([^\]]+)\]\r?\n?([\s\S]*)$/

export interface ParsedContext {
  tag: string
  /** Text after the `[TAG]` header, verbatim. */
  payload: string
}

export function parseContext(raw: string): ParsedContext {
  const m = CONTEXT_RE.exec(raw)
  if (!m) return { tag: '', payload: raw }
  return { tag: m[1].trim(), payload: m[2] }
}

type Part =
  | { type: 'text'; content: string }
  | { type: 'tool_call_response'; id: string; response: string }
interface Message {
  role: string
  parts: Part[]
}

/** Turn one `new_context` blob into the single message it represents. */
export function contextToMessage(raw: string): Message | undefined {
  const { tag, payload } = parseContext(raw)
  if (tag.toUpperCase() === 'USER') {
    return { role: 'user', parts: [{ type: 'text', content: payload }] }
  }
  const toolResult = /^TOOL RESULT:\s*(.*)$/i.exec(tag)
  if (toolResult) {
    return {
      role: 'tool',
      parts: [{ type: 'tool_call_response', id: toolResult[1].trim(), response: payload }],
    }
  }
  // Unknown tag: keep the text rather than dropping it. Losing conversation
  // content silently is the failure mode this whole relay exists to fix.
  if (raw.trim() === '') return undefined
  return { role: 'user', parts: [{ type: 'text', content: raw }] }
}

/** Extract the payload of `[TOOL INPUT: X]\n...` / `[TOOL RESULT: X]\n...`. */
export function contextPayloadFor(raw: string | undefined, wanted: string): string | undefined {
  if (!raw) return undefined
  const { tag, payload } = parseContext(raw)
  return tag.toUpperCase().startsWith(wanted) ? payload : undefined
}

// ── trace grouping ─────────────────────────────────────────────────────────

/**
 * One `bin/claude -p` run emits *several* trace roots: every
 * `claude_code.llm_request` and every `claude_code.tool` starts its own trace,
 * with the tool sub-spans hanging off the tool. They are only related by a
 * shared `session.id` attribute. Laminar has no way to know they belong
 * together, so the UI shows a scatter of one-span traces.
 *
 * Deriving the trace id from the session id (rather than remembering the first
 * trace id seen) keeps the mapping deterministic: a re-export, an exporter
 * retry, or a relay restart all land on the same trace instead of forking a
 * new one.
 */
export function deriveTraceId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 32)
}

export function deriveRootSpanId(sessionId: string): string {
  return createHash('sha256').update(`root:${sessionId}`).digest('hex').slice(0, 16)
}

export type GroupingMode = 'session' | 'none'

export interface MapStats {
  spans: number
  llmSpans: number
  toolSpans: number
  skippedAlreadyMapped: number
  sessionsRooted: Set<string>
}

export interface MapOptions {
  grouping: GroupingMode
  /**
   * Sessions for which a synthetic root span has already been emitted. The
   * caller owns this so it survives across requests; the root is sent once per
   * session rather than on every batch.
   */
  rootedSessions: Set<string>
}

/**
 * Rewrite one OTLP/JSON trace payload in place: attribute names, span names,
 * trace grouping. Returns human-readable counters for the relay log.
 */
export function mapTracesPayload(payload: any, opts: MapOptions): MapStats {
  const stats: MapStats = {
    spans: 0,
    llmSpans: 0,
    toolSpans: 0,
    skippedAlreadyMapped: 0,
    sessionsRooted: opts.rootedSessions,
  }

  for (const resourceSpans of payload.resourceSpans ?? []) {
    for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
      const spans: any[] = scopeSpans.spans ?? []
      let sessionId = ''
      let userId = ''

      // Read the session identity off every span first, so that grouping still
      // works on a batch where every span was already mapped (and therefore
      // skipped) -- otherwise a re-export would not be recognised as belonging
      // to the session already rooted.
      for (const span of spans) {
        const attrs: Attrs = span.attributes ?? []
        sessionId ||= String(readAttr(attrs, 'session.id') ?? '')
        userId ||= String(readAttr(attrs, 'user.id') ?? '')
      }

      for (const span of spans) {
        const attrs: Attrs = span.attributes ?? (span.attributes = [])
        stats.spans++

        // Re-running the relay over its own output must not double-apply.
        // The marker is `lmnr.association.properties.session_id`, which is set
        // on *every* span we touch -- unlike `lmnr.span.type`, which sub-spans
        // deliberately do not get.
        if (readAttr(attrs, 'lmnr.association.properties.session_id') !== undefined) {
          stats.skippedAlreadyMapped++
          continue
        }

        mapSpan(span, attrs, stats)
      }

      if (opts.grouping !== 'session' || sessionId === '') continue

      const traceId = deriveTraceId(sessionId)
      for (const span of spans) span.traceId = traceId

      const rootSpanId = deriveRootSpanId(sessionId)
      // Two guards, because they cover different failures: the set stops a
      // second root in a *later* batch, and the membership check stops a second
      // root in a batch that already carries one (which is what a relay restart
      // mid-session produces, since the set does not survive it).
      const rootAlreadyPresent = spans.some((s) => s.spanId === rootSpanId)
      if (!rootAlreadyPresent && !opts.rootedSessions.has(sessionId)) {
        opts.rootedSessions.add(sessionId)
        spans.unshift(buildSessionRoot(sessionId, userId, traceId, spans))
      }
      // Spans the CLI emitted as trace roots now hang off the session root.
      for (const span of spans) {
        if (!span.parentSpanId && span.spanId !== rootSpanId) span.parentSpanId = rootSpanId
      }
    }
  }
  return stats
}

function mapSpan(span: any, attrs: Attrs, stats: MapStats): void {
  const spanType = String(readAttr(attrs, 'span.type') ?? '')
  const sessionId = readAttr(attrs, 'session.id')
  const userId = readAttr(attrs, 'user.id')

  // Laminar's own trace-association keys. These drive the Sessions view and
  // per-user filtering; they are separate from the raw `session.id` attribute,
  // which is left in place for SQL.
  if (sessionId !== undefined) setAttr(attrs, 'lmnr.association.properties.session_id', String(sessionId))
  if (userId !== undefined) setAttr(attrs, 'lmnr.association.properties.user_id', String(userId))

  if (spanType === 'llm_request') {
    stats.llmSpans++
    setAttr(attrs, 'lmnr.span.type', 'LLM')

    const model = readAttr(attrs, 'model')
    if (typeof model === 'string' && model) setAttr(attrs, 'gen_ai.request.model', model)

    // Two conventions disagree about what "input tokens" means, and the
    // difference is not cosmetic.
    //
    //   Claude Code's `input_tokens` EXCLUDES cached tokens; the cache counts
    //   sit alongside it as separate attributes. (Confirmed independently:
    //   `cost_usd` on the api_request log record only reconciles at $5/M input
    //   / $25/M output / $0.5/M cache read when the uncached count is used.)
    //
    //   Laminar's `gen_ai.usage.input_tokens` is documented as "the total input
    //   count, cached tokens included", and Laminar subtracts the cache counts
    //   back out itself when pricing.
    //
    // Passing Claude Code's number through unchanged gives Laminar a total that
    // is smaller than the cached portion of it -- and it repairs that by
    // raising the total to the cache count, which is neither of the two real
    // numbers. Summing here is the whole fix.
    const cacheRead = Number(readAttr(attrs, 'cache_read_tokens') ?? 0)
    const cacheCreation = Number(readAttr(attrs, 'cache_creation_tokens') ?? 0)
    const uncachedInput = readAttr(attrs, 'input_tokens')
    if (typeof uncachedInput === 'number') {
      setAttr(attrs, 'gen_ai.usage.input_tokens', uncachedInput + cacheRead + cacheCreation)
    }
    setAttr(attrs, 'gen_ai.usage.output_tokens', readAttr(attrs, 'output_tokens'))
    setAttr(attrs, 'gen_ai.usage.cache_read_input_tokens', readAttr(attrs, 'cache_read_tokens'))
    setAttr(attrs, 'gen_ai.usage.cache_creation_input_tokens', readAttr(attrs, 'cache_creation_tokens'))

    // `new_context` carries only the *delta* since the previous request, not
    // the whole message list -- earlier turns are on earlier spans in the same
    // session. The transcript is complete; each individual LLM row is not.
    const newContext = readAttr(attrs, 'new_context')
    if (typeof newContext === 'string') {
      const msg = contextToMessage(newContext)
      if (msg) setAttr(attrs, 'gen_ai.input.messages', JSON.stringify([msg]))
    }
    const modelOutput = readAttr(attrs, 'response.model_output')
    if (typeof modelOutput === 'string' && modelOutput) {
      setAttr(
        attrs,
        'gen_ai.output.messages',
        JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: modelOutput }] }]),
      )
    }
    // Deliberately NOT setting `gen_ai.system_instructions`: the only system
    // prompt text on this span is `system_prompt_preview`, truncated at 500
    // chars. Presenting a truncated prompt as the system message would read as
    // authoritative and be wrong. The full text exists, but only as a separate
    // log record (`claude_code.system_prompt`) on the /v1/logs stream.
    return
  }

  if (spanType === 'tool') {
    stats.toolSpans++
    setAttr(attrs, 'lmnr.span.type', 'TOOL')
    // Laminar labels a TOOL row with the span *name*, and every tool span is
    // named `claude_code.tool`, so without this every row reads identically.
    const toolName = readAttr(attrs, 'tool_name')
    if (typeof toolName === 'string' && toolName) span.name = toolName

    setAttr(attrs, 'lmnr.span.input', contextPayloadFor(readAttr(attrs, 'tool_input') as string, 'TOOL INPUT'))
    setAttr(attrs, 'lmnr.span.output', contextPayloadFor(readAttr(attrs, 'new_context') as string, 'TOOL RESULT'))
    return
  }

  // `tool.execution` / `tool.blocked_on_user` are sub-steps of the tool call
  // and already nest under it. Leave them DEFAULT so they stay in the tree view
  // without competing with the tool row in the transcript.
}

/**
 * A synthetic root so the session reads as one tree instead of N roots. Modelled
 * on what an SDK user gets from wrapping their agent loop in `observe()`.
 *
 * Its end time is the end of the batch that first carried the session, so the
 * root's own duration understates a long session. The alternative -- re-sending
 * the root on every batch -- depends on Laminar treating a repeated span id as
 * an update, which is not documented, so it is not done by default.
 */
function buildSessionRoot(sessionId: string, userId: string, traceId: string, spans: any[]): any {
  const nanos = spans.map((s) => Number(s.startTimeUnixNano ?? 0)).filter((n) => n > 0)
  const endNanos = spans.map((s) => Number(s.endTimeUnixNano ?? 0)).filter((n) => n > 0)
  const start = nanos.length ? Math.min(...nanos) : Date.now() * 1e6
  const attributes: Attrs = []
  setAttr(attributes, 'lmnr.span.type', 'DEFAULT')
  setAttr(attributes, 'lmnr.association.properties.session_id', sessionId)
  if (userId) setAttr(attributes, 'lmnr.association.properties.user_id', userId)
  setAttr(attributes, 'session.id', sessionId)
  if (userId) setAttr(attributes, 'user.id', userId)
  return {
    traceId,
    spanId: deriveRootSpanId(sessionId),
    name: 'session',
    kind: 1,
    startTimeUnixNano: start,
    endTimeUnixNano: endNanos.length ? Math.max(...endNanos) : start,
    attributes,
  }
}

/**
 * Give log records the session's trace id so they can be filtered alongside the
 * spans they belong to. They arrive with `traceId` and `spanId` empty, so
 * without this they float free of the trace.
 *
 * Called only when grouping is on, so that `grouping: 'none'` stays a faithful
 * pass-through baseline for A/B comparison.
 */
export function mapLogsPayload(payload: any, opts: MapOptions): { records: number; tagged: number } {
  let records = 0
  let tagged = 0
  for (const resourceLogs of payload.resourceLogs ?? []) {
    for (const scopeLogs of resourceLogs.scopeLogs ?? []) {
      for (const record of scopeLogs.logRecords ?? []) {
        records++
        const attrs: Attrs = record.attributes ?? (record.attributes = [])
        const sessionId = readAttr(attrs, 'session.id')
        if (sessionId === undefined) continue
        setAttr(attrs, 'lmnr.association.properties.session_id', String(sessionId))
        const userId = readAttr(attrs, 'user.id')
        if (userId !== undefined) setAttr(attrs, 'lmnr.association.properties.user_id', String(userId))
        if (opts.grouping === 'session') {
          record.traceId = deriveTraceId(String(sessionId))
          tagged++
        }
      }
    }
  }
  return { records, tagged }
}
