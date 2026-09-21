// Mapping tests, driven by payloads captured from a real restored-src run.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import {
  contextPayloadFor,
  contextToMessage,
  deriveRootSpanId,
  deriveTraceId,
  mapLogsPayload,
  mapTracesPayload,
  parseContext,
} from './mapping'

const CAPTURE = process.env.CAPTURE_DIR ?? '/tmp/beta-capture'
const haveCapture = fs.existsSync(`${CAPTURE}/000-_v1_traces.bin`)
const readJson = (name: string) => JSON.parse(fs.readFileSync(`${CAPTURE}/${name}`, 'utf8'))

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)
const getAll = (spans: any[], key: string) =>
  spans
    .flatMap((s: any) => s.attributes)
    .filter((a: any) => a.key === key)
    .map((a: any) => a.value.stringValue ?? a.value.intValue ?? a.value.boolValue)
const one = (spans: any[], key: string) => getAll(spans, key)[0]

function allSpans(payload: any): any[] {
  return payload.resourceSpans.flatMap((rs: any) => rs.scopeSpans.flatMap((ss: any) => ss.spans))
}

describe('parseContext', () => {
  test('splits the bracketed tag from its payload', () => {
    expect(parseContext('[USER]\nhello world')).toEqual({ tag: 'USER', payload: 'hello world' })
    expect(parseContext('[TOOL RESULT: Bash]\n{"stdout":"hi"}')).toEqual({
      tag: 'TOOL RESULT: Bash',
      payload: '{"stdout":"hi"}',
    })
  })
  test('a payload containing newlines survives intact', () => {
    const v = parseContext('[USER]\nline1\nline2\nline3')
    expect(v.payload).toBe('line1\nline2\nline3')
  })
  test('unbracketed text is returned whole rather than dropped', () => {
    expect(parseContext('just some text')).toEqual({ tag: '', payload: 'just some text' })
  })
  test('payload may itself contain brackets', () => {
    expect(parseContext('[USER]\nsee [this] and that').payload).toBe('see [this] and that')
  })
})

describe('contextToMessage', () => {
  test('USER becomes a text part', () => {
    expect(contextToMessage('[USER]\n嗨')).toEqual({
      role: 'user',
      parts: [{ type: 'text', content: '嗨' }],
    })
  })
  test('TOOL RESULT becomes a tool_call_response part, keeping the id', () => {
    // The id is a tool-call id on the llm_request span but a tool *name* on the
    // tool span; both forms are carried through verbatim rather than normalised.
    expect(contextToMessage('[TOOL RESULT: call_00_ET_abc]\nhi')).toEqual({
      role: 'tool',
      parts: [{ type: 'tool_call_response', id: 'call_00_ET_abc', response: 'hi' }],
    })
  })
  test('an unknown tag keeps its content instead of vanishing', () => {
    const m = contextToMessage('[SOMETHING NEW]\npayload')
    expect(m?.parts[0]).toEqual({ type: 'text', content: '[SOMETHING NEW]\npayload' })
  })
  test('whitespace-only context produces no message', () => {
    expect(contextToMessage('   ')).toBeUndefined()
  })
})

describe('contextPayloadFor', () => {
  test('extracts only the requested header', () => {
    expect(contextPayloadFor('[TOOL INPUT: Bash]\n{"command":"ls"}', 'TOOL INPUT')).toBe('{"command":"ls"}')
    expect(contextPayloadFor('[TOOL RESULT: Bash]\nhi', 'TOOL INPUT')).toBeUndefined()
    expect(contextPayloadFor(undefined, 'TOOL INPUT')).toBeUndefined()
  })
})

describe('trace id derivation', () => {
  test('is deterministic, so a re-export or relay restart does not fork a trace', () => {
    expect(deriveTraceId('abc')).toBe(deriveTraceId('abc'))
    expect(deriveTraceId('abc')).not.toBe(deriveTraceId('abd'))
  })
  test('produces valid OTLP ids: 32 hex chars for a trace, 16 for a span', () => {
    expect(deriveTraceId('abc')).toMatch(/^[0-9a-f]{32}$/)
    expect(deriveRootSpanId('abc')).toMatch(/^[0-9a-f]{16}$/)
    expect(deriveRootSpanId('abc')).not.toBe(deriveTraceId('abc').slice(0, 16))
  })
})

