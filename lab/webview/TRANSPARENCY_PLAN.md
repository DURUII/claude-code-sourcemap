# Transparent Claude Code Plan

## Goal

Build a transparent learning version of Claude Code.

The product should not be a prettier chat log. It should show how Claude Code works as a live, inspectable transparency workbench: how context is assembled, which request is sent, which tools are selected, what each tool receives and returns, how the result is folded back into context, and what the WebView finally renders.

The reference interaction borrows from Learn Git Branching / git graph, but it should not force everything into a graph. Claude Code's request is not just a chain of small commits. It contains large text blocks, nested JSON schemas, cache scopes, attachments, tool definitions, HTTP payloads, and streaming deltas. The right source of truth is an event ledger plus rich payload snapshots, with graph-like relation maps only where they clarify causality.

## Reference Roles

### restored-src

`restored-src` is the mechanism source of truth.

`claude-code-trace` can reconstruct what happened from Claude Code's JSONL files, but `restored-src` explains why it happened: how prompt sections are selected, how context is injected, how attachments are surfaced, how tools/MCP/skills affect the request, and how cache boundaries shape the final API payload.

The core request-construction pipeline is:

1. `fetchSystemPromptParts()` gathers the three high-level inputs: default system prompt, user context, and system context.
2. `getSystemPrompt()` builds static and dynamic system prompt sections.
3. `resolveSystemPromptSections()` caches stable dynamic sections and recomputes explicitly volatile sections.
4. `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` separates globally cacheable static prompt text from session-specific dynamic text.
5. `appendSystemContext()` appends system context such as git status to the system prompt path.
6. `prependUserContext()` injects `CLAUDE.md`, current date, and related user context as a meta `<system-reminder>` user message.
7. attachment collection surfaces skill listings, MCP instruction deltas, plan mode state, date changes, changed files, nested memory, todo reminders, and other tail-context facts.
8. `buildSystemPromptBlocks()` converts the assembled system prompt into Anthropic API text blocks with the correct `cache_control` scopes.

This is the layer that makes the transparent UI educational rather than merely forensic. The user should be able to click a context node and see which restored-src function created it, whether it entered top-level `system`, a meta user message, an attachment, a tool schema, or a cache marker.

The important correction is that `restored-src` is not only static reference code. It is a runnable CLI:

1. `package.json` exposes the `claude` binary.
2. `bin/claude` executes `bun ./src/entrypoints/cli.tsx`.
3. `src/entrypoints/cli.tsx` enters the real CLI flow, including `--print`, `--debug`, `--debug-file`, session flags, output formats, and model/query routing.
4. The request path then reaches `QueryEngine`, `fetchSystemPromptParts()`, `query.ts`, and `services/api/claude.ts`.

That means the transparent project should not only infer Claude Code behavior from the outside. It can instrument the real CLI from the inside and emit first-class transparency events at the exact points where context, request blocks, cache scopes, tool rounds, and stream chunks are created.

This also changes the capture strategy. Without a runnable/editable CLI, the natural approach would be MITM, packet capture, forward proxy, reverse proxy, or post-hoc log parsing. With `restored-src`, proxy-based capture should not be part of the main design. The primary path is in-process semantic instrumentation. HTTP is still visible, but as an artifact emitted by the CLI/runtime, not as something recovered by sitting between the CLI and the network.

### lab/webview

`lab/webview` is the runtime shell for a transparent Claude Code.

Its current entry chain is:

1. `lab/webview/index.html` loads `public/bridge.js` before the extracted Anthropic WebView bundle.
2. `public/bridge.js` provides `window.acquireVsCodeApi()` and forwards host messages over `/bridge`.
3. `server/index.ts` acts as the standalone extension host over HTTP and WebSocket.
4. `server/agentBridge.ts` calls `@anthropic-ai/claude-agent-sdk` through `query()`.
5. `server/browserBridge.ts` injects an in-process Browser MCP server for browser-tab tools.

This makes `lab/webview` the best place to run the agent and display the transparent teaching UI while the session is happening.

