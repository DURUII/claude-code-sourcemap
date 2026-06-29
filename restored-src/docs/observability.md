---
type: technical
title: Claude Code 调试、可观测性与产品遥测
description: Claude Code restored-src 中调试、性能分析、追踪、遥测与实验配置机制
resource: repo://claude-code-restored/restored-src@cb622b3491c5d642d7225ba500db35d188ab8cea
status: draft
confidence: medium
verification_status: source-inspected
evidence_level: restored-source-inspection
last_verified: "2026-06-29T11:18:15+08:00"
verified_against:
  source_path: .
  commit: cb622b3491c5d642d7225ba500db35d188ab8cea
  claude_code_version: "2.1.88 restored-src"
  package_version: "999.0.0-restored"
  working_tree: dirty
source:
  kind: restored-source
  path: .
  trust: non-authoritative
scope:
  - local-logs
  - profiling
  - perfetto-trace
  - opentelemetry
  - analytics
  - growthbook
entrypoints:
  - path: bin/claude
    purpose: restored runtime wrapper and local telemetry defaults
  - path: src/utils/debug.ts
    purpose: local debug logging
  - path: src/utils/startupProfiler.ts
    purpose: startup profiling
  - path: src/utils/queryProfiler.ts
    purpose: query profiling
  - path: src/utils/telemetry/perfettoTracing.ts
    purpose: Perfetto trace generation
  - path: src/utils/telemetry/instrumentation.ts
    purpose: OpenTelemetry initialization
  - path: src/services/analytics/index.ts
    purpose: product analytics event queue
  - path: src/services/analytics/sink.ts
    purpose: product analytics dispatch
  - path: src/services/analytics/growthbook.ts
    purpose: GrowthBook remote configuration
  - path: src/services/api/apiRequestObserver.ts
    purpose: local API request payload observer
  - path: ../lab/http-visualizer
    purpose: local browser UI for inspected API request payloads
  - path: bin/perfetto
    purpose: open the newest local Perfetto trace
related:
  - deploy/telemetry/README.md
  - README.md
tags:
  - claude-code
  - profiling
  - observability
  - opentelemetry
  - perfetto
  - analytics
  - growthbook
---

# Claude Code 调试、可观测性与产品遥测

> [!WARNING]
> 本文基于 `restored-src` 当前源码审阅，服务于源码阅读、本地复现和实验诊断。该目录是非官方 source map 还原树，不代表 Anthropic 内部仓库结构。


| 层级 | 解决的问题 | 入口 | 主要代码 |
| --- | --- | --- | --- |
| 本地日志 | 这次 session 发生了什么 | `--debug` / `--debug-file` / `DEBUG=1` | `src/utils/debug.ts` |
| 本地 startup profile | CLI 启动到可输入态哪个阶段慢 | `CLAUDE_CODE_PROFILE_STARTUP=1` | `src/utils/startupProfiler.ts` |
| 本地 query profile | 交互模式 query pipeline 哪个阶段慢 | `CLAUDE_CODE_PROFILE_QUERY=1` | `src/utils/queryProfiler.ts`, `src/utils/processUserInput/processUserInput.ts` |
| 本地 headless profile | `-p` 模式 per-turn TTFT、TTFT 之前的 query overhead | `CLAUDE_CODE_PROFILE_STARTUP=1`（与 startup profile 复用同一 env，但守卫在 `getIsNonInteractiveSession()`） | `src/utils/headlessProfiler.ts`, `src/query.ts`, `src/QueryEngine.ts` |
| 本地 trace | API、tool、blocked-on-user 如何串起来 | `CLAUDE_CODE_PERFETTO_TRACE=1` 或路径 | `src/utils/telemetry/perfettoTracing.ts`, `src/utils/telemetry/sessionTracing.ts` |
| 本地 API 请求观察 | 这次真实发给 Claude API 的 payload 是什么 | `CLAUDE_CODE_HTTP_VISUALIZER_ENDPOINT=...` | `src/services/api/apiRequestObserver.ts`, `../lab/http-visualizer` |
| 标准遥测 | 接 Kibana/Elasticsearch + Grafana/Tempo/Loki/Prometheus 等长期观测栈 | `CLAUDE_CODE_ENABLE_TELEMETRY=1` + `OTEL_*` | `src/utils/telemetry/instrumentation.ts` |
| 产品遥测/配置 | 产品事件、采样、实验、feature flag | `logEvent()` / GrowthBook | `src/services/analytics/*`, `src/services/analytics/growthbook.ts` |

