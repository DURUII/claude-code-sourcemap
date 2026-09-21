// Recover the exact cost of each LLM call onto its span.
//
// Laminar computes `total_cost` from its own price table. `deepseek-v4-flash`
// is not in it, so it silently falls back to a default and reports a number
// that is wrong by more than an order of magnitude -- measured once at $0.00755
// against a true $0.258902. A confidently wrong figure is worse than no figure.
//
// The exact amount *is* flowing into Laminar already, as `cost_usd` on the
// `claude_code.api_request` **log record**. It is just not on the span, and
// Laminar offers no way to attach a log record to a span (the records arrive
// with empty traceId/spanId). So the relay does the join itself.
//
// Tokens are the join key, and they are an exact one: verified against a real
// run, every one of `input_tokens`, `output_tokens`, `cache_read_tokens` and
// `cache_creation_tokens` matches between the span and the log record for the
// same request, alongside `session.id` and `model`. No date arithmetic, no
// ordering heuristics, no fuzzy matching.
//
// The two payloads do not arrive together -- traces first, logs ~2ms later --
// so a trace batch that still needs costs is held until they show up or the
// hold times out. See relay.ts for the hold/flush mechanics.
import { readAttr, setAttr, type Attrs } from './mapping'

/**
 * Joins the fields of a fingerprint.
 *
 * NUL, written as an escape rather than a raw byte: a raw NUL anywhere in a
 * source file makes git treat the whole file as binary, costing diffs, blame
 * and review. NUL rather than a space because no field value here can contain
 * one (four token counts and a model name), so the join stays unambiguous
 * whatever the fields hold.
 */
export const SEPARATOR = '\0'

/**
 * The attributes that together identify one LLM request, exactly.
 *
 * Everything is stringified first, and that is load-bearing: the two streams do
 * not agree on the wire type for the same quantity. A span writes tokens as
 * `intValue` (a number); the matching log record writes them as `stringValue`.
 * Comparing with `===` matches nothing at all, silently, and every span would
 * come out unpriced.
 */
function fingerprintOf(attrs: Attrs): string {
  const parts = [
    'input_tokens',
    'output_tokens',
    'cache_read_tokens',
    'cache_creation_tokens',
    'model',
  ].map((k) => String(readAttr(attrs, k) ?? ''))
  return parts.join(SEPARATOR)
}

export interface CostRequest {
  sessionId: string
  fingerprint: string
}

/** The LLM spans in one trace payload, with the key needed to price each. */
export function costRequestsIn(payload: any): CostRequest[] {
  const out: CostRequest[] = []
  for (const rs of payload.resourceSpans ?? []) {
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        const attrs: Attrs = span.attributes ?? []
        if (readAttr(attrs, 'span.type') !== 'llm_request') continue
        const sessionId = String(readAttr(attrs, 'session.id') ?? '')
        if (!sessionId) continue
        out.push({ sessionId, fingerprint: fingerprintOf(attrs) })
      }
    }
  }
  return out
}

/**
 * `cost_usd` harvested from `claude_code.api_request` log records, keyed by
 * session and fingerprint.
 *
 * Stored as a queue per key rather than a single value: a session can issue the
 * same request shape twice, and both would share a fingerprint. Spans and log
 * records are emitted in the same order within a session, so consuming each
 * queue front-to-back pairs them up correctly.
 */
export class CostIndex {
  private bySession = new Map<string, Map<string, number[]>>()
  private waiting = new Map<string, Set<() => void>>()
  /** Every live wait's completion callback, so shutdown can force them all.
   *  `waiting` cannot serve that purpose: its callbacks only end a wait that has
   *  become satisfiable, which is exactly what shutdown cannot rely on. */
  private finishers = new Set<(ok: boolean) => void>()
  /** Recorded when one fingerprint is seen twice with different costs, which
   *  means the join is not the exact key it is believed to be. */
  readonly ambiguities: string[] = []

  add(sessionId: string, fingerprint: string, cost: number): void {
    let byFp = this.bySession.get(sessionId)
    if (!byFp) this.bySession.set(sessionId, (byFp = new Map()))
    const queue = byFp.get(fingerprint)
    if (queue && queue.length > 0 && queue[0] !== cost) {
      this.ambiguities.push(`${sessionId}/${fingerprint}: ${queue[0]} vs ${cost}`)
    }
    if (queue) queue.push(cost)
    else byFp.set(fingerprint, [cost])
    this.notify(sessionId)
  }