### claude-code-trace

`claude-code-trace` is the best reference for reading Claude Code's real session artifacts.

Its important contribution is not only UI. It already has a normalization pipeline:

1. read `~/.claude/projects/**/*.jsonl`;
2. merge debug hook events from `~/.claude/debug`;
3. classify raw JSONL entries into user / assistant / system / compact / hook events;
4. group adjacent assistant events into chunks;
5. expose display messages with thinking count, tool calls, tool input, tool result, errors, token counts, duration, subagent links, team metadata, and hook metadata;
6. tail session files live through a debounced watcher and broadcast updates through Tauri events or HTTP SSE.

This should become the fact-ingestion model for the transparent workbench.

### input-visualizer

`/Users/durui/Documents/claude-code-explainer/frontend/input-visualizer.html` and `/Users/durui/Documents/claude-code-explainer/references/input.example` are the best reference for request-shape comprehension.

This prototype is rough, but it gets one important thing right: a Claude Code input payload is easier to understand when it is unfolded by semantic sections instead of immediately reduced to graph nodes.

Its useful ideas are:

1. overview cards for model, max tokens, stream mode, thinking config, output config, and metadata;
2. top-level tabs for `system`, `messages`, `tools`, output stream, and raw JSON;
3. system blocks rendered as separate blocks with cache-control tags;
4. message content split into text blocks and cache-control blocks;
5. long text split by Markdown headers, `<system-reminder>`, and `Contents of ...` boundaries;
6. tool definitions rendered as cards with full JSON Schema viewers;
7. output SSE rendered as a timeline plus extracted thinking/text;
8. selection affordances for vocab, comments, underline, and asking about a selected term.

Its limitations define the next step:

1. it is a single request snapshot, not a dynamic process view;
2. it does not explain which `restored-src` function produced a section;
3. it does not connect a visible block to source file and line provenance;
4. it does not show how later turns add, remove, summarize, or cache context;
5. it only shows `messages`, `system`, `tools`, and a small amount of config, so it misses debug/VCR, HTTP, JSON-RPC, MCP, browser, hook, permission, and rendering layers.

This should become the payload-inspection surface inside the transparent product.

### ZimaOS-Blue

`ZimaOS-Blue` is the best reference for productizing observability, and it has two separate lessons.

The first lesson is turn detail:

1. persist one turn as the smallest explainable unit;
2. store metrics, raw request, raw response, tool summaries, latency, token, cache, cost, status, and error type;
3. expose dev APIs for session turns, turn detail, replay, aggregate stats, and unified audit;
4. show a Turn Detail panel with human summary plus raw JSON;
5. provide one-click diagnostic export.

This should become the debugging and share/export pattern for the transparent workbench.

The second lesson is the earlier companion/sidebar prototype:

1. collect session events into an append-only companion store;
2. build a lightweight `FlowGraph` from message, tool-call, LLM-request, and security-check events;
3. expose flow and event APIs for a selected session;
4. provide replay timeline semantics with relative event time, playback speed, gap normalization, event lookup, and event filtering;
5. render these facts in side panels/drawers rather than forcing a full-screen graph at the beginning.

This matters because the first transparent Claude Code UI does not need to be a complete graph workspace. A sidebar can be the correct prototype: small, always adjacent to the WebView, and focused on the currently selected turn or artifact. A relation map can start as a narrow side panel, then expand once the event model is stable.

## Unification Model

The three reference projects should not remain three separate features. They should collapse into one model:

1. Blue contributes the operational unit: session, turn, timeline event, metrics, replay, diagnostic export.
2. `input-visualizer.html` contributes the artifact unit: request payload, system block, message block, tool schema, output stream, raw JSON.
3. `claude-code-trace` contributes the persisted-history unit: JSONL entry, chunk, display item, tool call/result, hook event, subagent/sidechain.
4. `restored-src` contributes the causal unit: source function, source file/line, construction step, cache decision, attachment decision, final API block construction.

