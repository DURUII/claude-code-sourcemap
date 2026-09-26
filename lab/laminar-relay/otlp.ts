// OTLP/JSON -> OTLP/protobuf encoding.
//
// Why this exists at all: Claude Code's beta-tracing path uses the
// `@opentelemetry/exporter-*-otlp-http` exporters, which serialise to **JSON**.
// Laminar accepts JSON on POST /v1/traces but NOT on POST /v1/logs -- its
// published API reference declares exactly one media type for the logs route
// (`application/x-protobuf`, operationId `ingestLogs`), and the live server
// answers a JSON body with 500 "failed to decode Protobuf message". So every
// log record the CLI emitted was being dropped server-side, silently.
// Re-encoding the same payload as protobuf is what recovers them.
//
// The schema below is the OTLP wire schema, transcribed with the field numbers
// from the OpenTelemetry proto definitions. Field numbers are load-bearing:
// they are what goes on the wire, so a wrong one corrupts the message in a way
// that still decodes cleanly.
import protobuf from 'protobufjs'

const SCHEMA = `
syntax = "proto3";
package otlp;

message AnyValue {
  oneof value {
    string string_value = 1;
    bool bool_value = 2;
    int64 int_value = 3;
    double double_value = 4;
    ArrayValue array_value = 5;
    KeyValueList kvlist_value = 6;
    bytes bytes_value = 7;
  }
}
message ArrayValue { repeated AnyValue values = 1; }
message KeyValueList { repeated KeyValue values = 1; }
message KeyValue { string key = 1; AnyValue value = 2; }
message InstrumentationScope {
  string name = 1;
  string version = 2;
  repeated KeyValue attributes = 3;
  uint32 dropped_attributes_count = 4;
}
message Resource {
  repeated KeyValue attributes = 1;
  uint32 dropped_attributes_count = 2;
}

// ---- traces ----
message ResourceSpans {
  Resource resource = 1;
  repeated ScopeSpans scope_spans = 2;
  string schema_url = 3;
}
message ScopeSpans {
  InstrumentationScope scope = 1;
  repeated Span spans = 2;
  string schema_url = 3;
}
message TracesData { repeated ResourceSpans resource_spans = 1; }
enum SpanKind {
  SPAN_KIND_UNSPECIFIED = 0;
  SPAN_KIND_INTERNAL = 1;
  SPAN_KIND_SERVER = 2;
  SPAN_KIND_CLIENT = 3;
  SPAN_KIND_PRODUCER = 4;
  SPAN_KIND_CONSUMER = 5;
}
enum StatusCode {
  STATUS_CODE_UNSET = 0;
  STATUS_CODE_OK = 1;
  STATUS_CODE_ERROR = 2;
}
message Status {
  string message = 2;
  StatusCode code = 3;
}
message Event {
  fixed64 time_unix_nano = 1;
  string name = 2;
  repeated KeyValue attributes = 3;
  uint32 dropped_attributes_count = 4;
}
message Link {
  bytes trace_id = 1;
  bytes span_id = 2;
  string trace_state = 3;
  repeated KeyValue attributes = 4;
  uint32 dropped_attributes_count = 5;
  fixed32 flags = 6;
}
message Span {
  bytes trace_id = 1;
  bytes span_id = 2;
  string trace_state = 3;
  bytes parent_span_id = 4;
  string name = 5;
  SpanKind kind = 6;
  fixed64 start_time_unix_nano = 7;
  fixed64 end_time_unix_nano = 8;
  repeated KeyValue attributes = 9;
  uint32 dropped_attributes_count = 10;
  repeated Event events = 11;
  uint32 dropped_events_count = 12;
  repeated Link links = 13;
  uint32 dropped_links_count = 14;
  Status status = 15;
  fixed32 flags = 16;
}

// ---- logs ----
message ResourceLogs {
  Resource resource = 1;
  repeated ScopeLogs scope_logs = 2;
  string schema_url = 3;
}
message ScopeLogs {
  InstrumentationScope scope = 1;
  repeated LogRecord log_records = 2;
  string schema_url = 3;
}
message LogsData { repeated ResourceLogs resource_logs = 1; }
enum SeverityNumber {
  SEVERITY_NUMBER_UNSPECIFIED = 0;
  SEVERITY_NUMBER_TRACE = 1;
  SEVERITY_NUMBER_DEBUG = 5;
  SEVERITY_NUMBER_INFO = 9;
  SEVERITY_NUMBER_WARN = 13;
  SEVERITY_NUMBER_ERROR = 17;
  SEVERITY_NUMBER_FATAL = 21;
}
message LogRecord {
  fixed64 time_unix_nano = 1;
  SeverityNumber severity_number = 2;
  string severity_text = 3;
  AnyValue body = 5;
  repeated KeyValue attributes = 6;
  uint32 dropped_attributes_count = 7;
  fixed32 flags = 8;
  bytes trace_id = 9;
  bytes span_id = 10;
  fixed64 observed_time_unix_nano = 11;
  string event_name = 12;
}
`

