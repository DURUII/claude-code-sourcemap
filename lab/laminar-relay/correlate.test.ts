// Cost correlation, tested against a real traces/logs payload pair dumped by
// the relay from one run. The join is only as good as the claim that span
// tokens and log-record tokens are identical, so that claim is asserted
// directly rather than assumed.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { CostIndex, SEPARATOR, costRequestsIn, harvestCosts, stampCosts } from './correlate'

const DUMP = process.env.DUMP_DIR ?? '/tmp/relay-dump-live'
const files = fs.existsSync(DUMP) ? fs.readdirSync(DUMP).sort() : []
const tracesFile = files.find((f) => f.includes('traces'))
const logsFile = files.find((f) => f.includes('logs'))
const haveDump = Boolean(tracesFile && logsFile)

const readDump = (f: string) => JSON.parse(fs.readFileSync(path.join(DUMP, f), 'utf8'))
const kv = (kvs: any[] = []) =>
  Object.fromEntries(
    kvs.map((k) => [
      k.key,
      k.value?.stringValue ?? k.value?.intValue ?? k.value?.doubleValue ?? k.value?.boolValue,
    ]),
  )

const attrsOf = (payload: any) =>
  payload.resourceSpans.flatMap((rs: any) =>
    rs.scopeSpans.flatMap((ss: any) => ss.spans.map((s: any) => ({ name: s.name, attrs: kv(s.attributes) }))),
  )

describe.if(haveDump)('the join key is exact', () => {
  test('span tokens equal the matching log record tokens, field for field', () => {
    const spans = attrsOf(readDump(tracesFile!))
      .filter((s) => s.attrs['span.type'] === 'llm_request')
      .map((s) => s.attrs)
    const logs = readDump(logsFile!).resourceLogs
      .flatMap((rl: any) => rl.scopeLogs.flatMap((sl: any) => sl.logRecords))
      .filter((r: any) => r.body?.stringValue === 'claude_code.api_request')
      .map((r: any) => kv(r.attributes))

    expect(spans.length).toBe(logs.length)
    expect(spans.length).toBeGreaterThan(0)
    for (const span of spans) {
      // Compare as strings, because the two streams disagree on the wire type:
      // a span writes tokens as intValue (a number), the log record writes the
      // same quantity as stringValue. A `===` join finds nothing, which is the
      // trap this test exists to pin down.
      const match = logs.find(
        (l) =>
          String(l['input_tokens']) === String(span['input_tokens']) &&
          String(l['output_tokens']) === String(span['output_tokens']) &&
          String(l['cache_read_tokens']) === String(span['cache_read_tokens']) &&
          String(l['cache_creation_tokens']) === String(span['cache_creation_tokens']) &&
          l['model'] === span['model'],
      )
      expect(match, `no log record for span with tokens ${span['input_tokens']}/${span['output_tokens']}`).toBeDefined()
      expect(match!['session.id']).toBe(span['session.id'])
    }
  })

  test('the two streams really do use different wire types for the same number', () => {
    const span = readDump(tracesFile!).resourceSpans[0].scopeSpans[0].spans.find((s: any) =>
      s.attributes.some((a: any) => a.key === 'span.type' && a.value.stringValue === 'llm_request'),
    )
    const value = (attrs: any[], k: string) => attrs.find((a: any) => a.key === k)?.value
    const log = readDump(logsFile!)
      .resourceLogs.flatMap((rl: any) => rl.scopeLogs.flatMap((sl: any) => sl.logRecords))
      .find((r: any) => r.body?.stringValue === 'claude_code.api_request')

    expect(value(span.attributes, 'input_tokens')).toHaveProperty('intValue')
    expect(value(log.attributes, 'input_tokens')).toHaveProperty('stringValue')
    expect(value(log.attributes, 'cost_usd')).toHaveProperty('stringValue')
    // So a strict comparison would join nothing at all.
    expect(value(span.attributes, 'input_tokens').intValue).not.toBe(
      value(log.attributes, 'input_tokens').stringValue,
    )
  })
})

