import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'

/**
 * GrowthBook config for time-based microcompact.
 *
 * Triggers content-clearing microcompact when the gap since the last main-loop
 * assistant message exceeds a threshold — the server-side prompt cache has
 * almost certainly expired, so the full prefix will be rewritten anyway.
 * Clearing old tool results before the request shrinks what gets rewritten.
 *
 * Runs BEFORE the API call (in microcompactMessages, upstream of callModel)
 * so the shrunk prompt is what actually gets sent. Running after the first
 * miss would only help subsequent turns.
 *
 * Main thread only — subagents have short lifetimes where gap-based eviction
 * doesn't apply.
 * 
 * 最常见的场景。用户去开会、吃饭、看文档，回来继续对话，cache 已经过期
 * 
 * 基于时间间隔的微压缩策略：
 * 超过 60 分钟没交互，服务端缓存必然过期，下一轮请求必须完整重写整个 prompt 前缀
 * 既然无论如何要重写，不如保留最近 5 条 compactable 的 tool result，趁机把更旧的 tool result 清掉，缩小需要重写的体积
 * 
 * 
 * Anthropic 的 prompt cache 策略：
 * - 默认 TTL：5 分钟 — 5 分钟内不使用就过期
 * - 可选 1 小时 TTL — 通过 "ttl": "1h" 显式声明，代价是 2 倍 input token 价格
 * - 有"续命"机制：每次 cache hit 时，TTL 自动刷新。所以一个 5 分钟 TTL 的 cache，如果每 4 分钟被用一次，它永远不会过期
 * - 没有 LRU 淘汰 — 纯 TTL 驱动，不存在 DeepSeek 那种"用着就不死"的 LRU 策略
 * 
 * DeepSeek（KV Cache）：
 * - 基于磁盘的前缀缓存，默认开启，不需要用户做任何事
 * - TTL 是动态的："缓存不再使用后会自动被清空，时间一般为几个小时到几天"
 * - 本质是 LRU 淘汰策略 — 你持续使用，它就一直活着；不用了才慢慢清理
 * - 公共前缀会被跨请求复用（多个请求共享 system prompt 前缀）
 * 
 */
export type TimeBasedMCConfig = {
  /** Master switch. When false, time-based microcompact is a no-op. */
  enabled: boolean
  /** Trigger when (now − last assistant timestamp) exceeds this many minutes.
   *  60 is the safe choice: the server's 1h cache TTL is guaranteed expired
   *  for all users, so we never force a miss that wouldn't have happened. */
  gapThresholdMinutes: number
  /** Keep this many most-recent compactable tool results.
   *  When set, takes priority over any default; older results are cleared. */
  keepRecent: number
}

const TIME_BASED_MC_CONFIG_DEFAULTS: TimeBasedMCConfig = {
  enabled: false,
  gapThresholdMinutes: 60,
  keepRecent: 5,
}

export function getTimeBasedMCConfig(): TimeBasedMCConfig {
  // Hoist the GB read so exposure fires on every eval path, not just when
  // the caller's other conditions (querySource, messages.length) pass.
  return getFeatureValue_CACHED_MAY_BE_STALE<TimeBasedMCConfig>(
    'tengu_slate_heron',
    TIME_BASED_MC_CONFIG_DEFAULTS,
  )
}