三个 profile 模块共用 `src/utils/profilerBase.ts`：同一个 `perf_hooks.performance` 时间轴（进程级 singleton）、同一行格式 `[+total.ms] (+delta.ms) name [| RSS, Heap]`，但各自维护独立的 mark 命名空间（`headless_` 前缀避免冲突）。

## 入口

本地入口是 `bin/claude`。它先把 `CLAUDE_CONFIG_DIR` 默认指向 repo-local `.claude`，再读取可选的 `.claude/telemetry.env`，最后执行：

```bash
bun ./src/entrypoints/cli.tsx "$@"
```

`bin/claude` 是 source-study 设计，不是 production CLI wrapper。它默认追加 `--dangerously-skip-permissions`（受 `CLAUDE_RESTORED_SKIP_PERMS` 控制，默认 1；要恢复标准权限弹窗就 `CLAUDE_RESTORED_SKIP_PERMS=0`）。如果你的复现目标是权限弹窗、auto-mode classifier 决策路径，必须先把这个行为关掉，否则所有工具调用都会静默通过。

如果设了 `CLAUDE_RESTORED_DEBUG=1`，bin/claude 也会自动在参数里追加 `--debug`（前提是用户没自己传 `--debug` / `-d` 之类）。

`CLAUDE_RESTORED_TELEMETRY=1` 是一个新增的总开关。它会默认打开 OTLP、GrowthBook base URL、增强 telemetry、Perfetto trace，并清掉 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`。GrowthBook 还需要你在本地 ignored env 里提供 `CLAUDE_CODE_GB_CLIENT_KEY` 才会真正连上 SDK connection。

`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 的清理是**双重防线**：

1. `bin/claude:49` 在 shell 层 `unset`，仅当 `CLAUDE_RESTORED_TELEMETRY=1` 时执行。
2. `src/utils/managedEnv.ts:93-96` 的 `applyRestoredTelemetryEnvOverrides()` 在 settings 加载后再 `delete` 一次，因为 `.claude/settings.local.json` 可能再次把这个变量设回来（这是 source-study 阶段为离线安静跑设的）。两层都依赖 `CLAUDE_RESTORED_TELEMETRY=1` 这个总开关。

附加默认行为（同样由 `bin/claude` 在 `CLAUDE_RESTORED_TELEMETRY=1` 时设置，未在外部传入时取以下值）：

- `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`
- `CLAUDE_CODE_OTEL_SHUTDOWN_TIMEOUT_MS=5000`
- `CLAUDE_CODE_PERFETTO_TRACE=1`、`CLAUDE_CODE_PERFETTO_WRITE_INTERVAL_S=5`
- `NO_PROXY` / `no_proxy` 自动追加 `localhost,127.0.0.1`
- stderr 是 TTY 且 `CLAUDE_RESTORED_TELEMETRY_BANNER` 不为 0 时，打印 banner（OTLP / Kibana / Elasticsearch / Grafana / GrowthBook / Prometheus / Tempo / Perfetto 的 URL）

关键边界：

- Perfetto 独立于 OTLP。`initializeTelemetry()` 会先调用 `initializePerfettoTracing()`，然后才根据 `CLAUDE_CODE_ENABLE_TELEMETRY` 初始化 OTLP exporter。
- `CLAUDE_CODE_ENABLE_TELEMETRY` 只控制标准 OpenTelemetry exporter，不等于开启内部 analytics。
- GrowthBook 是远程配置/实验层，不实现业务行为；它只能影响源码已经读取的 feature/config key。
- `USER_TYPE=ant` 会打开大量内部路径，需谨慎。
- `src/utils/managedEnvConstants.ts` 是 env allowlist 边界；`OTEL_LOG_USER_PROMPTS` / `OTEL_LOG_TOOL_DETAILS` 这类敏感开关进了 allowlist，运行时 `managedEnv.ts` 决定哪些外部传入的 settings/env 变量可以被采纳。