describe.if(haveDump)('harvestCosts / costRequestsIn / stampCosts', () => {
  test('every LLM span gets its own exact cost from the log stream', () => {
    const index = new CostIndex()
    const traces = readDump(tracesFile!)
    const logs = readDump(logsFile!)

    const requests = costRequestsIn(traces)
    expect(requests.length).toBe(2)

    const harvested = harvestCosts(logs, index)
    expect(harvested).toBe(2)
    expect(index.missing(requests)).toBe(0)

    const { stamped, unstamped } = stampCosts(traces, index)
    expect(stamped).toBe(2)
    expect(unstamped).toBe(0)

    const costs = attrsOf(traces)
      .filter((s) => s.attrs['span.type'] === 'llm_request')
      .map((s) => s.attrs['gen_ai.usage.cost'])
    expect(costs.sort()).toEqual([0.013666999999999999, 0.12344].sort())
    // The exact figure, not something Laminar would have recomputed.
    expect(costs).toContain(0.12344)
  })

  test('stamping consumes the index, so a replay does not re-stamp', () => {
    const index = new CostIndex()
    const traces = readDump(tracesFile!)
    harvestCosts(readDump(logsFile!), index)
    stampCosts(traces, index)
    const second = stampCosts(traces, index)
    expect(second.stamped).toBe(0)
    expect(second.unstamped).toBe(2)
  })

  test('a batch whose cost never arrives is not stamped, and is counted', () => {
    const index = new CostIndex()
    const traces = readDump(tracesFile!)
    const { stamped, unstamped } = stampCosts(traces, index)
    expect(stamped).toBe(0)
    expect(unstamped).toBe(2)
    expect(attrsOf(traces).some((s) => s.attrs['gen_ai.usage.cost'] !== undefined)).toBe(false)
  })
})