const root = protobuf.parse(SCHEMA, { keepCase: false }).root
const TracesData = root.lookupType('otlp.TracesData')
const LogsData = root.lookupType('otlp.LogsData')

/**
 * OTLP/JSON spells trace and span IDs as lowercase hex, but protobuf `bytes`
 * decodes base64. `fromObject` would happily consume the hex string as if it
 * were base64 and produce a silently wrong ID -- which does not throw, it just
 * files your spans under a garbage trace. Convert explicitly.
 */
export function hexToBuffer(hex: string | undefined | null): Buffer {
  if (!hex) return Buffer.alloc(0)
  const s = String(hex).trim()
  if (s.length === 0) return Buffer.alloc(0)
  if (!/^[0-9a-fA-F]+$/.test(s) || s.length % 2 !== 0) {
    throw new Error(`invalid hex id: ${JSON.stringify(hex)}`)
  }
  return Buffer.from(s, 'hex')
}

/** Encode one OTLP/JSON trace payload to OTLP/protobuf bytes. */
export function encodeTraces(json: unknown): Buffer {
  fixIds(json, ['traceId', 'spanId', 'parentSpanId'])
  // `fromObject` validates types but not much else; a wrong field name is
  // silently dropped by protobufjs (unknown keys are ignored), so anything the
  // mapping produces that the schema does not know about simply vanishes. Keep
  // the schema in lockstep with what mapping.ts emits.
  const err = TracesData.verify(TracesData.fromObject(json as object))
  if (err) throw new Error(`traces payload failed verification: ${err}`)
  return Buffer.from(TracesData.encode(TracesData.fromObject(json as object)).finish())
}

/** Encode one OTLP/JSON logs payload to OTLP/protobuf bytes. */
export function encodeLogs(json: unknown): Buffer {
  fixIds(json, ['traceId', 'spanId'])
  const err = LogsData.verify(LogsData.fromObject(json as object))
  if (err) throw new Error(`logs payload failed verification: ${err}`)
  return Buffer.from(LogsData.encode(LogsData.fromObject(json as object)).finish())
}

// Decoders exist so tests can prove a round trip, and so a human debugging the
// relay can read what it actually put on the wire.
//
// `bytes: String` makes protobufjs render byte fields as base64, so IDs come
// back out as base64 even though they went in as hex. Put them back into hex,
// which is the OTLP/JSON convention and what every other tool shows.
const toHex = (b64: string) => (b64 ? Buffer.from(b64, 'base64').toString('hex') : '')

function idsToHex(node: any): any {
  if (node === null || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(idsToHex)
  const out: any = {}
  for (const [k, v] of Object.entries(node)) {
    out[k] = ID_KEYS.has(k) && typeof v === 'string' ? toHex(v) : idsToHex(v)
  }
  return out
}
const ID_KEYS = new Set(['traceId', 'spanId', 'parentSpanId'])

export const decodeTraces = (buf: Uint8Array): any =>
  idsToHex(TracesData.toObject(TracesData.decode(buf), { longs: String, bytes: String, defaults: false }))
export const decodeLogs = (buf: Uint8Array): any =>
  idsToHex(LogsData.toObject(LogsData.decode(buf), { longs: String, bytes: String, defaults: false }))

/**
 * Walk the payload and rewrite every listed ID field from hex to a Buffer.
 * Done in place on a parsed copy -- the caller owns the object.
 */
function fixIds(node: any, keys: string[]): void {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) fixIds(item, keys)
    return
  }
  for (const key of keys) {
    if (typeof node[key] === 'string') node[key] = hexToBuffer(node[key])
  }
  for (const value of Object.values(node)) fixIds(value, keys)
}