## 调试

| 对象 | 开关 | 输出 | 用途 |
| --- | --- | --- | --- |
| 全局 debug log | `--debug`, `-d`, `DEBUG=1`, `--debug-file <path>` | 人类可读日志 | 查控制流、HTTP request id、异常路径 |
| Startup profile | `CLAUDE_CODE_PROFILE_STARTUP=1` | `.claude/startup-perf/<session>.txt` | 查 CLI 入口到可输入态耗时和内存 |
| Query profile | `CLAUDE_CODE_PROFILE_QUERY=1` | debug log 中的 query report | 查 context loading、compact、tool schema、client creation、TTFT |
| Headless profile | `CLAUDE_CODE_PROFILE_STARTUP=1`（仅 `-p` 模式生效） | debug log 中的 `[headlessProfiler] Turn N metrics: {...}` | 查 `-p` 模式每个 turn 的 time_to_system_message / time_to_query_start / time_to_first_response / query_overhead |
| Perfetto trace | `CLAUDE_CODE_PERFETTO_TRACE=1` 或 `<path>` | Chrome Trace Event JSON | 在 Perfetto UI 里看 API/tool/session span |
| API request visualizer | `CLAUDE_CODE_HTTP_VISUALIZER_ENDPOINT=http://127.0.0.1:8788/ingest` | 浏览器 UI | 看实际出站 Claude API request payload |
| UI frame timing | `CLAUDE_CODE_FRAME_TIMING_LOG=<path>` | JSONL | 查 TUI 卡顿、渲染和交互帧 |
| Session event log | `CLAUDE_CODE_SESSION_LOG=<path>` | JSONL | 查 session 级事件流 |
| Diagnostics | `CLAUDE_CODE_DIAGNOSTICS_FILE=<path>` | JSON/JSONL | dump 无 PII 诊断快照 |
| Auto-mode classifier | `CLAUDE_CODE_DUMP_AUTO_MODE=1` | 临时诊断文件 | 查权限 auto-mode 分类器决策 |
| Transcript | `CLAUDE_CODE_JSONL_TRANSCRIPT=1` | JSONL transcript | 离线分析/回放；源码里有内部用户门控，普通 restored 运行不应默认依赖 |

Profile 的慢路径规则来自源码 `src/utils/queryProfiler.ts`：

- 默认阈值 50ms：phase 超过 50ms 才会被标 warning。`git_status*` 走 `git status` label、`tool_schema*` 走 `tool schemas` label、`client_creation*` 走 `client creation` label，这三个是源码里硬编码的专用 label；其余 phase 50ms 之内不会有 warning。
- 100ms 阈值：所有 phase 超过 100ms 会被统一加 `SLOW` 标签。
- 1000ms 阈值：所有 phase 超过 1000ms 会被统一加 `VERY SLOW` 标签。
- 例外：第一个 mark `query_user_input_received` 不会被标慢，因为它是相对进程启动以来的绝对时间，不是真正的处理开销。

Startup profile 只有在 `CLAUDE_CODE_PROFILE_STARTUP=1` 时写完整报告；headless profile 默认采样 5% 走 Statsig（ant 用户 100%），只有 `CLAUDE_CODE_PROFILE_STARTUP=1` 才会全量写入 debug log。注意 startup 和 headless 共用同一 env，但守卫不同（startup 看交互启动路径，headless 看 `getIsNonInteractiveSession()`）。

## Perfetto

`src/utils/telemetry/perfettoTracing.ts` 的当前门控是：

```ts
feature('PERFETTO_TRACING') ||
  process.env.CLAUDE_RESTORED_TELEMETRY === '1' ||
  process.env.CLAUDE_CODE_ENABLE_PERFETTO_TRACING === '1'
```