  peek(sessionId: string, fingerprint: string): number | undefined {
    return this.bySession.get(sessionId)?.get(fingerprint)?.[0]
  }

  consume(sessionId: string, fingerprint: string): void {
    const queue = this.bySession.get(sessionId)?.get(fingerprint)
    if (queue && queue.length > 0) queue.shift()
  }

  /** How many of `requests` cannot be priced yet. */
  missing(requests: CostRequest[]): number {
    return requests.filter((r) => this.peek(r.sessionId, r.fingerprint) === undefined).length
  }

  /**
   * Resolve once every request in `requests` can be priced, or when the caller
   * gives up. Returns whether all of them were matched.
   */
  waitFor(requests: CostRequest[], timeoutMs: number): Promise<boolean> {
    if (this.missing(requests) === 0) return Promise.resolve(true)
    return new Promise((resolve) => {
      const sessions = new Set(requests.map((r) => r.sessionId))
      let done = false
      const finish = (ok: boolean) => {
        if (done) return
        done = true
        clearTimeout(timer)
        for (const s of sessions) this.waiting.get(s)?.delete(recheck)
        this.finishers.delete(finish)
        resolve(ok)
      }
      this.finishers.add(finish)
      const recheck = () => {
        if (this.missing(requests) === 0) finish(true)
      }
      const timer = setTimeout(() => finish(this.missing(requests) === 0), timeoutMs)
      // An unref'd timer would let the process exit with a batch held.
      for (const s of sessions) {
        let set = this.waiting.get(s)
        if (!set) this.waiting.set(s, (set = new Set()))
        set.add(recheck)
      }
    })
  }

  private notify(sessionId: string): void {
    const set = this.waiting.get(sessionId)
    if (!set) return
    // Copy: a callback unregisters itself while we iterate.
    for (const recheck of [...set]) recheck()
  }

  /** End every outstanding wait now, priced or not, so a shutdown can flush
   *  whatever it has instead of discarding it. */
  releaseAll(): void {
    for (const finish of [...this.finishers]) finish(false)
  }
}

/**
 * Harvest `cost_usd` from a logs payload into the index.
 *
 * Only `claude_code.api_request` records carry it, one per LLM request, and
 * they carry exactly the token attributes the matching span carries.
 */
export function harvestCosts(payload: any, index: CostIndex): number {
  let found = 0
  for (const rl of payload.resourceLogs ?? []) {
    for (const sl of rl.scopeLogs ?? []) {
      for (const record of sl.logRecords ?? []) {
        if (record.body?.stringValue !== 'claude_code.api_request') continue
        const attrs: Attrs = record.attributes ?? []
        const sessionId = String(readAttr(attrs, 'session.id') ?? '')
        const cost = Number(readAttr(attrs, 'cost_usd'))
        if (!sessionId || !Number.isFinite(cost)) continue
        index.add(sessionId, fingerprintOf(attrs), cost)
        found++
      }
    }
  }
  return found
}

/**
 * Stamp the exact cost onto every LLM span that can be priced, and report how
 * many could not. Laminar honours an explicit `gen_ai.usage.cost` over its own
 * calculation, so a stamped span stops being wrong.
 */
export function stampCosts(
  payload: any,
  index: CostIndex,
): { stamped: number; unstamped: number } {
  let stamped = 0
  let unstamped = 0
  for (const rs of payload.resourceSpans ?? []) {
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        const attrs: Attrs = span.attributes ?? []
        if (readAttr(attrs, 'span.type') !== 'llm_request') continue
        const sessionId = String(readAttr(attrs, 'session.id') ?? '')
        const fingerprint = fingerprintOf(attrs)
        const cost = index.peek(sessionId, fingerprint)
        if (cost === undefined) {
          unstamped++
          continue
        }
        index.consume(sessionId, fingerprint)
        setAttr(attrs, 'gen_ai.usage.cost', cost)
        stamped++
      }
    }
  }
  return { stamped, unstamped }
}
