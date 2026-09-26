// Round-trip proofs for the JSON -> protobuf encoder, run against payloads
// captured from a real restored-src run (not hand-written fixtures -- the whole
// point is to catch shapes I would not have thought to invent).
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { decodeLogs, decodeTraces, encodeLogs, encodeTraces, hexToBuffer } from './otlp'

const CAPTURE = process.env.CAPTURE_DIR ?? '/tmp/beta-capture'
const readJson = (name: string) => JSON.parse(fs.readFileSync(`${CAPTURE}/${name}`, 'utf8'))
const haveCapture = fs.existsSync(`${CAPTURE}/000-_v1_traces.bin`)

describe('hexToBuffer', () => {
  test('converts hex, not base64', () => {
    // The trap: a 32-char hex id is *also* syntactically valid base64. Decoding
    // it as base64 yields 24 bytes instead of 16, so length is the tell.
    const hex = '4fa015e8d75546f372e9efda120b87aa'
    expect(hexToBuffer(hex).length).toBe(16)
    expect(Buffer.from(hex, 'base64').length).toBe(24)
    expect(hexToBuffer(hex).toString('hex')).toBe(hex)
  })
  test('empty / absent ids become empty buffers, not a crash', () => {
    expect(hexToBuffer('').length).toBe(0)
    expect(hexToBuffer(undefined).length).toBe(0)
    expect(hexToBuffer(null).length).toBe(0)
  })
  test('rejects malformed hex instead of guessing', () => {
    expect(() => hexToBuffer('zzzz')).toThrow()
    expect(() => hexToBuffer('abc')).toThrow() // odd length
  })
})

describe.if(haveCapture)('encodeTraces on a real capture', () => {
  test('IDs survive the round trip byte-for-byte', () => {
    const json = readJson('000-_v1_traces.bin')
    const buf = encodeTraces(structuredClone(json))
    const back = decodeTraces(buf)

    const before = collectIds(json)
    const after = collectIds({
      resourceSpans: back.resourceSpans.map((rs: any) => ({
        scopeSpans: (rs.scopeSpans ?? []).map((ss: any) => ({ spans: ss.spans ?? [] })),
      })),
    })
    expect(after.traceIds).toEqual(before.traceIds)
    expect(after.spanIds).toEqual(before.spanIds)
    expect(after.traceIds.length).toBeGreaterThan(0)
  })

  test('span names, attribute keys and attribute values all survive', () => {
    const json = readJson('000-_v1_traces.bin')
    const back = decodeTraces(encodeTraces(structuredClone(json)))
    const flat = (p: any) =>
      p.resourceSpans.flatMap((rs: any) =>
        rs.scopeSpans.flatMap((ss: any) =>
          ss.spans.map((s: any) => ({
            name: s.name,
            kind: s.kind,
            attrs: Object.fromEntries(
              s.attributes.map((a: any) => [a.key, a.value.stringValue ?? a.value.intValue ?? a.value.boolValue]),
            ),
          })),
        ),
      )
    const a = flat(json)
    const b = flat(back)
    expect(b.map((s: any) => s.name)).toEqual(a.map((s: any) => s.name))
    expect(b.map((s: any) => s.kind)).toEqual(a.map((s: any) => s.kind))
    for (let i = 0; i < a.length; i++) {
      expect(Object.keys(b[i].attrs).sort()).toEqual(Object.keys(a[i].attrs).sort())
      // int64 fields are rendered as strings by the decoder (protobufjs
      // `longs: String`), so compare values not JS types. What actually matters
      // is that nothing is lost or mangled on the wire -- Laminar decodes the
      // protobuf natively and gets the real int64 either way.
      for (const [k, v] of Object.entries(b[i].attrs)) {
        expect(String(v), `attr ${k} on span ${a[i].name}`).toBe(String(a[i].attrs[k]))
      }
    }
  })

  test('resource attributes and the instrumentation scope are preserved', () => {
    const json = readJson('000-_v1_traces.bin')
    const back = decodeTraces(encodeTraces(structuredClone(json)))
    const r0 = back.resourceSpans[0]
    expect(r0.resource.attributes.map((a: any) => a.key).sort()).toEqual(
      json.resourceSpans[0].resource.attributes.map((a: any) => a.key).sort(),
    )
    expect(r0.scopeSpans[0].scope.name).toBe('com.anthropic.claude_code.tracing')
  })
})

describe.if(haveCapture)('encodeLogs on a real capture', () => {
  test('survives the round trip: bodies, timestamps, attribute values', () => {
    const json = readJson('001-_v1_logs.bin')
    const buf = encodeLogs(structuredClone(json))
    const back = decodeLogs(buf)
    const flat = (p: any) =>
      p.resourceLogs.flatMap((rl: any) =>
        rl.scopeLogs.flatMap((sl: any) =>
          sl.logRecords.map((r: any) => ({
            body: r.body?.stringValue,
            time: r.timeUnixNano,
            event: r.attributes.find((a: any) => a.key === 'event.name')?.value?.stringValue,
          })),
        ),
      )
    const a = flat(json)
    const b = flat(back)
    expect(b.length).toBe(a.length)
    expect(b.length).toBeGreaterThan(0)
    expect(b.map((r: any) => r.body)).toEqual(a.map((r: any) => r.body))
    // Nanosecond timestamps exceed 2^53; they must survive exact, not rounded.
    expect(b.map((r: any) => r.time)).toEqual(a.map((r: any) => r.time))
  })

  test('a log record carrying an empty traceId does not corrupt the payload', () => {
    // Every captured log record has empty traceId/spanId, so this is the shape
    // that actually ships. Worth pinning: empty string -> zero-length buffer is
    // the one input where the hex/base64 confusion is invisible either way.
    const json = readJson('001-_v1_logs.bin')
    const buf = encodeLogs(structuredClone(json))
    const back = decodeLogs(buf)
    for (const rl of back.resourceLogs) {
      for (const sl of rl.scopeLogs) {
        for (const r of sl.logRecords) expect(r.traceId ?? '').toBe('')
      }
    }
    // The body text must appear verbatim on the wire.
    expect(buf.includes(Buffer.from('claude_code.user_prompt'))).toBe(true)
  })
})

function collectIds(json: any) {
  const traceIds = new Set<string>()
  const spanIds = new Set<string>()
  for (const rs of json.resourceSpans ?? []) {
    for (const ss of rs.scopeSpans ?? []) {
      for (const s of ss.spans ?? []) {
        if (s.traceId) traceIds.add(s.traceId)
        if (s.spanId) spanIds.add(s.spanId)
        if (s.parentSpanId) spanIds.add(s.parentSpanId)
      }
    }
  }
  return { traceIds: [...traceIds].sort(), spanIds: [...spanIds].sort() }
}