注意 `feature('PERFETTO_TRACING')` 在 restored source runtime 里**实际是死的**：`perfettoTracing.ts:6-7` 明确写了 "This feature is ant-only and eliminated from external builds"，`bun:bundle` 的 `feature()` 在 production 构建期会 tree-shake 掉这个分支。在 restored source 里跑的时候，门控真正能起作用的就是后面两条 env 路径（`CLAUDE_RESTORED_TELEMETRY=1` 或 `CLAUDE_CODE_ENABLE_PERFETTO_TRACING=1`）。

restored source mode 有两种常规开法：

```bash
CLAUDE_RESTORED_TELEMETRY=1 ./bin/claude
```

或者只开 Perfetto：

```bash
CLAUDE_CODE_ENABLE_PERFETTO_TRACING=1 \
CLAUDE_CODE_PERFETTO_TRACE=1 \
./bin/claude -p "echo PONG"
```

`CLAUDE_CODE_PERFETTO_TRACE=1` 会写到当前 `CLAUDE_CONFIG_DIR` 下的 `traces/trace-<session-id>.json`；如果设置成路径，则写入指定路径。长会话可以加：

```bash
CLAUDE_CODE_PERFETTO_WRITE_INTERVAL_S=5
```

生成的是 Chrome Trace Event JSON。当前仓库提供了一个便捷 wrapper：

```bash
./bin/perfetto          # 打开最新 trace
./bin/perfetto --list   # 列出本地 traces
```

`bin/perfetto` 会使用官方 `open_trace_in_ui` helper，把本地 trace 临时暴露给 Perfetto UI 打开；它不是新的 trace 采集器，也不是自托管 Perfetto 服务。它特别适合回答：

> 这一次运行里，user input 等了多久？API call 花了多久？tool execution 在哪个 API call 之后？blocked-on-user 卡在哪里？agent span 父子关系是什么？

## OpenTelemetry

OpenTelemetry 是长期观测通道，用来把 metrics、logs、traces 发到本地或自托管 OTLP 后端：

```bash
CLAUDE_CODE_ENABLE_TELEMETRY=1 \
OTEL_LOGS_EXPORTER=otlp \
OTEL_METRICS_EXPORTER=otlp \
OTEL_TRACES_EXPORTER=otlp \
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
./bin/claude
```

源码默认不会记录 prompt 原文、tool 参数和 tool 输出；只有显式设置下面三项时才会记录。`deploy/telemetry/claude.telemetry.env.example` 为了本地源码研究，给出的是打开这些内容的示例：

```bash
OTEL_LOG_USER_PROMPTS=1
OTEL_LOG_TOOL_DETAILS=1
OTEL_LOG_TOOL_CONTENT=1
```

如果把这些变量放进自己的本地 runtime env，再通过 `./bin/claude` 启动，OTLP 后端会收到 prompt、tool 参数和 tool 输出。远端部署时要把 OTLP backend 当作敏感数据系统处理。

实现入口是 `src/utils/telemetry/instrumentation.ts`；Docker Compose、Kibana、Elasticsearch、Grafana、Tempo、Loki、Prometheus、GrowthBook 的完整 runbook 见 `deploy/telemetry/README.md`。

## API Request Visualizer

`--debug`、`DEBUG_SDK=1` 和 `ANTHROPIC_LOG=debug` 适合看控制流、request id、SDK 层诊断，但它们不适合在交互式 TUI 里直接刷完整 HTTP payload。为源码研究新增的路径是本地 API request observer：

```bash
cd /Users/durui/Documents/claude-code-explainer/claude-code-sourcemap/lab/http-visualizer
npm start
```

然后在 `restored-src/.claude/telemetry.env` 里打开 sink：

```env
CLAUDE_CODE_HTTP_VISUALIZER_ENDPOINT=http://127.0.0.1:8788/ingest
```

打开 `http://127.0.0.1:8788`，再运行：

```bash
cd /Users/durui/Documents/claude-code-explainer/claude-code-sourcemap/restored-src
./bin/claude
```

