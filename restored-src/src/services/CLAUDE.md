# Relevant Techniques

## 协议层

- **ETag / If-Match / If-None-Match** — HTTP 缓存协商头，配合 304/412 状态码
- **412 Precondition Failed** — 乐观并发冲突
- **413 Payload Too Large** — 区分 gateway 层 vs app 层
- **OAuth 2.0 + PKCE** — 授权码 + 防截获
- **RFC 6749** — OAuth 2.0 框架
- **RFC 6750** — Bearer Token Usage
- **RFC 7009** — Token Revocation
- **RFC 7523** — JWT Bearer Assertion
- **RFC 8414** — Authorization Server Metadata
- **RFC 8693** — Token Exchange
- **RFC 9728** — Protected Resource Metadata
- **RFC 3986** — URI Generic Syntax
- **MCP (Model Context Protocol)** — Anthropic 的工具连接协议
- **JSON-RPC** — MCP 的底层 RPC 协议
- **SEP-990 / XAA (Cross-App Access)** — MCP 的跨应用访问标准
- **LSP (Language Server Protocol)** — 语言服务协议

## 同步 / 并发算法

- **Optimistic locking** — 假设不冲突、失败再 retry
- **Delta upload** — 只传差异
- **Byte-aware bin-packing** — 按字节贪心装箱
- **Greedy packing** — 贪心切批
- **ETag chain** — 链式校验和
- **Circuit breaker** — 连续失败熔断
- **Recursion guard** — 防止自递归
- **Mutual exclusion (mutex)** — 互斥锁
- **MVCC (Multi-Version Concurrency Control)** — 多版本并发控制
- **COW (Copy-on-Write)** — 写时复制

## LLM 特有概念

- **Prompt cache** — 服务端 KV 缓存（1h TTL）
- **Cache hit rate** — 缓存命中率
- **Cache break** — 缓存失效
- **Cache attribution** — 失效归因（13 维向量）
- **Cache_edits / Cache_reference** — API 原生缓存编辑块
- **Microcompact** — 每 turn 前的轻量压缩
- **Full compact** — 调 LLM 的全量压缩
- **Time-based microcompact** — 60min idle 触发的内容清理
- **Context collapse** — 另一种 context 管理策略
- **Reactive compact** — 响应式压缩
- **Fork-agent (runForkedAgent)** — 共享 cache 的子 agent
- **Sticky-on latch** — session 内一次性翻动 header
- **Speculative execution** — LLM 推测执行
- **Boundary tracking** — 推测执行的边界探测
- **Pipelined suggestion** — 边等用户边预生成
- **Out-of-order execution** — 乱序执行（CPU 概念）
- **Branch prediction** — 分支预测（CPU 概念）
- **Tool use / Tool result pairing** — 工具调用配对
- **Thinking block** — 思考块
- **Query source** — 调用来源标识
- **isUsingOverage** — 超额模式标志

## 文件系统 / OS

- **fs.watch** — Node 目录监听
- **FSEvents** — macOS 文件系统事件
- **kqueue** — BSD 事件通知
- **inotify** — Linux 文件监控
- **fd (file descriptor)** — 文件描述符
- **chokidar** — 跨平台 fs.watch 封装库
- **SIGINT / SIGTERM / SIGKILL** — 进程信号升级链
- **dlopen** — 动态库加载
- **Caffeinate** — macOS 防止休眠命令
- **NAPI Buffer** — Node Native API 缓冲区
- **TOCTOU race** — check-then-use 时序竞争

## 安全 / 认证

- **Mix-up attack** — 授权服务器混淆攻击
- **Step-up authentication** — 高权限 scope 升级
- **WWW-Authenticate: insufficient_scope** — 403 携带的 scope 不足信号
- **CSRF defense (state parameter)** — 跨站请求伪造防护
- **Refresh token rotation** — 刷新令牌轮换
- **MITRE ATT&CK** — 攻击分类框架
- **HIPAA fail-closed / fail-open** — 医疗合规的失败模式
- **DANGEROUS_SHELL_SETTINGS / SAFE_ENV_VARS** — 危险/安全环境变量白黑名单
- **Token redaction** — 日志中脱敏

## HTTP / 客户端

- **Cursor-based pagination** — 游标分页
- **Last-Uuid** — 最后 UUID 乐观并发
- **Multipart upload** — 分块上传
- **UUID boundary** — 分块边界
- **Backpressure** — 流式背压
- **HTTP Agent / WebSocket proxy** — 代理配置
- **TLS reject unauthorized** — TLS 严格校验