The fourth unit is what makes this project qualitatively different from an external observer. Because the CLI can be run and modified, the system can record semantic events before they are flattened into HTTP JSON. That is stronger than MITM or proxy capture: it preserves intent, source provenance, cache decisions, and intermediate artifacts that never appear on the wire.

The unified primitive is not "graph node". The unified primitive is an explainable artifact event:

```ts
type ExplainableArtifactEvent = {
  id: string;
  traceId: string;
  sessionId?: string;
  turnId?: string;
  timestamp: number;
  phase:
    | "input"
    | "context"
    | "assembly"
    | "request"
    | "stream"
    | "tool"
    | "transport"
    | "foldback"
    | "render"
    | "debug"
    | "replay";
  artifact:
    | "system_block"
    | "message_block"
    | "tool_schema"
    | "attachment"
    | "cache_boundary"
    | "api_request"
    | "http_request"
    | "json_rpc_request"
    | "mcp_call"
    | "tool_call"
    | "tool_result"
    | "stream_delta"
    | "webview_event"
    | "session_jsonl_entry"
    | "debug_hook"
    | "vcr_record";
  summary: string;
  payloadRef?: {
    jsonPath?: string;
    textRange?: [number, number];
    hash?: string;
    length?: number;
    redacted?: boolean;
  };
  provenance?: {
    sourceFile?: string;
    sourceLine?: number;
    sourceFunction?: string;
    jsonlPath?: string;
    jsonlLine?: number;
    requestId?: string;
    toolUseId?: string;
  };
  relations?: Array<{
    type:
      | "created_by"
      | "included_in"
      | "derived_from"
      | "cached_as"
      | "sent_as"
      | "triggered"
      | "returned_to"
      | "rendered_by";
    targetId: string;
  }>;
  metrics?: Record<string, number | string | boolean>;
};
```

Everything else is a projection:

- Blue-style sidebar/timeline is the operational projection.
- HTML-style payload inspector is the artifact projection.
- Trace-style session browser is the persisted-history projection.
- Relation map is the causality/provenance projection.
- Diagnostic export is a selected subgraph plus payload bundle.

This is the alignment point: the product should not choose between graph, timeline, trace, and payload viewer. It should make them synchronized views over the same artifact-event ledger.

## Product Model

The transparent Claude Code UI should have synchronized surfaces. The graph is one projection, not the whole product.

### 0. Sidebar Surface

This is the realistic first UI.

The sidebar sits next to the running WebView and shows the current turn as a compact flow:

- Context
- Request
- Stream
- Tool
- Result
- Render

Each row is an event or artifact in compact form. Clicking a row opens the detail panel. Expanding the sidebar can open either the payload surface, the timeline surface, or the relation map.

This preserves the spirit of the Blue prototype: a sidecar observer first, not a disruptive replacement for the main agent UI.

### 1. Payload Surface

This is the main learning view for one request or one turn.

It generalizes `input-visualizer.html` from a static snapshot into a provenance-aware request/workflow inspector:

- Overview: model, stream mode, thinking/output config, token budget, cache policy, metadata, session id.
- System: system blocks, static/dynamic split, cache-control scopes, `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`, source function.
- Messages: user messages, meta `<system-reminder>` messages, tool results, assistant messages, attachment-derived reminders.
- Tools: tool schemas, MCP tools, browser tools, permission behavior, source/provider.
- Attachments: `skill_listing`, MCP instruction deltas, changed files, nested memory, date change, todo/plan reminders.
- Transport: final API request shape, HTTP headers after redaction, body hash/size, request id.
- Output: stream timeline, thinking deltas, text deltas, tool-use deltas, stop reason, usage.
- Raw: exact JSON when allowed, redacted JSON by default.

The critical upgrade over the prototype is provenance. Every visible block should be linkable to:

- source function in `restored-src`;
- source file and line where feasible;
- event id in the transparency ledger;
- JSON path inside the final request;
- previous/next turn diff.

### 2. Timeline Surface

This explains motion.

The timeline should show how a single turn evolves:

- user input received;
- context sources loaded;
- system sections resolved;
- user context prepended;
- attachments collected;
- tools listed;
- request blocks built;
- HTTP request sent;
- stream chunks received;
- tool use requested;
- permission decided;
- tool executed;
- tool result folded back;
- WebView render event sent.

This is not merely chronological logging. Each timeline event links to the concrete payload region it changed.

### 3. Relation Map

This is the graph-like surface, but it should be constrained.

It answers relationship questions:

- "why is this block present?"
- "which source produced this request section?"
- "which tool result caused this later assistant text?"
- "which HTTP request belongs to this MCP call?"
- "which WebView render event displayed this assistant chunk?"

The relation map should not try to display every byte. Large payloads stay in the payload surface. The relation map shows anchors, dependencies, and causality.

Each node is a concrete runtime artifact:

- user prompt;
- `CLAUDE.md` / memory / skill / MCP / environment context;
- assembled system prompt section;
- assembled user-context reminder;
- attachment;
- cache boundary;
- cache-control block;
- tool schema;
- final SDK input message;
- model request;
- model stream chunk;
- assistant text;
- tool-use decision;
- permission request;
- tool input;
- HTTP request;
- JSON-RPC request;
- MCP request;
- CLI invocation;
- browser command;
- tool result;
- debug hook;
- VCR record;
- final WebView render event.

Each edge answers one question:

- "was included in";
- "triggered";
- "requested permission for";
- "called";
- "returned";
- "was summarized into";
- "was appended back to context";
- "was rendered as".

The relation map should support collapsed layers by default:

- Context Assembly
- Request
- Model Stream
- Tool Round
- Browser / HTTP / JSON-RPC
- Result Folding
- UI Render

Opening a layer reveals the exact nodes and raw payloads.

### 4. Detail Surface

Clicking an event, payload block, timeline row, or relation-map node opens a detail panel.

Every detail panel should use the same structure:

- Summary: human-readable explanation of what happened.
- Raw: exact JSON / HTTP / CLI / SDK payload.
- Metrics: timing, token, cache, byte size, retry count, status.
- Provenance: source file, session JSONL line, request id, parent id, timestamp.
- Replay: copyable request or replay handle when feasible.

This mirrors `claude-code-trace` detail views and `ZimaOS-Blue` turn detail, but shifts from "message details" to "explainable runtime artifact details".

### 5. Transcript Surface

The transcript stays available because it is still the user-facing story.

But each message should be backed by transparency links:

- "why did this answer include X?"
- "which context nodes were active?"
- "which tool calls produced this claim?"
- "which request/response pair generated this text?"

The transcript should never be the only observability surface.

## Data Model

The core abstraction should be a transparent run composed of four parts:

1. append-only event ledger;
2. payload objects for large text/JSON/schema bodies;
3. source provenance for code-level causality;
4. derived views for sidebar, payload inspector, timeline, relation map, transcript, and export.

Events should describe what happened. Payload objects should hold the real content. Provenance should explain why and where the content was produced.