这条链路是本地、显式、best-effort 的：`src/services/api/apiRequestObserver.ts` 在 `src/services/api/claude.ts` 发起 Claude API request 前，把完整 request payload POST 到你配置的 endpoint。endpoint 未配置、未启动或超时时，Claude 仍继续运行；事件不会写进交互式 TUI 的 stderr。

不要把这个 endpoint 暴露到公网。payload 可能包含 prompt、上下文、tool schema、tool 参数和项目内容。

## Analytics 与 GrowthBook

内部 analytics 的入口是 `src/services/analytics/index.ts` 的 `logEvent()` / `logEventAsync()`。启动早期如果真正的 analytics 后端还没注册，事件会先暂存在内存队列里；等 `attachAnalyticsSink()` 注册处理器后，再把队列里的事件逐个交给处理器。这个处理器实现在 `src/services/analytics/sink.ts`，负责按采样规则决定是否记录，并把事件分别发送到 Datadog 和 first-party event logging。

这条路径适合研究“产品如何度量自己”，但不适合作为本地自托管观测入口。自托管优先用 OTLP；如果要改本地产品事件发送逻辑，应看 `src/services/analytics/sink.ts`，不要复用 Datadog 或 first-party endpoint。

GrowthBook 负责 feature flag、remote config、实验和采样配置。当前源码支持：

```bash
CLAUDE_CODE_GB_BASE_URL=http://<host>:3100
CLAUDE_CODE_GB_CLIENT_KEY=<growthbook-sdk-client-key>
```

注意 Claude Code 使用 GrowthBook remote evaluation，SDK connection 必须开启 remote evaluation。运行时请求的是 `/api/eval/<client-key>`；只验证 `/api/features/<client-key>` 可用还不够。

## 推荐模板

目录边界：

- Perfetto trace 默认在 `.claude/traces/trace-<session-id>.json`，用 `./bin/perfetto` 打开。
- `.claude/debug/full-trace/` 只是下面模板给 debug log、session log、diagnostics、stream-json 选的本地归档目录；它不承载 Perfetto 默认 trace。

### 单次非交互 query

适合复现一次 query，从 debug log、profile、session log、diagnostics、stream-json 多路落盘：

```bash
cd /Users/durui/Documents/claude-code-explainer/claude-code-sourcemap/restored-src
mkdir -p .claude/debug/full-trace

DEBUG=1 \
DEBUG_SDK=1 \
CLAUDE_CODE_DEBUG_LOG_LEVEL=debug \
CLAUDE_CODE_PROFILE_STARTUP=1 \
CLAUDE_CODE_PROFILE_QUERY=1 \
CLAUDE_CODE_SESSION_LOG=.claude/debug/full-trace/session.jsonl \
CLAUDE_CODE_DIAGNOSTICS_FILE=.claude/debug/full-trace/diagnostics.json \
CLAUDE_CODE_DUMP_AUTO_MODE=1 \
./bin/claude \
  --debug \
  --debug-file .claude/debug/full-trace/debug.log \
  -p "echo PONG" \
  --output-format stream-json \
  --include-hook-events \
  --include-partial-messages \
  > .claude/debug/full-trace/stream.jsonl
```

说明：

- `--debug-file` 会隐式开启 debug；同时放 `DEBUG=1` / `--debug` 是为了覆盖不同入口的判断。
- `--include-hook-events` 和 `--include-partial-messages` 只对 `-p --output-format stream-json` 有意义。
- `CLAUDE_CODE_DUMP_AUTO_MODE` 只有触发 auto-mode/classifier 路径时才会产生有价值的 dump。
- `CLAUDE_CODE_FRAME_TIMING_LOG` 主要对交互 TUI 有价值，非交互 `-p` 通常不需要。

### 单次 query 加 Perfetto

这里的 `.claude/debug/full-trace` 只收 debug log 和 stream-json；Perfetto 仍按源码默认写入 `.claude/traces`。