describe.if(haveCapture)('mapTracesPayload on a real capture', () => {
  const map = (grouping: 'session' | 'none' = 'session') => {
    const payload = readJson('000-_v1_traces.bin')
    const stats = mapTracesPayload(payload, { grouping, rootedSessions: new Set() })
    return { payload, stats, spans: allSpans(payload) }
  }

  test('classifies LLM and TOOL spans', () => {
    const { spans, stats } = map()
    expect(stats.llmSpans).toBe(2)
    expect(stats.toolSpans).toBe(1)
    const llm = spans.filter((s) => one([s], 'lmnr.span.type') === 'LLM')
    const tool = spans.filter((s) => one([s], 'lmnr.span.type') === 'TOOL')
    expect(llm.every((s) => s.name === 'claude_code.llm_request')).toBe(true)
    expect(tool.every((s) => s.name === 'Bash')).toBe(true)
  })

  test('LLM spans carry model and token counts under gen_ai names', () => {
    const { spans } = map()
    const llm = spans.filter((s) => one([s], 'lmnr.span.type') === 'LLM')
    expect(one([llm[0]], 'gen_ai.request.model')).toBe('deepseek-v4-flash')
    expect(one([llm[0]], 'gen_ai.usage.output_tokens')).toBe(57)

    // An uncached request: the sum and Claude Code's own number coincide, so
    // this alone would not catch a regression.
    expect(one([llm[0]], 'gen_ai.usage.input_tokens')).toBe(24113)
    expect(one([llm[0]], 'gen_ai.usage.input_tokens')).toBe(one([llm[0]], 'input_tokens'))
  })

  test('gen_ai.usage.input_tokens is the INCLUSIVE total, cache included', () => {
    // The whole reason this is a test rather than a passthrough: Claude Code
    // reports 247 uncached tokens and 23936 cached ones separately, while
    // Laminar's convention is that `input_tokens` is the total of the two.
    // Forwarding 247 gives Laminar a "total" smaller than its own cache count,
    // and it silently repairs that upward -- reporting neither real number.
    const { spans } = map()
    const cached = spans.find(
      (s) => one([s], 'lmnr.span.type') === 'LLM' && one([s], 'cache_read_tokens') === 23936,
    )
    expect(cached).toBeDefined()
    expect(one([cached], 'input_tokens')).toBe(247) // Claude Code's uncached figure
    expect(one([cached], 'gen_ai.usage.input_tokens')).toBe(24183) // 247 + 23936
    expect(one([cached], 'gen_ai.usage.cache_read_input_tokens')).toBe(23936)
    // The raw attributes stay untouched, so the SQL view still shows the
    // original breakdown alongside Laminar's convention.
    expect(one([cached], 'cache_read_tokens')).toBe(23936)
  })

  test('cache-creation tokens count towards the total too', () => {
    const payload = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  name: 'claude_code.llm_request',
                  attributes: [
                    { key: 'span.type', value: { stringValue: 'llm_request' } },
                    { key: 'input_tokens', value: { intValue: 10 } },
                    { key: 'cache_read_tokens', value: { intValue: 100 } },
                    { key: 'cache_creation_tokens', value: { intValue: 1000 } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }
    mapTracesPayload(payload, { grouping: 'none', rootedSessions: new Set() })
    const attrs = payload.resourceSpans[0].scopeSpans[0].spans[0].attributes
    const read = (k: string) => attrs.find((a) => a.key === k)?.value
    expect(read('gen_ai.usage.input_tokens')).toEqual({ intValue: 1110 })
    expect(read('gen_ai.usage.cache_creation_input_tokens')).toEqual({ intValue: 1000 })
  })

  test('the assistant reply becomes gen_ai.output.messages', () => {
    const { spans } = map()
    const outs = getAll(spans, 'gen_ai.output.messages').map((s) => JSON.parse(String(s)))
    expect(outs).toContainEqual([
      { role: 'assistant', parts: [{ type: 'text', content: '你好！' }] },
    ])
    expect(outs).toContainEqual([
      { role: 'assistant', parts: [{ type: 'text', content: '你好！命令输出：`hi`' }] },
    ])
  })

  test('the user prompt becomes gen_ai.input.messages', () => {
    const { spans } = map()
    const ins = getAll(spans, 'gen_ai.input.messages').map((s) => JSON.parse(String(s)))
    expect(ins[0]).toEqual([
      { role: 'user', parts: [{ type: 'text', content: '用一句话说你好，然后运行 echo hi 命令。' }] },
    ])
    // The second request's context is the tool result, not the original prompt.
    expect(ins[1][0].role).toBe('tool')
    expect(ins[1][0].parts[0].type).toBe('tool_call_response')
  })

  test('TOOL spans get a readable name, input and output', () => {
    const { spans } = map()
    const tool = spans.find((s) => one([s], 'lmnr.span.type') === 'TOOL')
    expect(tool.name).toBe('Bash')
    expect(JSON.parse(String(one([tool], 'lmnr.span.input')))).toMatchObject({ command: 'echo hi' })
    expect(JSON.parse(String(one([tool], 'lmnr.span.output')))).toMatchObject({ stdout: 'hi' })
  })

  test('the tool sub-spans keep their parent and stay DEFAULT', () => {
    const { spans } = map()
    const subs = spans.filter((s) => s.name.startsWith('claude_code.tool.'))
    expect(subs.length).toBe(2)
    for (const sub of subs) {
      expect(one([sub], 'lmnr.span.type')).toBeUndefined()
      expect(sub.parentSpanId).toBe(spans.find((s) => s.name === 'Bash').spanId)
    }
  })

  test('every span lands in one trace, under one synthetic root', () => {
    const { spans } = map()
    const sessionId = String(one(spans, 'session.id'))
    expect(new Set(spans.map((s) => s.traceId))).toEqual(new Set([deriveTraceId(sessionId)]))

    const rootId = deriveRootSpanId(sessionId)
    const root = spans.find((s) => s.spanId === rootId)
    expect(root).toBeDefined()
    expect(root.name).toBe('session')
    // Every other span ultimately reaches the root; previously N spans were
    // roots of their own traces.
    const orphans = spans.filter((s) => s.spanId !== rootId && !s.parentSpanId)
    expect(orphans).toEqual([])
  })

  test('the session root is emitted once per session, not once per batch', () => {
    const rootedSessions = new Set<string>()
    const p1 = readJson('000-_v1_traces.bin')
    mapTracesPayload(p1, { grouping: 'session', rootedSessions })
    const p2 = readJson('000-_v1_traces.bin')
    mapTracesPayload(p2, { grouping: 'session', rootedSessions })
    const roots2 = allSpans(p2).filter((s: any) => s.name === 'session')
    expect(roots2).toEqual([])
  })

  test('grouping "none" is a faithful pass-through baseline', () => {
    const before = readJson('000-_v1_traces.bin')
    const beforeIds = allSpans(before).map((s: any) => s.traceId)
    const { payload, spans } = map('none')
    expect(spans.filter((s) => s.name === 'session')).toEqual([])
    expect(allSpans(payload).map((s) => s.traceId)).toEqual(beforeIds)
  })

  test('applying the mapping twice is a no-op, not a double-apply', () => {
    const rootedSessions = new Set<string>()
    const payload = readJson('000-_v1_traces.bin')
    mapTracesPayload(payload, { grouping: 'session', rootedSessions })
    const once = JSON.stringify(payload)
    const stats = mapTracesPayload(payload, { grouping: 'session', rootedSessions })
    expect(stats.skippedAlreadyMapped).toBe(stats.spans)
    expect(JSON.stringify(payload)).toBe(once)
  })

  test('a restart mid-session re-sends the root at most once per batch', () => {
    // A fresh `rootedSessions` models a relay restart: the set is gone, but the
    // re-export may already carry the root from the first pass. Exactly one root
    // must survive, not two.
    const payload = readJson('000-_v1_traces.bin')
    mapTracesPayload(payload, { grouping: 'session', rootedSessions: new Set() })
    mapTracesPayload(payload, { grouping: 'session', rootedSessions: new Set() })
    expect(allSpans(payload).filter((s: any) => s.name === 'session').length).toBe(1)
  })

  test('Laminar association keys are set from the real session and user', () => {
    const { spans } = map()
    expect(one(spans, 'lmnr.association.properties.session_id')).toBe(one(spans, 'session.id'))
    expect(one(spans, 'lmnr.association.properties.user_id')).toBe(one(spans, 'user.id'))
  })

  test('no attribute is left with an unset-oneof value shape', () => {
    // protobufjs reads an unset oneof branch as that branch's default, so an
    // empty `value: {}` would encode as a present-but-zero attribute.
    for (const span of map().spans) {
      for (const attr of span.attributes) {
        expect(Object.keys(attr.value).length, `attribute ${attr.key}`).toBe(1)
      }
    }
  })
})

describe.if(haveCapture)('mapLogsPayload on a real capture', () => {
  test('tags log records with the session trace id', () => {
    const payload = readJson('001-_v1_logs.bin')
    const { records, tagged } = mapLogsPayload(payload, { grouping: 'session', rootedSessions: new Set() })
    expect(records).toBeGreaterThan(20)
    expect(tagged).toBe(records)
    const all = payload.resourceLogs.flatMap((rl: any) => rl.scopeLogs.flatMap((sl: any) => sl.logRecords))
    const sessionId = String(all[0].attributes.find((a: any) => a.key === 'session.id').value.stringValue)
    expect(new Set(all.map((r: any) => r.traceId))).toEqual(new Set([deriveTraceId(sessionId)]))
  })

  test('grouping "none" leaves the original (empty) trace ids alone', () => {
    const payload = readJson('001-_v1_logs.bin')
    mapLogsPayload(payload, { grouping: 'none', rootedSessions: new Set() })
    const all = payload.resourceLogs.flatMap((rl: any) => rl.scopeLogs.flatMap((sl: any) => sl.logRecords))
    expect(all.every((r: any) => !r.traceId)).toBe(true)
  })
})

describe('attribute encoding', () => {
  test('a set attribute never ends up with two oneof branches', () => {
    const payload = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  name: 'claude_code.llm_request',
                  traceId: 'aa'.repeat(16),
                  spanId: 'bb'.repeat(8),
                  attributes: [
                    { key: 'span.type', value: { stringValue: 'llm_request' } },
                    { key: 'input_tokens', value: { intValue: 5 } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }
    mapTracesPayload(payload, { grouping: 'none', rootedSessions: new Set() })
    const attrs = payload.resourceSpans[0].scopeSpans[0].spans[0].attributes
    const type = attrs.find((a) => a.key === 'lmnr.span.type')
    expect(type?.value).toEqual({ stringValue: 'LLM' })
    expect(own(type!.value, 'intValue')).toBe(false)
  })
})