```ts
type TransparentRun = {
  id: string;
  sessionId?: string;
  events: ExplainableArtifactEvent[];
  payloads: PayloadObject[];
  provenance: SourceProvenance[];
};

type ExplainableArtifactEvent = {
  id: string;
  parentId?: string;
  traceId: string;
  sessionId?: string;
  channelId?: string;
  turnId?: string;
  timestamp: number;
  phase:
    | "input"
    | "context"
    | "assembly"
    | "request"
    | "stream"
    | "tool"
    | "transport"
    | "foldback"
    | "webview"
    | "debug"
    | "replay";
  kind: string;
  artifact:
    | "system_block"
    | "message_block"
    | "tool_schema"
    | "attachment"
    | "cache_boundary"
    | "api_request"
    | "http_request"
    | "json_rpc_request"
    | "mcp_call"
    | "tool_call"
    | "tool_result"
    | "stream_delta"
    | "webview_event"
    | "session_jsonl_entry"
    | "debug_hook"
    | "vcr_record";
  title: string;
  summary?: string;
  payloadRef?: {
    payloadId?: string;
    jsonPath?: string;
    textRange?: [number, number];
    hash?: string;
    length?: number;
    redacted?: boolean;
  };
  relations?: Array<{
    type:
      | "created_by"
      | "included_in"
      | "derived_from"
      | "cached_as"
      | "sent_as"
      | "triggered"
      | "returned_to"
      | "rendered_by";
    targetId: string;
  }>;
  metrics?: {
    durationMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    bytesIn?: number;
    bytesOut?: number;
    statusCode?: number;
  };
  source?: SourceProvenanceRef;
};

type PayloadObject = {
  id: string;
  type:
    | "system_block"
    | "message"
    | "tool_schema"
    | "api_request"
    | "api_response"
    | "attachment"
    | "http_body"
    | "json_rpc_body"
    | "debug_record"
    | "vcr_record";
  format: "text" | "json" | "jsonl" | "markdown" | "sse";
  content?: unknown;
  hash: string;
  byteLength: number;
  tokenEstimate?: number;
  redactionState: "none" | "redacted" | "hash_only";
};

type SourceProvenanceRef = {
  provenanceId?: string;
  sourceFile?: string;
  sourceLine?: number;
  sourceFunction?: string;
  jsonlPath?: string;
  jsonlLine?: number;
  requestId?: string;
  toolUseId?: string;
};

type SourceProvenance = {
  id: string;
  payloadId?: string;
  producedBy?: {
    file: string;
    function?: string;
    line?: number;
    phase?: string;
  };
  inputRefs?: string[];
  eventRefs?: string[];
  reason?: string;
  externalRefs?: {
    jsonlPath?: string;
    jsonlLine?: number;
    requestId?: string;
    toolUseId?: string;
  };
};
```

The relation map is a projection of this model. The transcript, detail panel, timeline, payload inspector, and export are also projections of the same model.

## Capture Points

### restored-src Runnable CLI

Instrument `restored-src` as the most authoritative capture source.

Use a minimal opt-in trace sink first:

- `CLAUDE_CODE_TRANSPARENCY_TRACE=/path/to/events.jsonl` for local JSONL output;
- optionally `CLAUDE_CODE_TRANSPARENCY_ENDPOINT=http://127.0.0.1:.../transparency/ingest` for live `lab/webview` ingestion;
- raw payload capture disabled by default, with hashes, lengths, names, cache scopes, and provenance emitted first;
- raw prompt / raw HTTP / raw tool payloads enabled only in explicit local debug or VCR mode with redaction.

Do not build the first version around MITM, forward proxy, or reverse proxy. For Claude Code itself, proxy capture sees too late and too little: it sees the final transport body, but not why each section exists, which source function produced it, which cache branch was selected, or which attachment was considered and dropped. Those belong inside CLI instrumentation.

Initial instrumentation points:

- `fetchSystemPromptParts()`: start/end, model, tool count, MCP client count, custom system prompt mode, additional directories.
- `getSystemPrompt()`: named static sections, named dynamic sections, boundary placement, section length/hash, null/present state.
- `resolveSystemPromptSections()`: section cache hit/miss, cache-break reason, recompute timing.
- `getSystemContext()`: git-status presence, cache-breaker presence, length/hash, source function.
- `getUserContext()`: `CLAUDE.md`/memory file count, current date, disabled/bare mode, length/hash.
- `prependUserContext()`: meta user-message insertion, section names, final inserted block length/hash.
- `utils/attachments.ts`: attachment type, count, budget/truncation, `skill_listing`, `mcp_instructions_delta`, `date_change`, `changed_files`, `nested_memory`, todo/plan reminders.
- `splitSysPromptPrefix()`: global-cache strategy, dynamic-boundary behavior, block count, cache scopes.
- `buildSystemPromptBlocks()`: Anthropic system block count, cache-control scopes, block length/hash.
- `query.ts` before `deps.callModel`: final model, message count, system block count, tool count, thinking config, query source.
- query checkpoints: API loop start, streaming start, tool execution start/end, abort/error paths.