```bash
mkdir -p .claude/debug/full-trace

CLAUDE_RESTORED_TELEMETRY=1 \
DEBUG=1 \
CLAUDE_CODE_PROFILE_QUERY=1 \
./bin/claude \
  --debug \
  --debug-file .claude/debug/full-trace/debug.log \
  -p "create /tmp/perfetto-demo/hello.txt, then cat it and list the directory" \
  --output-format stream-json \
  --include-hook-events \
  --include-partial-messages \
  > .claude/debug/full-trace/stream.jsonl
```

默认 trace 会写到当前 `CLAUDE_CONFIG_DIR` 下的 `traces/trace-<session-id>.json`。如果需要固定输出文件名，再显式加：

```bash
CLAUDE_CODE_PERFETTO_TRACE=.claude/traces/manual-perfetto.json
```

看最新 trace：

```bash
./bin/perfetto
```

### 交互 UI

如果目标是 TUI 卡顿、输入框、权限弹窗、渲染帧，不要用 `-p`：

```bash
mkdir -p .claude/debug/full-trace

DEBUG=1 \
DEBUG_SDK=1 \
CLAUDE_CODE_DEBUG_LOG_LEVEL=debug \
CLAUDE_CODE_PROFILE_STARTUP=1 \
CLAUDE_CODE_PROFILE_QUERY=1 \
CLAUDE_CODE_SESSION_LOG=.claude/debug/full-trace/session.jsonl \
CLAUDE_CODE_DIAGNOSTICS_FILE=.claude/debug/full-trace/diagnostics.json \
CLAUDE_CODE_FRAME_TIMING_LOG=.claude/debug/full-trace/frame-timing.jsonl \
./bin/claude \
  --debug \
  --debug-file .claude/debug/full-trace/debug.log
```

重点看：

- `.claude/debug/full-trace/debug.log`
- `.claude/debug/full-trace/session.jsonl`
- `.claude/debug/full-trace/frame-timing.jsonl`
- `.claude/startup-perf/`
- query 结束后 debug log 里的 `CLAUDE_CODE_PROFILE_QUERY` report

### 接本地 telemetry stack

部署栈启动后，runtime env 放在你自己的本地 ignored env 文件里，不要提交真实 host、IP、password、SDK key。下面是可以复制改写的示例：

```env
CLAUDE_RESTORED_TELEMETRY=1
OTEL_EXPORTER_OTLP_ENDPOINT=http://<host>:4318
OTEL_LOG_USER_PROMPTS=1
OTEL_LOG_TOOL_DETAILS=1
OTEL_LOG_TOOL_CONTENT=1
CLAUDE_CODE_GB_BASE_URL=http://<host>:3100
CLAUDE_CODE_GB_CLIENT_KEY=<growthbook-sdk-client-key>
CLAUDE_CODE_PERFETTO_TRACE=1
# Optional local API payload viewer. Start lab/http-visualizer first.
# CLAUDE_CODE_HTTP_VISUALIZER_ENDPOINT=http://127.0.0.1:8788/ingest
```

远端部署时补 proxy bypass：

```bash
export NO_PROXY="<host>,localhost,127.0.0.1"
export no_proxy="$NO_PROXY"
```

## Verification Envelope

> 本节定义本文档的"证据失效条件" —— 任何一项被破坏，文档里的具体断言就需要重新审一遍。

**Base of inspection：**

- `restored-src/` 子目录的 commit `cb622b34`（feat: add local API request observability tools），不是仓库根目录的 HEAD
- 仓库根目录 HEAD 与 subdir HEAD 可能不同步；本文档所有源码引用都以 `restored-src/` 为相对路径基准

**Inspection-time working tree 状态：**

- `M deploy/telemetry/README.md` —— OTEL 敏感 payload 段落补了显式注释（本文档 §OpenTelemetry 引用了对应的 env vars）
- `M deploy/telemetry/claude.telemetry.env.example` —— 增加了 `OTEL_LOG_USER_PROMPTS=1` / `OTEL_LOG_TOOL_DETAILS=1` / `OTEL_LOG_TOOL_CONTENT=1` 默认
- `M node_modules/@anthropic-ai/mcpb/dist/index.js` —— 与本文档主题无关，不影响结论
- `?? docs/` —— 包含本文档