## 可观测性 / Telemetry

- **OpenTelemetry (OTel)** — 分布式追踪
- **Datadog** — 监控 SaaS
- **GrowthBook** — Feature flag 服务
- **Statsig** — 另一家 feature flag
- **BigQuery (BQ)** — 数据仓库
- **Feature flag** — 功能开关
- **A/B testing** — 实验分组
- **Sticky bucketing** — 用户黏性分桶
- **1P event logging** — 第一方事件日志
- **OTel BatchLogRecordProcessor** — 批量日志处理器
- **BATCH_UUID** — 批次唯一标识
- **JSONL retry queue** — JSON Lines 重试队列

## 打包 / 构建

- **Bun:bundle** — Bun 的打包器
- **feature('TEAMMEM')** — 编译期 feature flag
- **Tree-shaking** — 死代码消除
- **Bundle exclusion check** — 字符串外泄检查
- **Minification (class name 3-char hash)** — 压缩后类名

## 架构模式

- **SyncState object** — 状态对象做 DI
- **Lazy schema (Zod)** — 延迟加载 schema
- **Lazy module load (require vs import)** — 动态加载
- **Factory function** — 工厂模式
- **WeakRef (parent-child abort)** — 弱引用父子级联
- **Generation counter** — 防止 stale resolve
- **Debounce** — 防抖
- **Suppression** — 抑制重试
- **Atomic write** — 原子写入
- **Read-modify-write serialization** — 串行化读写
- **Graceful shutdown** — 优雅退出
- **Best-effort flush** — 尽力刷盘
- **mtime protection** — 内容相同则不写
- **VCR fixture** — Ruby 风格的请求录播

## 类型系统

- **Zod schema** — TS 运行时类型校验
- **`never` type for exhaustive switch** — 穷举 switch
- **Marker type (AnalyticsMetadata_I_VERIFIED_*)** — 标记强类型
- **Type guard / narrowing** — 类型守卫

## 测试

- **VCR (Video Cassette Recorder)** — 请求/响应录播测试
- **Fixture replay** — 测试夹具回放
- **Bun test** — Bun 的测试运行器
- **Unit test isolation** — 单元测试隔离

## 音频 / 语音

- **STT (Speech-to-Text)** — 语音转文字
- **VAD (Voice Activity Detection)** — 端点检测
- **arecord** — Linux ALSA 录音
- **SoX** — 声音处理工具
- **cpal** — Rust 跨平台音频库
- **Push-to-talk** — 按键说话模式

## 限流 / 配额

- **Unified rate-limit headers** — 统一限流响应头
- **Representative claim** — 最远 reset 时间代表
- **Overage mode** — 超额付费模式
- **Early warning** — 预警阈值

## 设置 / 配置

- **Settings-first** — 声明意图先于物理装载
- **Scope precedence (user/project/local)** — 优先级子语言
- **Cache-first startup** — 启动优先用本地 cache
- **Generation counter (init race)** — 防止 stale init

## 协议工程专有

- **Reconnect state machine** — 重连状态机
- **Session expiration detection** — 会话过期检测
- **Token endpoint discovery** — 端点发现
- **Subject token / Assertion** — 主题令牌 / 断言
- **ID-JAG** — JWT Authorization Grant（XAA 协议核心）
- **Mix-up defense (RFC 8414 §3.3)** — 颁发者混淆防御
- **PRM (Protected Resource Metadata)** — 保护资源元数据
- **AS (Authorization Server)** — 授权服务器
- **RS (Resource Server)** — 资源服务器

## 容错 / 可靠性

- **Retry with backoff** — 退避重试
- **Exponential backoff** — 指数退避
- **Capacity cascade amplification** — 容量级联放大
- **Health check** — 健康检查

## 模型路由

- **First-party vs third-party provider** — 自家 vs 第三方（Bedrock/Vertex）
- **Fast mode** — 快速模式
- **Auto mode** — 自动选择模式
- **Streaming → non-streaming fallback** — 流式降级非流式

## 缓存层

- **Disk cache** — 磁盘缓存
- **Three-tier cache (env / runtime / disk)** — 三层缓存
- **Cache invalidation** — 缓存失效
- **Client replacement guard** — 客户端替换守卫