This is the instrumentation layer that makes the graph causal rather than retrospective. `claude-code-trace` can still import session JSONL afterward, but the CLI trace explains the hidden construction steps that normal session logs do not preserve.

### Browser Bridge

Instrument `public/bridge.js`:

- `postToHost()` before sending WebView messages;
- `dispatchToWebview()` before rendering host messages into the extracted WebView bundle;
- `handleLocalRequest()` for browser-side host behavior;
- browser tab creation and host command polling;
- local preview / diff / markdown / content windows.

This captures what the user sees and what the extracted UI asks the host to do.

### Node Host

Instrument `server/index.ts`:

- every WebSocket client message;
- every host response;
- every HTTP endpoint under `/browser-tabs`, `/browser-host`, `/file`, `/terminal`, `/config`;
- request aborts and socket close;
- bridge errors.

This captures the standalone extension-host protocol.

### Agent SDK

Instrument `server/agentBridge.ts`:

- `launch()` and channel creation;
- `push()` user input;
- `query()` options before execution;
- SDK stream messages from `for await`;
- session id updates;
- permission requests;
- user dialog requests;
- usage/context usage calls;
- plugin/skill reloads;
- MCP server control calls.

This captures the agent execution layer.

### Browser MCP

Instrument `server/browserBridge.ts`:

- tab registration/update/close;
- browser command enqueue/take/resolve;
- host command enqueue/take/resolve;
- every built-in browser MCP tool.

This captures the tool-facing browser bridge.

### Claude Code Session Files

Import the `claude-code-trace` model:

- find the current session JSONL by session id;
- tail the file;
- parse `uuid`, `parentUuid`, `leafUuid`, sidechains, attachments, tool-use blocks, tool-result blocks, compact events, and debug hook events;
- preserve raw JSONL line numbers;
- map normalized messages/chunks into the transparent event ledger.

This gives the graph ground truth even when SDK-level hooks miss a detail.

### Debug and VCR

Add explicit layers for debug and VCR:

- debug events: hook name, hook command, metadata, timestamp, related tool id;
- VCR events: cassette id, request hash, matched request, replayed response, live miss, sanitized fields;
- raw HTTP events: method, URL, headers after redaction, status, body size, timing.

Debug and VCR must not be mixed into generic logs. They should appear as first-class graph nodes because they explain why a tool call behaved differently in live vs replay.

## Graph Layout

Use a DAG layout, not a flat timeline.

Recommended first implementation:

- `@xyflow/react` or equivalent graph renderer for fast iteration;
- swimlanes by layer;
- left-to-right flow within one turn;
- parent-child edges for causality;
- dashed edges for provenance / source references;
- color by layer, not by arbitrary theme;
- collapse/expand at layer and subgraph level.

Longer term:

- support sidechains and subagents as branch lanes;
- show context-cache reuse by drawing shared-prefix edges;
- allow "diff with previous turn" mode;
- allow "why is this node here?" reverse traversal.

## Milestones

### M0: Alignment Document

Deliver this plan and agree on vocabulary:

- transparent Claude Code;
- multi-view transparency;
- event ledger;
- payload object;
- source provenance;
- turn;
- relation-map node;
- relation-map edge;
- capture point;
- replay.

### M1: Event Ledger Skeleton

Add a small event ledger that can accept both `lab/webview` host events and `restored-src` CLI instrumentation events.

Scope:

- in-memory ring buffer first;
- shared `ExplainableArtifactEvent`, `PayloadObject`, and `SourceProvenance` TypeScript schemas plus a JSONL-compatible wire format;
- append events from WebSocket receive/send;
- add `POST /transparency/ingest` for CLI-emitted events;
- add optional file tailing for `CLAUDE_CODE_TRANSPARENCY_TRACE`;
- define first-class node kinds for `system_prompt_section`, `system_context`, `user_context`, `attachment`, `tool_schema`, `cache_boundary`, and `api_request_block`;
- expose `GET /transparency/events`;
- expose `GET /transparency/graph`;
- add tests for event append, parent id, filtering by channel/turn.