describe('CostIndex.waitFor', () => {
  const req = (fp: string) => [{ sessionId: 's1', fingerprint: fp }]

  test('resolves immediately when the cost is already known', async () => {
    const index = new CostIndex()
    index.add('s1', 'a b c d e', 1.5)
    expect(await index.waitFor(req('a b c d e'), 50)).toBe(true)
  })

  test('resolves as soon as the cost arrives, well before the timeout', async () => {
    const index = new CostIndex()
    const started = Date.now()
    const waiting = index.waitFor(req('a b c d e'), 5000)
    setTimeout(() => index.add('s1', 'a b c d e', 1.5), 20)
    expect(await waiting).toBe(true)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test('gives up and reports incompleteness after the timeout', async () => {
    const index = new CostIndex()
    const started = Date.now()
    expect(await index.waitFor(req('a b c d e'), 120)).toBe(false)
    expect(Date.now() - started).toBeGreaterThanOrEqual(100)
  })

  test('releaseAll unblocks everything, for shutdown', async () => {
    const index = new CostIndex()
    const waiting = index.waitFor(req('a b c d e'), 10_000)
    setTimeout(() => index.releaseAll(), 10)
    expect(await waiting).toBe(false) // released without ever being priced
  })

  test('one session resolving does not release another session’s wait', async () => {
    const index = new CostIndex()
    const other = index.waitFor([{ sessionId: 's2', fingerprint: 'x' }], 400)
    index.add('s1', 'x', 1)
    expect(await other).toBe(false)
  })

  test('a wait ends once all of its requests are priced, not just one', async () => {
    const index = new CostIndex()
    const requests = [
      { sessionId: 's1', fingerprint: 'a' },
      { sessionId: 's1', fingerprint: 'b' },
    ]
    const waiting = index.waitFor(requests, 300)
    index.add('s1', 'a', 1)
    setTimeout(() => index.add('s1', 'b', 2), 20)
    expect(await waiting).toBe(true)
    expect(index.missing(requests)).toBe(0)
  })
})

describe('CostIndex queueing', () => {
  test('a repeated fingerprint is consumed front-to-back, in order', () => {
    const index = new CostIndex()
    index.add('s1', 'same', 0.1)
    index.add('s1', 'same', 0.2)
    expect(index.peek('s1', 'same')).toBe(0.1)
    index.consume('s1', 'same')
    expect(index.peek('s1', 'same')).toBe(0.2)
    index.consume('s1', 'same')
    expect(index.peek('s1', 'same')).toBeUndefined()
  })

  test('the same cost seen twice is not flagged as ambiguous', () => {
    const index = new CostIndex()
    index.add('s1', 'same', 0.1)
    index.add('s1', 'same', 0.1)
    expect(index.ambiguities).toEqual([])
  })

  test('one fingerprint with two different costs is surfaced, not hidden', () => {
    // Would mean the join key is not the exact key it is believed to be.
    const index = new CostIndex()
    index.add('s1', 'same', 0.1)
    index.add('s1', 'same', 0.2)
    expect(index.ambiguities.length).toBe(1)
  })

  test('consume on an unknown key is a no-op, not a crash', () => {
    expect(() => new CostIndex().consume('nope', 'nope')).not.toThrow()
  })

  test('sessions do not leak costs into each other', () => {
    const index = new CostIndex()
    index.add('s1', 'fp', 1)
    expect(index.peek('s2', 'fp')).toBeUndefined()
  })
})

describe('the fingerprint separator', () => {
  const spanWith = (attrs: Record<string, unknown>) => ({
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                name: 'claude_code.llm_request',
                attributes: [
                  { key: 'span.type', value: { stringValue: 'llm_request' } },
                  { key: 'session.id', value: { stringValue: 's1' } },
                  ...Object.entries(attrs).map(([key, v]) => ({
                    key,
                    value: typeof v === 'number' ? { intValue: v } : { stringValue: v },
                  })),
                ],
              },
            ],
          },
        ],
      },
    ],
  })

  test('different token tuples never collide on one fingerprint', () => {
    // The separator is NUL rather than a space so that a value containing a
    // space cannot shift the field boundaries and alias onto another request.
    const a = costRequestsIn(
      spanWith({
        input_tokens: 1,
        output_tokens: 2,
        cache_read_tokens: 3,
        cache_creation_tokens: 4,
        model: 'm',
      }),
    )
    const b = costRequestsIn(
      spanWith({
        input_tokens: 1,
        output_tokens: 2,
        cache_read_tokens: 3,
        cache_creation_tokens: 45,
        model: 'm',
      }),
    )
    const shifted = costRequestsIn(
      spanWith({
        input_tokens: 12,
        output_tokens: 3,
        cache_read_tokens: 4,
        cache_creation_tokens: 5,
        model: 'm',
      }),
    )
    expect(a[0].fingerprint).not.toBe(b[0].fingerprint)
    expect(a[0].fingerprint).not.toBe(shifted[0].fingerprint)
  })

  test('the separator is a character no field value can contain', () => {
    // The point of NUL is that the join is unambiguous whatever the fields
    // hold. Asserted on the separator itself rather than on a contrived
    // collision, because with five fixed fields and four numeric ones there is
    // no collision for a space to cause -- this would be a false claim.
    expect(SEPARATOR).toBe('\0')
    expect(SEPARATOR).not.toMatch(/\s/)
  })
})

describe('costRequestsIn', () => {
  test('ignores non-LLM spans and spans with no session', () => {
    const payload = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  name: 'x',
                  attributes: [
                    { key: 'span.type', value: { stringValue: 'tool' } },
                    { key: 'session.id', value: { stringValue: 's1' } },
                  ],
                },
                {
                  name: 'y',
                  attributes: [
                    { key: 'span.type', value: { stringValue: 'llm_request' } },
                    { key: 'input_tokens', value: { intValue: 1 } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }
    expect(costRequestsIn(payload)).toEqual([])
  })
})