**Inspection-time 未深入覆盖、可能影响结论的文件（应在下次审阅时补查）：**

- `src/entrypoints/cli.tsx` —— 入口；影响 "推荐模板" 章节所有命令的可执行性
- `src/main.tsx` —— debug flag、debug file 实际挂载点
- `src/utils/telemetry/sessionTracing.ts` —— Perfetto / OTEL 的 session/API/tool span 实际打点
- `src/services/analytics/growthbook.ts` —— GrowthBook SDK 初始化、remote evaluation 路径
- `src/utils/headlessProfiler.ts` 的所有 call site（仅抽查 `src/query.ts` / `src/QueryEngine.ts`）
- `src/utils/diagLogs.ts` 的所有 `withDiagnosticsTiming` 调用点

**Triggers for mandatory re-review（TODO: 用户填写）：**

> 待补：由你决定哪些变更足以让本文档的具体断言失效。候选已列出，结构可以照搬，但触发条件本身是 policy 判断，不是事实。

候选触发条件（按风险排序，从高到低）：

1. `bin/claude` 改了任何默认值（影响"推荐模板"全部命令的可复现性）
2. `perfettoTracing.ts` 改了门控条件（影响 §Perfetto 一节）
3. `queryProfiler.ts` 改了 50ms / 100ms / 1000ms 阈值或新增专用 warning label（影响 §Profile 慢路径规则）
4. `startupProfiler.ts` 或 `headlessProfiler.ts` 改了输出位置或采样逻辑
5. `deploy/telemetry/README.md` 改了 env example 或 docker compose stack
6. `src/utils/managedEnv.ts` 改了 env allowlist 边界
7. `src/services/api/apiRequestObserver.ts` 改了对 `claude.ts` 的耦合点

## 源码索引

| 问题 | 源码 |
| --- | --- |
| CLI wrapper 与 repo-local config | `bin/claude` |
| Debug flag、debug file、latest symlink | `src/main.tsx`, `src/utils/debug.ts` |
| Startup profile | `src/utils/startupProfiler.ts` |
| Query profile | `src/utils/queryProfiler.ts`, `src/utils/processUserInput/processUserInput.ts` |
| Headless profile（`-p` 模式 per-turn TTFT） | `src/utils/headlessProfiler.ts`, `src/query.ts`, `src/QueryEngine.ts` |
| 三个 profiler 共享 base（perf_hooks、timeline 行格式） | `src/utils/profilerBase.ts` |
| TUI frame timing | `src/interactiveHelpers.tsx`, `src/utils/fpsTracker.ts` |
| Diagnostics file（同步 IO, no-PII） | `src/utils/diagLogs.ts` |
| Diagnostics tracking service（per-event 收集 + MCP 拉取） | `src/services/diagnosticTracking.ts` |
| Perfetto trace 写入 | `src/utils/telemetry/perfettoTracing.ts` |
| Session/API/tool span | `src/utils/telemetry/sessionTracing.ts` |
| API request payload observer | `src/services/api/apiRequestObserver.ts`, `src/services/api/claude.ts` |
| Local request payload UI | `../lab/http-visualizer` |
| OTLP provider/exporter | `src/utils/telemetry/instrumentation.ts` |
| Safe env allowlist / helper 边界 | `src/utils/managedEnv.ts`, `src/utils/managedEnvConstants.ts` |
| Product analytics 暂存队列与事件发送 | `src/services/analytics/index.ts`, `src/services/analytics/sink.ts` |
| First-party event logging | `src/services/analytics/firstPartyEventLogger.ts`, `src/services/analytics/firstPartyEventLoggingExporter.ts` |
| GrowthBook remote config | `src/services/analytics/growthbook.ts`, `src/constants/keys.ts` |
| Perfetto trace opener | `bin/perfetto` |
| Telemetry deployment runbook | `deploy/telemetry/README.md` |