Success condition:

- sending one prompt produces visible host-rpc, sdk, and request-construction events without changing the existing WebView behavior. When `lab/webview` runs the local `restored-src/bin/claude`, it sets the trace env var and receives context-assembly events from inside the CLI.

### M2: Graph View Prototype

Add a sidebar-first transparency view.

Scope:

- render a compact current-turn flow in a side panel;
- allow expanding the side panel into a graph route such as `/transparency`;
- support node click detail;
- show raw JSON;
- keep the original WebView available side-by-side or in another tab.

Success condition:

- a user can see `launch_claude -> SDK query -> io_message -> WebView render` without leaving the running WebView.

### M3: Tool Round Transparency

Instrument tool calls deeply.

Scope:

- permission request node;
- tool input node;
- tool result node;
- Browser MCP nodes;
- CLI nodes;
- MCP server control nodes.

Success condition:

- a tool round can be explained without reading terminal logs.

### M4: restored-src Context Assembly Lens

Make context construction visible using `restored-src` as the instrumented source of truth.

Scope:

- add a lightweight `transparencyTrace` module in `restored-src` that emits append-only JSONL/HTTP events when tracing is enabled;
- keep the CLI behavior unchanged when tracing is disabled;
- show `fetchSystemPromptParts()` as the top-level assembly node;
- show `getSystemPrompt()` output split into static sections, boundary, and dynamic sections;
- show `resolveSystemPromptSections()` cache hits/misses for each named section;
- show `getSystemContext()` facts such as git status and cache breaker;
- show `getUserContext()` facts such as `CLAUDE.md` and current date;
- show `prependUserContext()` as the meta user-message injection;
- show attachments from `utils/attachments.ts`, especially `skill_listing`, `mcp_instructions_delta`, `date_change`, `changed_files`, `nested_memory`, and todo/plan reminders;
- show `buildSystemPromptBlocks()` and the final cache-control scopes.

Success condition:

- the user can answer "why was this context in the request, and where did it enter: system, meta user context, attachment, tool schema, or cache marker?" from events emitted by the runnable CLI itself, not only from after-the-fact JSONL reconstruction.

### M5: Claude Code Trace Import

Port or wrap the useful parts of `claude-code-trace`.

Scope:

- locate current session JSONL from session id;
- parse/tail session file;
- merge debug hook events;
- map chunks/items into graph nodes;
- attach jsonl path and line provenance.

Success condition:

- the graph can show both live SDK events and post-hoc Claude Code JSONL facts for the same turn.

### M6: Debug / VCR Lens

Add reproducibility.

Scope:

- capture raw HTTP and JSON-RPC;
- add VCR record/replay metadata;
- display live vs replay differences;
- expose debug-mode values and VCR-mode values side by side.

Success condition:

- the same graph can explain a live run and a replayed run.

### M7: Diagnostic Export

Add one-click export inspired by `ZimaOS-Blue`.

Scope:

- export selected turn/subgraph;
- include environment, model, context nodes, tool nodes, raw request/response, errors, debug/VCR facts;
- redact secrets;
- output Markdown and JSON.

Success condition:

- a bug report can be produced without manually copying chat history or terminal output.

## Design Principles

1. Graph first, transcript second.
2. Raw payloads are always available, but not always expanded.
3. Every displayed claim should have provenance.
4. Every node should be replayable or explain why it is not replayable.
5. Capture should be append-only. Views are projections.
6. Prefer clear failure over hidden fallback.
7. Do not conflate observability with logging. Logs are text; the target is a structured causal model.

## Open Alignment Questions

1. Should `/transparency` be a separate app next to the official WebView, or should it be embedded as a side panel in the same page?
2. Should the first graph focus on one turn only, or the entire session?
3. Should the first version import `claude-code-trace` logic directly, or call its HTTP API when it is running?
4. Should VCR be built into `lab/webview`, or should it read cassettes produced by another harness?
5. What is the first teaching story to optimize for: prompt assembly, tool use, browser automation, or context-cache behavior?
