import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { Attributes, Meter, MetricOptions } from '@opentelemetry/api'
import type { logs } from '@opentelemetry/api-logs'
import type { LoggerProvider } from '@opentelemetry/sdk-logs'
import type { MeterProvider } from '@opentelemetry/sdk-metrics'
import type { BasicTracerProvider } from '@opentelemetry/sdk-trace-base'
import { realpathSync } from 'fs' // 文件系统
import sumBy from 'lodash-es/sumBy.js'
import { cwd } from 'process'
import type { HookEvent, ModelUsage } from 'src/entrypoints/agentSdkTypes.js'
import type { AgentColorName } from 'src/tools/AgentTool/agentColorManager.js'
import type { HookCallbackMatcher } from 'src/types/hooks.js'
// Indirection for browser-sdk build (package.json "browser" field swaps
// crypto.ts for crypto.browser.ts). Pure leaf re-export of node:crypto —
// zero circular-dep risk. Path-alias import bypasses bootstrap-isolation
// (rule only checks ./ and / prefixes); explicit disable documents intent.
// eslint-disable-next-line custom-rules/bootstrap-isolation
import { randomUUID } from 'src/utils/crypto.js'
import type { ModelSetting } from 'src/utils/model/model.js'
import type { ModelStrings } from 'src/utils/model/modelStrings.js'
import type { SettingSource } from 'src/utils/settings/constants.js'
import { resetSettingsCache } from 'src/utils/settings/settingsCache.js'
import type { PluginHookMatcher } from 'src/utils/settings/types.js'
import { createSignal } from 'src/utils/signal.js' // 信号量，信号对象独立存在，通知订阅者读最新值；Observer 是，Subject 知道 Observer 接口，典型用于 MVVM；MG 是持久化的跨进程管道，消费前一直存着

// Union type for registered hooks - can be SDK callbacks or native plugin hooks
type RegisteredHookMatcher = HookCallbackMatcher | PluginHookMatcher

import type { SessionId } from 'src/types/ids.js'

// DO NOT ADD MORE STATE HERE - BE JUDICIOUS WITH GLOBAL STATE

// dev: true on entries that came via --dangerously-load-development-channels.
// The allowlist gate checks this per-entry (not the session-wide
// hasDevChannels bit) so passing both flags doesn't let the dev dialog's
// acceptance leak allowlist-bypass to the --channels entries.
export type ChannelEntry =
  | { kind: 'plugin'; name: string; marketplace: string; dev?: boolean }
  | { kind: 'server'; name: string; dev?: boolean }

export type AttributedCounter = {
  add(value: number, additionalAttributes?: Attributes): void
}

// 模型配置、交互模式、会话标识、工作目录、遥测
type State = {
  originalCwd: string 
  // Stable project root - set once at startup (including by --worktree flag),
  // never updated by mid-session EnterWorktreeTool.
  // Use for project identity (history, skills, sessions) not file operations.
  projectRoot: string
  totalCostUSD: number
  totalAPIDuration: number
  totalAPIDurationWithoutRetries: number
  totalToolDuration: number
  turnHookDurationMs: number
  turnToolDurationMs: number
  turnClassifierDurationMs: number
  turnToolCount: number
  turnHookCount: number
  turnClassifierCount: number
  startTime: number
  lastInteractionTime: number
  totalLinesAdded: number
  totalLinesRemoved: number
  hasUnknownModelCost: boolean
  cwd: string
  modelUsage: { [modelName: string]: ModelUsage }
  mainLoopModelOverride: ModelSetting | undefined
  initialMainLoopModel: ModelSetting
  modelStrings: ModelStrings | null
  isInteractive: boolean
  kairosActive: boolean
  // When true, ensureToolResultPairing throws on mismatch instead of
  // repairing with synthetic placeholders. HFI opts in at startup so
  // trajectories fail fast rather than conditioning the model on fake
  // tool_results.
  strictToolResultPairing: boolean
  sdkAgentProgressSummariesEnabled: boolean
  userMsgOptIn: boolean
  clientType: string
  sessionSource: string | undefined
  questionPreviewFormat: 'markdown' | 'html' | undefined
  flagSettingsPath: string | undefined
  flagSettingsInline: Record<string, unknown> | null
  allowedSettingSources: SettingSource[]
  sessionIngressToken: string | null | undefined
  oauthTokenFromFd: string | null | undefined
  apiKeyFromFd: string | null | undefined
  // Telemetry state
  meter: Meter | null
  sessionCounter: AttributedCounter | null
  locCounter: AttributedCounter | null
  prCounter: AttributedCounter | null
  commitCounter: AttributedCounter | null
  costCounter: AttributedCounter | null
  tokenCounter: AttributedCounter | null
  codeEditToolDecisionCounter: AttributedCounter | null
  activeTimeCounter: AttributedCounter | null
  statsStore: { observe(name: string, value: number): void } | null
  sessionId: SessionId
  // Parent session ID for tracking session lineage (e.g., plan mode -> implementation)
  parentSessionId: SessionId | undefined
  // Logger state
  loggerProvider: LoggerProvider | null
  eventLogger: ReturnType<typeof logs.getLogger> | null
  // Meter provider state
  meterProvider: MeterProvider | null
  // Tracer provider state
  tracerProvider: BasicTracerProvider | null
  // Agent color state
  agentColorMap: Map<string, AgentColorName>
  agentColorIndex: number
  // Last API request for bug reports
  lastAPIRequest: Omit<BetaMessageStreamParams, 'messages'> | null
  // Messages from the last API request (ant-only; reference, not clone).
  // Captures the exact post-compaction, CLAUDE.md-injected message set sent
  // to the API so /share's serialized_conversation.json reflects reality.
  lastAPIRequestMessages: BetaMessageStreamParams['messages'] | null
  // Last auto-mode classifier request(s) for /share transcript
  lastClassifierRequests: unknown[] | null
  // CLAUDE.md content cached by context.ts for the auto-mode classifier.
  // Breaks the yoloClassifier → claudemd → filesystem → permissions cycle.
  cachedClaudeMdContent: string | null
  // In-memory error log for recent errors
  inMemoryErrorLog: Array<{ error: string; timestamp: string }>
  // Session-only plugins from --plugin-dir flag
  inlinePlugins: Array<string>
  // Explicit --chrome / --no-chrome flag value (undefined = not set on CLI)
  chromeFlagOverride: boolean | undefined
  // Use cowork_plugins directory instead of plugins (--cowork flag or env var)
  useCoworkPlugins: boolean
  // Session-only bypass permissions mode flag (not persisted)
  sessionBypassPermissionsMode: boolean
  // Session-only flag gating the .claude/scheduled_tasks.json watcher
  // (useScheduledTasks). Set by cronScheduler.start() when the JSON has
  // entries, or by CronCreateTool. Not persisted.
  scheduledTasksEnabled: boolean
  // Session-only cron tasks created via CronCreate with durable: false.
  // Fire on schedule like file-backed tasks but are never written to
  // .claude/scheduled_tasks.json — they die with the process. Typed via
  // SessionCronTask below (not importing from cronTasks.ts keeps
  // bootstrap a leaf of the import DAG).
  sessionCronTasks: SessionCronTask[]
  // Teams created this session via TeamCreate. cleanupSessionTeams()
  // removes these on gracefulShutdown so subagent-created teams don't
  // persist on disk forever (gh-32730). TeamDelete removes entries to
  // avoid double-cleanup. Lives here (not teamHelpers.ts) so
  // resetStateForTests() clears it between tests.
  sessionCreatedTeams: Set<string>
  // Session-only trust flag for home directory (not persisted to disk)
  // When running from home dir, trust dialog is shown but not saved to disk.
  // This flag allows features requiring trust to work during the session.
  sessionTrustAccepted: boolean
  // Session-only flag to disable session persistence to disk
  sessionPersistenceDisabled: boolean
  // Track if user has exited plan mode in this session (for re-entry guidance)
  hasExitedPlanMode: boolean
  // Track if we need to show the plan mode exit attachment (one-time notification)
  needsPlanModeExitAttachment: boolean
  // Track if we need to show the auto mode exit attachment (one-time notification)
  needsAutoModeExitAttachment: boolean
  // Track if LSP plugin recommendation has been shown this session (only show once)
  lspRecommendationShownThisSession: boolean
  // SDK init event state - jsonSchema for structured output
  initJsonSchema: Record<string, unknown> | null
  // Registered hooks - SDK callbacks and plugin native hooks
  registeredHooks: Partial<Record<HookEvent, RegisteredHookMatcher[]>> | null
  // Cache for plan slugs: sessionId -> wordSlug
  planSlugCache: Map<string, string>
  // Track teleported session for reliability logging
  teleportedSessionInfo: {
    isTeleported: boolean
    hasLoggedFirstMessage: boolean
    sessionId: string | null
  } | null
  // Track invoked skills for preservation across compaction
  // Keys are composite: `${agentId ?? ''}:${skillName}` to prevent cross-agent overwrites
  invokedSkills: Map<
    string,
    {
      skillName: string
      skillPath: string
      content: string
      invokedAt: number
      agentId: string | null
    }
  >
  // Track slow operations for dev bar display (ant-only)
  slowOperations: Array<{
    operation: string
    durationMs: number
    timestamp: number
  }>
  // SDK-provided betas (e.g., context-1m-2025-08-07)
  sdkBetas: string[] | undefined
  // Main thread agent type (from --agent flag or settings)
  mainThreadAgentType: string | undefined
  // Remote mode (--remote flag)
  isRemoteMode: boolean
  // Direct connect server URL (for display in header)
  directConnectServerUrl: string | undefined
  // System prompt section cache state
  systemPromptSectionCache: Map<string, string | null>
  // Last date emitted to the model (for detecting midnight date changes)
  lastEmittedDate: string | null
  // Additional directories from --add-dir flag (for CLAUDE.md loading)
  additionalDirectoriesForClaudeMd: string[]
  // Channel server allowlist from --channels flag (servers whose channel
  // notifications should register this session). Parsed once in main.tsx —
  // the tag decides trust model: 'plugin' → marketplace verification +
  // allowlist, 'server' → allowlist always fails (schema is plugin-only).
  // Either kind needs entry.dev to bypass allowlist.
  allowedChannels: ChannelEntry[]
  // True if any entry in allowedChannels came from
  // --dangerously-load-development-channels (so ChannelsNotice can name the
  // right flag in policy-blocked messages)
  hasDevChannels: boolean
  // Dir containing the session's `.jsonl`; null = derive from originalCwd.
  sessionProjectDir: string | null
  // Cached prompt cache 1h TTL allowlist from GrowthBook (session-stable)
  promptCache1hAllowlist: string[] | null
  // Cached 1h TTL user eligibility (session-stable). Latched on first
  // evaluation so mid-session overage flips don't change the cache_control
  // TTL, which would bust the server-side prompt cache.
  promptCache1hEligible: boolean | null
  // Sticky-on latch for AFK_MODE_BETA_HEADER. Once auto mode is first
  // activated, keep sending the header for the rest of the session so
  // Shift+Tab toggles don't bust the ~50-70K token prompt cache.
  afkModeHeaderLatched: boolean | null
  // Sticky-on latch for FAST_MODE_BETA_HEADER. Once fast mode is first
  // enabled, keep sending the header so cooldown enter/exit doesn't
  // double-bust the prompt cache. The `speed` body param stays dynamic.
  fastModeHeaderLatched: boolean | null
  // Sticky-on latch for the cache-editing beta header. Once cached
  // microcompact is first enabled, keep sending the header so mid-session
  // GrowthBook/settings toggles don't bust the prompt cache.
  cacheEditingHeaderLatched: boolean | null
  // Sticky-on latch for clearing thinking from prior tool loops. Triggered
  // when >1h since last API call (confirmed cache miss — no cache-hit
  // benefit to keeping thinking). Once latched, stays on so the newly-warmed
  // thinking-cleared cache isn't busted by flipping back to keep:'all'.
  thinkingClearLatched: boolean | null
  // Current prompt ID (UUID) correlating a user prompt with subsequent OTel events
  promptId: string | null
  // Last API requestId for the main conversation chain (not subagents).
  // Updated after each successful API response for main-session queries.
  // Read at shutdown to send cache eviction hints to inference.
  lastMainRequestId: string | undefined
  // Timestamp (Date.now()) of the last successful API call completion.
  // Used to compute timeSinceLastApiCallMs in tengu_api_success for
  // correlating cache misses with idle time (cache TTL is ~5min).
  lastApiCompletionTimestamp: number | null
  // Set to true after compaction (auto or manual /compact). Consumed by
  // logAPISuccess to tag the first post-compaction API call so we can
  // distinguish compaction-induced cache misses from TTL expiry.
  pendingPostCompaction: boolean
}

// ALSO HERE - THINK THRICE BEFORE MODIFYING
function getInitialState(): State {
  // Resolve symlinks in cwd to match behavior of shell.ts setCwd
  // This ensures consistency with how paths are sanitized for session storage
  let resolvedCwd = ''
  if (
    typeof process !== 'undefined' &&
    typeof process.cwd === 'function' &&
    typeof realpathSync === 'function'
  ) {
    const rawCwd = cwd()
    try {
      resolvedCwd = realpathSync(rawCwd).normalize('NFC')
    } catch {
      // File Provider EPERM on CloudStorage mounts (lstat per path component).
      resolvedCwd = rawCwd.normalize('NFC')
    }
  }
  const state: State = {
    originalCwd: resolvedCwd,
    projectRoot: resolvedCwd,
    totalCostUSD: 0,
    totalAPIDuration: 0,
    totalAPIDurationWithoutRetries: 0,
    totalToolDuration: 0,
    turnHookDurationMs: 0,
    turnToolDurationMs: 0,
    turnClassifierDurationMs: 0,
    turnToolCount: 0,
    turnHookCount: 0,
    turnClassifierCount: 0,
    startTime: Date.now(),
    lastInteractionTime: Date.now(),
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    hasUnknownModelCost: false,
    cwd: resolvedCwd,
    modelUsage: {},
    mainLoopModelOverride: undefined,
    initialMainLoopModel: null,
    modelStrings: null,
    isInteractive: false,
    kairosActive: false,
    strictToolResultPairing: false,
    sdkAgentProgressSummariesEnabled: false,
    userMsgOptIn: false,
    clientType: 'cli',
    sessionSource: undefined,
    questionPreviewFormat: undefined,
    sessionIngressToken: undefined,
    oauthTokenFromFd: undefined,
    apiKeyFromFd: undefined,
    flagSettingsPath: undefined,
    flagSettingsInline: null,
    allowedSettingSources: [
      'userSettings',
      'projectSettings',
      'localSettings',
      'flagSettings',
      'policySettings',
    ],
    // Telemetry state
    meter: null,
    sessionCounter: null,
    locCounter: null,
    prCounter: null,
    commitCounter: null,
    costCounter: null,
    tokenCounter: null,
    codeEditToolDecisionCounter: null,
    activeTimeCounter: null,
    statsStore: null,
    sessionId: randomUUID() as SessionId,
    parentSessionId: undefined,
    // Logger state
    loggerProvider: null,
    eventLogger: null,
    // Meter provider state
    meterProvider: null,
    tracerProvider: null,
    // Agent color state
    agentColorMap: new Map(),
    agentColorIndex: 0,
    // Last API request for bug reports
    lastAPIRequest: null,
    lastAPIRequestMessages: null,
    // Last auto-mode classifier request(s) for /share transcript
    lastClassifierRequests: null,
    cachedClaudeMdContent: null,
    // In-memory error log for recent errors
    inMemoryErrorLog: [],
    // Session-only plugins from --plugin-dir flag
    inlinePlugins: [],
    // Explicit --chrome / --no-chrome flag value (undefined = not set on CLI)
    chromeFlagOverride: undefined,
    // Use cowork_plugins directory instead of plugins
    useCoworkPlugins: false,
    // Session-only bypass permissions mode flag (not persisted)
    sessionBypassPermissionsMode: false,
    // Scheduled tasks disabled until flag or dialog enables them
    scheduledTasksEnabled: false,
    sessionCronTasks: [],
    sessionCreatedTeams: new Set(),
    // Session-only trust flag (not persisted to disk)
    sessionTrustAccepted: false,
    // Session-only flag to disable session persistence to disk
    sessionPersistenceDisabled: false,
    // Track if user has exited plan mode in this session
    hasExitedPlanMode: false,
    // Track if we need to show the plan mode exit attachment
    needsPlanModeExitAttachment: false,
    // Track if we need to show the auto mode exit attachment
    needsAutoModeExitAttachment: false,
    // Track if LSP plugin recommendation has been shown this session
    lspRecommendationShownThisSession: false,
    // SDK init event state
    initJsonSchema: null,
    registeredHooks: null,
    // Cache for plan slugs
    planSlugCache: new Map(),
    // Track teleported session for reliability logging
    teleportedSessionInfo: null,
    // Track invoked skills for preservation across compaction
    invokedSkills: new Map(),
    // Track slow operations for dev bar display
    slowOperations: [],
    // SDK-provided betas
    sdkBetas: undefined,
    // Main thread agent type
    mainThreadAgentType: undefined,
    // Remote mode
    isRemoteMode: false,
    ...(process.env.USER_TYPE === 'ant'
      ? {
          replBridgeActive: false,
        }
      : {}),
    // Direct connect server URL
    directConnectServerUrl: undefined,
    // System prompt section cache state
    systemPromptSectionCache: new Map(),
    // Last date emitted to the model
    lastEmittedDate: null,
    // Additional directories from --add-dir flag (for CLAUDE.md loading)
    additionalDirectoriesForClaudeMd: [],
    // Channel server allowlist from --channels flag
    allowedChannels: [],
    hasDevChannels: false,
    // Session project dir (null = derive from originalCwd)
    sessionProjectDir: null,
    // Prompt cache 1h allowlist (null = not yet fetched from GrowthBook)
    promptCache1hAllowlist: null,
    // Prompt cache 1h eligibility (null = not yet evaluated)
    promptCache1hEligible: null,
    // Beta header latches (null = not yet triggered)
    afkModeHeaderLatched: null,
    fastModeHeaderLatched: null,
    cacheEditingHeaderLatched: null,
    thinkingClearLatched: null,
    // Current prompt ID
    promptId: null,
    lastMainRequestId: undefined,
    lastApiCompletionTimestamp: null,
    pendingPostCompaction: false,
  }

  return state
}

// AND ESPECIALLY HERE
const STATE: State = getInitialState()

// Usage: 282 calls
export function getSessionId(): SessionId {
  return STATE.sessionId
}

// Usage: 147 calls
export function getOriginalCwd(): string {
  return STATE.originalCwd
}

/**
 * Get the stable project root directory.
 * Unlike getOriginalCwd(), this is never updated by mid-session EnterWorktreeTool
 * (so skills/history stay stable when entering a throwaway worktree).
 * It IS set at startup by --worktree, since that worktree is the session's project.
 * Use for project identity (history, skills, sessions) not file operations.
 */
// Usage: 104 calls
export function getIsNonInteractiveSession(): boolean {
  return !STATE.isInteractive
}

// Usage: 61 calls
export function getIsRemoteMode(): boolean {
  return STATE.isRemoteMode
}

// Usage: 47 calls
export function getModelStrings(): ModelStrings | null {
  return STATE.modelStrings
}

// You shouldn't use this directly. See src/utils/model/modelStrings.ts
// Usage: 41 calls
export function getProjectRoot(): string {
  return STATE.projectRoot
}

// Usage: 29 calls
export function getKairosActive(): boolean {
  return STATE.kairosActive
}

// Usage: 24 calls
export function switchSession(
  sessionId: SessionId,
  projectDir: string | null = null,
): void {
  // Drop the outgoing session's plan-slug entry so the Map stays bounded
  // across repeated /resume. Only the current session's slug is ever read
  // (plans.ts getPlanSlug defaults to getSessionId()).
  STATE.planSlugCache.delete(STATE.sessionId)
  STATE.sessionId = sessionId
  STATE.sessionProjectDir = projectDir
  sessionSwitched.emit(sessionId)
}

const sessionSwitched = createSignal<[id: SessionId]>()

/**
 * Register a callback that fires when switchSession changes the active
 * sessionId. bootstrap can't import listeners directly (DAG leaf), so
 * callers register themselves. concurrentSessions.ts uses this to keep the
 * PID file's sessionId in sync with --resume.
 */
// Usage: 23 calls
export function getAllowedChannels(): ChannelEntry[] {
  return STATE.allowedChannels
}

// Usage: 21 calls
export function getSdkBetas(): string[] | undefined {
  return STATE.sdkBetas
}

// Usage: 20 calls
export function setOriginalCwd(cwd: string): void {
  STATE.originalCwd = cwd.normalize('NFC')
}

/**
 * Only for --worktree startup flag. Mid-session EnterWorktreeTool must NOT
 * call this — skills/history should stay anchored to where the session started.
 */
// Usage: 20 calls
export function setMainLoopModelOverride(
  model: ModelSetting | undefined,
): void {
  STATE.mainLoopModelOverride = model
}

// Usage: 18 calls
export function getIsInteractive(): boolean {
  return STATE.isInteractive
}

// Usage: 17 calls
export function setNeedsAutoModeExitAttachment(value: boolean): void {
  STATE.needsAutoModeExitAttachment = value
}

// Usage: 16 calls
export function getUserMsgOptIn(): boolean {
  return STATE.userMsgOptIn
}

// Usage: 16 calls
export function getAdditionalDirectoriesForClaudeMd(): string[] {
  return STATE.additionalDirectoriesForClaudeMd
}

// Usage: 15 calls
export function getTotalInputTokens(): number {
  return sumBy(Object.values(STATE.modelUsage), 'inputTokens')
}

// Usage: 14 calls
export function getTotalAPIDuration(): number {
  return STATE.totalAPIDuration
}

// Usage: 13 calls
export function setCwdState(cwd: string): void {
  STATE.cwd = cwd.normalize('NFC')
}

// Usage: 13 calls
export function getInlinePlugins(): Array<string> {
  return STATE.inlinePlugins
}

// Usage: 13 calls
export function setUseCoworkPlugins(value: boolean): void {
  STATE.useCoworkPlugins = value
  resetSettingsCache()
}

// Usage: 13 calls
export function isSessionPersistenceDisabled(): boolean {
  return STATE.sessionPersistenceDisabled
}

// Usage: 13 calls
export function setHasExitedPlanMode(value: boolean): void {
  STATE.hasExitedPlanMode = value
}

// Usage: 12 calls
export function getTotalOutputTokens(): number {
  return sumBy(Object.values(STATE.modelUsage), 'outputTokens')
}

// Usage: 12 calls
export function getCurrentTurnTokenBudget(): number | null {
  return currentTurnTokenBudget
}
let budgetContinuationCount = 0
// Usage: 12 calls
export function getModelUsage(): { [modelName: string]: ModelUsage } {
  return STATE.modelUsage
}

// Usage: 12 calls
export function registerHookCallbacks(
  hooks: Partial<Record<HookEvent, RegisteredHookMatcher[]>>,
): void {
  if (!STATE.registeredHooks) {
    STATE.registeredHooks = {}
  }

  // `registerHookCallbacks` may be called multiple times, so we need to merge (not overwrite)
  for (const [event, matchers] of Object.entries(hooks)) {
    const eventKey = event as HookEvent
    if (!STATE.registeredHooks[eventKey]) {
      STATE.registeredHooks[eventKey] = []
    }
    STATE.registeredHooks[eventKey]!.push(...matchers)
  }
}

// Usage: 12 calls
export function getRegisteredHooks(): Partial<
  Record<HookEvent, RegisteredHookMatcher[]>
> | null {
  return STATE.registeredHooks
}

// Usage: 11 calls
export function getParentSessionId(): SessionId | undefined {
  return STATE.parentSessionId
}

/**
 * Atomically switch the active session. `sessionId` and `sessionProjectDir`
 * always change together — there is no separate setter for either, so they
 * cannot drift out of sync (CC-34).
 *
 * @param projectDir — directory containing `<sessionId>.jsonl`. Omit (or
 *   pass `null`) for sessions in the current project — the path will derive
 *   from originalCwd at read time. Pass `dirname(transcriptPath)` when the
 *   session lives in a different project directory (git worktrees,
 *   cross-project resume). Every call resets the project dir; it never
 *   carries over from the previous session.
 */
// Usage: 11 calls
export function getCwdState(): string {
  return STATE.cwd
}

// Usage: 11 calls
export function getMainLoopModelOverride(): ModelSetting | undefined {
  return STATE.mainLoopModelOverride
}

// Usage: 11 calls
export function setUserMsgOptIn(value: boolean): void {
  STATE.userMsgOptIn = value
}

// Usage: 11 calls
export function setNeedsPlanModeExitAttachment(value: boolean): void {
  STATE.needsPlanModeExitAttachment = value
}

// Usage: 11 calls
export function getMainThreadAgentType(): string | undefined {
  return STATE.mainThreadAgentType
}

// Usage: 10 calls
export function getLastInteractionTime(): number {
  return STATE.lastInteractionTime
}

// Scroll drain suspension — background intervals check this before doing work
// so they don't compete with scroll frames for the event loop. Set by
// ScrollBox scrollBy/scrollTo, cleared SCROLL_DRAIN_IDLE_MS after the last
// scroll event. Module-scope (not in STATE) — ephemeral hot-path flag, no
// test-reset needed since the debounce timer self-clears.
let scrollDraining = false
let scrollDrainTimer: ReturnType<typeof setTimeout> | undefined
const SCROLL_DRAIN_IDLE_MS = 150

/** Mark that a scroll event just happened. Background intervals gate on
 *  getIsScrollDraining() and skip their work until the debounce clears. */
// Usage: 10 calls
export function getSdkAgentProgressSummariesEnabled(): boolean {
  return STATE.sdkAgentProgressSummariesEnabled
}

// Usage: 10 calls
export function handlePlanModeTransition(
  fromMode: string,
  toMode: string,
): void {
  // If switching TO plan mode, clear any pending exit attachment
  // This prevents sending both plan_mode and plan_mode_exit when user toggles quickly
  if (toMode === 'plan' && fromMode !== 'plan') {
    STATE.needsPlanModeExitAttachment = false
  }

  // If switching out of plan mode, trigger the plan_mode_exit attachment
  if (fromMode === 'plan' && toMode !== 'plan') {
    STATE.needsPlanModeExitAttachment = true
  }
}

// Usage: 10 calls
export function addInvokedSkill(
  skillName: string,
  skillPath: string,
  content: string,
  agentId: string | null = null,
): void {
  const key = `${agentId ?? ''}:${skillName}`
  STATE.invokedSkills.set(key, {
    skillName,
    skillPath,
    content,
    invokedAt: Date.now(),
    agentId,
  })
}

// Usage: 10 calls
export function setMainThreadAgentType(agentType: string | undefined): void {
  STATE.mainThreadAgentType = agentType
}

// Usage: 9 calls
export function getTurnOutputTokens(): number {
  return getTotalOutputTokens() - outputTokensAtTurnStart
}
// Usage: 9 calls
export function hasUnknownModelCost(): boolean {
  return STATE.hasUnknownModelCost
}

// Usage: 9 calls
export function getScheduledTasksEnabled(): boolean {
  return STATE.scheduledTasksEnabled
}

export type SessionCronTask = {
  id: string
  cron: string
  prompt: string
  createdAt: number
  recurring?: boolean
  /**
   * When set, the task was created by an in-process teammate (not the team lead).
   * The scheduler routes fires to that teammate's pendingUserMessages queue
   * instead of the main REPL command queue. Session-only — never written to disk.
   */
  agentId?: string
}

// Usage: 9 calls
export function needsPlanModeExitAttachment(): boolean {
  return STATE.needsPlanModeExitAttachment
}

// Usage: 9 calls
export function needsAutoModeExitAttachment(): boolean {
  return STATE.needsAutoModeExitAttachment
}

// Usage: 9 calls
export function setAllowedChannels(entries: ChannelEntry[]): void {
  STATE.allowedChannels = entries
}

// Usage: 8 calls
export function updateLastInteractionTime(immediate?: boolean): void {
  if (immediate) {
    flushInteractionTime_inner()
  } else {
    interactionTimeDirty = true
  }
}

/**
 * If an interaction was recorded since the last flush, update the timestamp
 * now. Called by Ink before each render cycle so we batch many keypresses into
 * a single Date.now() call.
 */
// Usage: 8 calls
export function markPostCompaction(): void {
  STATE.pendingPostCompaction = true
}

/** Consume the post-compaction flag. Returns true once after compaction,
 *  then returns false until the next compaction. */
// Usage: 8 calls
export function getIsScrollDraining(): boolean {
  return scrollDraining
}

/** Await this before expensive one-shot work (network, subprocess) that could
 *  coincide with scroll. Resolves immediately if not scrolling; otherwise
 *  polls at the idle interval until the flag clears. */
export async function waitForScrollIdle(): Promise<void> {
  while (scrollDraining) {
    // bootstrap-isolation forbids importing sleep() from src/utils/
    // eslint-disable-next-line no-restricted-syntax
    await new Promise(r => setTimeout(r, SCROLL_DRAIN_IDLE_MS).unref?.())
  }
}

// Usage: 8 calls
export function getActiveTimeCounter(): AttributedCounter | null {
  return STATE.activeTimeCounter
}

// Usage: 8 calls
export function getFlagSettingsPath(): string | undefined {
  return STATE.flagSettingsPath
}

// Usage: 8 calls
export function getSessionBypassPermissionsMode(): boolean {
  return STATE.sessionBypassPermissionsMode
}

// Usage: 8 calls
export function getPlanSlugCache(): Map<string, string> {
  return STATE.planSlugCache
}

// Usage: 8 calls
export function clearInvokedSkillsForAgent(agentId: string): void {
  for (const [key, skill] of STATE.invokedSkills) {
    if (skill.agentId === agentId) {
      STATE.invokedSkills.delete(key)
    }
  }
}

// Slow operations tracking for dev bar
const MAX_SLOW_OPERATIONS = 10
const SLOW_OPERATION_TTL_MS = 10000

// Usage: 7 calls
export function regenerateSessionId(
  options: { setCurrentAsParent?: boolean } = {},
): SessionId {
  if (options.setCurrentAsParent) {
    STATE.parentSessionId = STATE.sessionId
  }
  // Drop the outgoing session's plan-slug entry so the Map doesn't
  // accumulate stale keys. Callers that need to carry the slug across
  // (REPL.tsx clearContext) read it before calling clearConversation.
  STATE.planSlugCache.delete(STATE.sessionId)
  // Regenerated sessions live in the current project: reset projectDir to
  // null so getTranscriptPath() derives from originalCwd.
  STATE.sessionId = randomUUID() as SessionId
  STATE.sessionProjectDir = null
  return STATE.sessionId
}

// Usage: 7 calls
export function getSessionProjectDir(): string | null {
  return STATE.sessionProjectDir
}

// Usage: 7 calls
export function getTotalCostUSD(): number {
  return STATE.totalCostUSD
}

// Usage: 7 calls
export function getTotalDuration(): number {
  return Date.now() - STATE.startTime
}

// Usage: 7 calls
export function getStatsStore(): {
  observe(name: string, value: number): void
} | null {
  return STATE.statsStore
}

// Usage: 7 calls
export function getTotalLinesAdded(): number {
  return STATE.totalLinesAdded
}

// Usage: 7 calls
export function getTotalLinesRemoved(): number {
  return STATE.totalLinesRemoved
}

// Usage: 7 calls
export function getLastApiCompletionTimestamp(): number | null {
  return STATE.lastApiCompletionTimestamp
}

// Usage: 7 calls
export function resetCostState(): void {
  STATE.totalCostUSD = 0
  STATE.totalAPIDuration = 0
  STATE.totalAPIDurationWithoutRetries = 0
  STATE.totalToolDuration = 0
  STATE.startTime = Date.now()
  STATE.totalLinesAdded = 0
  STATE.totalLinesRemoved = 0
  STATE.hasUnknownModelCost = false
  STATE.modelUsage = {}
  STATE.promptId = null
}

/**
 * Sets cost state values for session restore.
 * Called by restoreCostStateForSession in cost-tracker.ts.
 */
// Usage: 7 calls
export function resetStateForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetStateForTests can only be called in tests')
  }
  Object.entries(getInitialState()).forEach(([key, value]) => {
    STATE[key as keyof State] = value as never
  })
  outputTokensAtTurnStart = 0
  currentTurnTokenBudget = null
  budgetContinuationCount = 0
  sessionSwitched.clear()
}

// You shouldn't use this directly. See src/utils/model/modelStrings.ts::getModelStrings()
// Usage: 7 calls
export function getTracerProvider(): BasicTracerProvider | null {
  return STATE.tracerProvider
}
// Usage: 7 calls
export function setSessionIngressToken(token: string | null): void {
  STATE.sessionIngressToken = token
}

// Usage: 7 calls
export function getSessionTrustAccepted(): boolean {
  return STATE.sessionTrustAccepted
}

// Usage: 6 calls
export function setProjectRoot(cwd: string): void {
  STATE.projectRoot = cwd.normalize('NFC')
}

// Usage: 6 calls
export function getTotalCacheReadInputTokens(): number {
  return sumBy(Object.values(STATE.modelUsage), 'cacheReadInputTokens')
}

// Usage: 6 calls
export function getTotalCacheCreationInputTokens(): number {
  return sumBy(Object.values(STATE.modelUsage), 'cacheCreationInputTokens')
}

// Usage: 6 calls
export function getInitialMainLoopModel(): ModelSetting {
  return STATE.initialMainLoopModel
}

// Usage: 6 calls
export function getTokenCounter(): AttributedCounter | null {
  return STATE.tokenCounter
}

// Usage: 6 calls
export function getClientType(): string {
  return STATE.clientType
}

// Usage: 6 calls
export function setKairosActive(value: boolean): void {
  STATE.kairosActive = value
}

// Usage: 6 calls
export function getFlagSettingsInline(): Record<string, unknown> | null {
  return STATE.flagSettingsInline
}

// Usage: 6 calls
export function preferThirdPartyAuthentication(): boolean {
  // IDE extension should behave as 1P for authentication reasons.
  return getIsNonInteractiveSession() && STATE.clientType !== 'claude-vscode'
}

// Usage: 6 calls
export function setScheduledTasksEnabled(enabled: boolean): void {
  STATE.scheduledTasksEnabled = enabled
}

// Usage: 6 calls
export function removeSessionCronTasks(ids: readonly string[]): number {
  if (ids.length === 0) return 0
  const idSet = new Set(ids)
  const remaining = STATE.sessionCronTasks.filter(t => !idSet.has(t.id))
  const removed = STATE.sessionCronTasks.length - remaining.length
  if (removed === 0) return 0
  STATE.sessionCronTasks = remaining
  return removed
}

// Usage: 6 calls
export function setLastEmittedDate(date: string | null): void {
  STATE.lastEmittedDate = date
}

// Usage: 5 calls
export function setDirectConnectServerUrl(url: string): void {
  STATE.directConnectServerUrl = url
}

// Usage: 5 calls
export function addToTotalLinesChanged(added: number, removed: number): void {
  STATE.totalLinesAdded += added
  STATE.totalLinesRemoved += removed
}

// Usage: 5 calls
export function snapshotOutputTokensForTurn(budget: number | null): void {
  outputTokensAtTurnStart = getTotalOutputTokens()
  currentTurnTokenBudget = budget
  budgetContinuationCount = 0
}
// Usage: 5 calls
export function setHasUnknownModelCost(): void {
  STATE.hasUnknownModelCost = true
}

// Usage: 5 calls
export function getLastMainRequestId(): string | undefined {
  return STATE.lastMainRequestId
}

// Usage: 5 calls
export function setLastApiCompletionTimestamp(timestamp: number): void {
  STATE.lastApiCompletionTimestamp = timestamp
}

/** Mark that a compaction just occurred. The next API success event will
 *  include isPostCompaction=true, then the flag auto-resets. */
// Usage: 5 calls
export function setCostStateForRestore({
  totalCostUSD,
  totalAPIDuration,
  totalAPIDurationWithoutRetries,
  totalToolDuration,
  totalLinesAdded,
  totalLinesRemoved,
  lastDuration,
  modelUsage,
}: {
  totalCostUSD: number
  totalAPIDuration: number
  totalAPIDurationWithoutRetries: number
  totalToolDuration: number
  totalLinesAdded: number
  totalLinesRemoved: number
  lastDuration: number | undefined
  modelUsage: { [modelName: string]: ModelUsage } | undefined
}): void {
  STATE.totalCostUSD = totalCostUSD
  STATE.totalAPIDuration = totalAPIDuration
  STATE.totalAPIDurationWithoutRetries = totalAPIDurationWithoutRetries
  STATE.totalToolDuration = totalToolDuration
  STATE.totalLinesAdded = totalLinesAdded
  STATE.totalLinesRemoved = totalLinesRemoved

  // Restore per-model usage breakdown
  if (modelUsage) {
    STATE.modelUsage = modelUsage
  }

  // Adjust startTime to make wall duration accumulate
  if (lastDuration) {
    STATE.startTime = Date.now() - lastDuration
  }
}

// Only used in tests
// Usage: 5 calls
export function getPrCounter(): AttributedCounter | null {
  return STATE.prCounter
}

// Usage: 5 calls
export function getCodeEditToolDecisionCounter(): AttributedCounter | null {
  return STATE.codeEditToolDecisionCounter
}

// Usage: 5 calls
export function getLoggerProvider(): LoggerProvider | null {
  return STATE.loggerProvider
}

// Usage: 5 calls
export function setLastClassifierRequests(requests: unknown[] | null): void {
  STATE.lastClassifierRequests = requests
}

// Usage: 5 calls
export function getChromeFlagOverride(): boolean | undefined {
  return STATE.chromeFlagOverride
}

// Usage: 5 calls
export function getUseCoworkPlugins(): boolean {
  return STATE.useCoworkPlugins
}

// Usage: 5 calls
export function getSessionCronTasks(): SessionCronTask[] {
  return STATE.sessionCronTasks
}

// Usage: 5 calls
export function setSessionTrustAccepted(accepted: boolean): void {
  STATE.sessionTrustAccepted = accepted
}

// Usage: 5 calls
export function hasExitedPlanModeInSession(): boolean {
  return STATE.hasExitedPlanMode
}

// Usage: 5 calls
export function clearRegisteredPluginHooks(): void {
  if (!STATE.registeredHooks) {
    return
  }

  const filtered: Partial<Record<HookEvent, RegisteredHookMatcher[]>> = {}
  for (const [event, matchers] of Object.entries(STATE.registeredHooks)) {
    // Keep only callback hooks (those without pluginRoot)
    const callbackHooks = matchers.filter(m => !('pluginRoot' in m))
    if (callbackHooks.length > 0) {
      filtered[event as HookEvent] = callbackHooks
    }
  }

  STATE.registeredHooks = Object.keys(filtered).length > 0 ? filtered : null
}

// Usage: 5 calls
export function getSessionCreatedTeams(): Set<string> {
  return STATE.sessionCreatedTeams
}

// Teleported session tracking for reliability logging
// Usage: 5 calls
export function setTeleportedSessionInfo(info: {
  sessionId: string | null
}): void {
  STATE.teleportedSessionInfo = {
    isTeleported: true,
    hasLoggedFirstMessage: false,
    sessionId: info.sessionId,
  }
}

// Usage: 5 calls
export function getInvokedSkillsForAgent(
  agentId: string | undefined | null,
): Map<string, InvokedSkillInfo> {
  const normalizedId = agentId ?? null
  const filtered = new Map<string, InvokedSkillInfo>()
  for (const [key, skill] of STATE.invokedSkills) {
    if (skill.agentId === normalizedId) {
      filtered.set(key, skill)
    }
  }
  return filtered
}

// Usage: 5 calls
export function setAdditionalDirectoriesForClaudeMd(
  directories: string[],
): void {
  STATE.additionalDirectoriesForClaudeMd = directories
}

// Usage: 5 calls
export function getPromptId(): string | null {
  return STATE.promptId
}

// Usage: 5 calls
export function setPromptId(id: string | null): void {
  STATE.promptId = id
}


// Usage: 4 calls
export function getTotalAPIDurationWithoutRetries(): number {
  return STATE.totalAPIDurationWithoutRetries
}

// Usage: 4 calls
export function addToToolDuration(duration: number): void {
  STATE.totalToolDuration += duration
  STATE.turnToolDurationMs += duration
  STATE.turnToolCount++
}

// Usage: 4 calls
export function addToTurnHookDuration(duration: number): void {
  STATE.turnHookDurationMs += duration
  STATE.turnHookCount++
}

// Usage: 4 calls
export function flushInteractionTime(): void {
  if (interactionTimeDirty) {
    flushInteractionTime_inner()
  }
}

function flushInteractionTime_inner(): void {
  STATE.lastInteractionTime = Date.now()
  interactionTimeDirty = false
}

// Usage: 4 calls
export function getTotalWebSearchRequests(): number {
  return sumBy(Object.values(STATE.modelUsage), 'webSearchRequests')
}

let outputTokensAtTurnStart = 0
let currentTurnTokenBudget: number | null = null
// Usage: 4 calls
export function getUsageForModel(model: string): ModelUsage | undefined {
  return STATE.modelUsage[model]
}

/**
 * Gets the model override set from the --model CLI flag or after the user
 * updates their configured model.
 */
// Usage: 4 calls
export function setSdkBetas(betas: string[] | undefined): void {
  STATE.sdkBetas = betas
}

// Usage: 4 calls
export function getLocCounter(): AttributedCounter | null {
  return STATE.locCounter
}

// Usage: 4 calls
export function setLoggerProvider(provider: LoggerProvider | null): void {
  STATE.loggerProvider = provider
}

// Usage: 4 calls
export function setEventLogger(
  logger: ReturnType<typeof logs.getLogger> | null,
): void {
  STATE.eventLogger = logger
}

// Usage: 4 calls
export function setMeterProvider(provider: MeterProvider | null): void {
  STATE.meterProvider = provider
}
// Usage: 4 calls
export function setTracerProvider(provider: BasicTracerProvider | null): void {
  STATE.tracerProvider = provider
}

// Usage: 4 calls
export function getStrictToolResultPairing(): boolean {
  return STATE.strictToolResultPairing
}

// Usage: 4 calls
export function getQuestionPreviewFormat(): 'markdown' | 'html' | undefined {
  return STATE.questionPreviewFormat
}

// Usage: 4 calls
export function setQuestionPreviewFormat(format: 'markdown' | 'html'): void {
  STATE.questionPreviewFormat = format
}

// Usage: 4 calls
export function getAgentColorMap(): Map<string, AgentColorName> {
  return STATE.agentColorMap
}

// Usage: 4 calls
export function getInitJsonSchema(): Record<string, unknown> | null {
  return STATE.initJsonSchema
}

// Usage: 4 calls
export function getTeleportedSessionInfo(): {
  isTeleported: boolean
  hasLoggedFirstMessage: boolean
  sessionId: string | null
} | null {
  return STATE.teleportedSessionInfo
}

// Usage: 4 calls
export function markFirstTeleportMessageLogged(): void {
  if (STATE.teleportedSessionInfo) {
    STATE.teleportedSessionInfo.hasLoggedFirstMessage = true
  }
}

// Invoked skills tracking for preservation across compaction
export type InvokedSkillInfo = {
  skillName: string
  skillPath: string
  content: string
  invokedAt: number
  agentId: string | null
}

// Usage: 4 calls
export function clearInvokedSkills(
  preservedAgentIds?: ReadonlySet<string>,
): void {
  if (!preservedAgentIds || preservedAgentIds.size === 0) {
    STATE.invokedSkills.clear()
    return
  }
  for (const [key, skill] of STATE.invokedSkills) {
    if (skill.agentId === null || !preservedAgentIds.has(skill.agentId)) {
      STATE.invokedSkills.delete(key)
    }
  }
}

// Usage: 4 calls
export function addSlowOperation(operation: string, durationMs: number): void {
  if (process.env.USER_TYPE !== 'ant') return
  // Skip tracking for editor sessions (user editing a prompt file in $EDITOR)
  // These are intentionally slow since the user is drafting text
  if (operation.includes('exec') && operation.includes('claude-prompt-')) {
    return
  }
  const now = Date.now()
  // Remove stale operations
  STATE.slowOperations = STATE.slowOperations.filter(
    op => now - op.timestamp < SLOW_OPERATION_TTL_MS,
  )
  // Add new operation
  STATE.slowOperations.push({ operation, durationMs, timestamp: now })
  // Keep only the most recent operations
  if (STATE.slowOperations.length > MAX_SLOW_OPERATIONS) {
    STATE.slowOperations = STATE.slowOperations.slice(-MAX_SLOW_OPERATIONS)
  }
}

const EMPTY_SLOW_OPERATIONS: ReadonlyArray<{
  operation: string
  durationMs: number
  timestamp: number
}> = []

// Usage: 4 calls
export function getSlowOperations(): ReadonlyArray<{
  operation: string
  durationMs: number
  timestamp: number
}> {
  // Most common case: nothing tracked. Return a stable reference so the
  // caller's setState() can bail via Object.is instead of re-rendering at 2fps.
  if (STATE.slowOperations.length === 0) {
    return EMPTY_SLOW_OPERATIONS
  }
  const now = Date.now()
  // Only allocate a new array when something actually expired; otherwise keep
  // the reference stable across polls while ops are still fresh.
  if (
    STATE.slowOperations.some(op => now - op.timestamp >= SLOW_OPERATION_TTL_MS)
  ) {
    STATE.slowOperations = STATE.slowOperations.filter(
      op => now - op.timestamp < SLOW_OPERATION_TTL_MS,
    )
    if (STATE.slowOperations.length === 0) {
      return EMPTY_SLOW_OPERATIONS
    }
  }
  // Safe to return directly: addSlowOperation() reassigns STATE.slowOperations
  // before pushing, so the array held in React state is never mutated.
  return STATE.slowOperations
}

// Usage: 4 calls
export function setIsRemoteMode(value: boolean): void {
  STATE.isRemoteMode = value
}

// System prompt section accessors

// Usage: 4 calls
export function setHasDevChannels(value: boolean): void {
  STATE.hasDevChannels = value
}

// Usage: 4 calls
export function clearBetaHeaderLatches(): void {
  STATE.afkModeHeaderLatched = null
  STATE.fastModeHeaderLatched = null
  STATE.cacheEditingHeaderLatched = null
  STATE.thinkingClearLatched = null
}

// Usage: 3 calls
export const onSessionSwitch = sessionSwitched.subscribe

/**
 * Project directory the current session's transcript lives in, or `null` if
 * the session was created in the current project (common case — derive from
 * originalCwd). See `switchSession()`.
 */
// Usage: 3 calls
export function getDirectConnectServerUrl(): string | undefined {
  return STATE.directConnectServerUrl
}

// Usage: 3 calls
export function addToTotalDurationState(
  duration: number,
  durationWithoutRetries: number,
): void {
  STATE.totalAPIDuration += duration
  STATE.totalAPIDurationWithoutRetries += durationWithoutRetries
}

// Usage: 3 calls
export function addToTotalCostState(
  cost: number,
  modelUsage: ModelUsage,
  model: string,
): void {
  STATE.modelUsage[model] = modelUsage
  STATE.totalCostUSD += cost
}

// Usage: 3 calls
export function getTotalToolDuration(): number {
  return STATE.totalToolDuration
}

// Usage: 3 calls
export function getTurnHookDurationMs(): number {
  return STATE.turnHookDurationMs
}

// Usage: 3 calls
export function resetTurnHookDuration(): void {
  STATE.turnHookDurationMs = 0
  STATE.turnHookCount = 0
}

// Usage: 3 calls
export function getTurnHookCount(): number {
  return STATE.turnHookCount
}

// Usage: 3 calls
export function getTurnToolDurationMs(): number {
  return STATE.turnToolDurationMs
}

// Usage: 3 calls
export function resetTurnToolDuration(): void {
  STATE.turnToolDurationMs = 0
  STATE.turnToolCount = 0
}

// Usage: 3 calls
export function getTurnToolCount(): number {
  return STATE.turnToolCount
}

// Usage: 3 calls
export function getTurnClassifierDurationMs(): number {
  return STATE.turnClassifierDurationMs
}

// Usage: 3 calls
export function addToTurnClassifierDuration(duration: number): void {
  STATE.turnClassifierDurationMs += duration
  STATE.turnClassifierCount++
}

// Usage: 3 calls
export function resetTurnClassifierDuration(): void {
  STATE.turnClassifierDurationMs = 0
  STATE.turnClassifierCount = 0
}

// Usage: 3 calls
export function getTurnClassifierCount(): number {
  return STATE.turnClassifierCount
}

// Usage: 3 calls
export function setStatsStore(
  store: { observe(name: string, value: number): void } | null,
): void {
  STATE.statsStore = store
}

/**
 * Marks that an interaction occurred.
 *
 * By default the actual Date.now() call is deferred until the next Ink render
 * frame (via flushInteractionTime()) so we avoid calling Date.now() on every
 * single keypress.
 *
 * Pass `immediate = true` when calling from React useEffect callbacks or
 * other code that runs *after* the Ink render cycle has already flushed.
 * Without it the timestamp stays stale until the next render, which may never
 * come if the user is idle (e.g. permission dialog waiting for input).
 */
let interactionTimeDirty = false

// Usage: 3 calls
export function getBudgetContinuationCount(): number {
  return budgetContinuationCount
}
// Usage: 3 calls
export function incrementBudgetContinuationCount(): void {
  budgetContinuationCount++
}

// Usage: 3 calls
export function setLastMainRequestId(requestId: string): void {
  STATE.lastMainRequestId = requestId
}

// Usage: 3 calls
export function consumePostCompaction(): boolean {
  const was = STATE.pendingPostCompaction
  STATE.pendingPostCompaction = false
  return was
}

// Usage: 3 calls
export function markScrollActivity(): void {
  scrollDraining = true
  if (scrollDrainTimer) clearTimeout(scrollDrainTimer)
  scrollDrainTimer = setTimeout(() => {
    scrollDraining = false
    scrollDrainTimer = undefined
  }, SCROLL_DRAIN_IDLE_MS)
  scrollDrainTimer.unref?.()
}

/** True while scroll is actively draining (within 150ms of last event).
 *  Intervals should early-return when this is set — the work picks up next
 *  tick after scroll settles. */
// Usage: 3 calls
export function setInitialMainLoopModel(model: ModelSetting): void {
  STATE.initialMainLoopModel = model
}

// Usage: 3 calls
export function setModelStrings(modelStrings: ModelStrings): void {
  STATE.modelStrings = modelStrings
}

// Test utility function to reset model strings for re-initialization.
// Separate from setModelStrings because we only want to accept 'null' in tests.
// Usage: 3 calls
export function setMeter(
  meter: Meter,
  createCounter: (name: string, options: MetricOptions) => AttributedCounter,
): void {
  STATE.meter = meter

  // Initialize all counters using the provided factory
  STATE.sessionCounter = createCounter('claude_code.session.count', {
    description: 'Count of CLI sessions started',
  })
  STATE.locCounter = createCounter('claude_code.lines_of_code.count', {
    description:
      "Count of lines of code modified, with the 'type' attribute indicating whether lines were added or removed",
  })
  STATE.prCounter = createCounter('claude_code.pull_request.count', {
    description: 'Number of pull requests created',
  })
  STATE.commitCounter = createCounter('claude_code.commit.count', {
    description: 'Number of git commits created',
  })
  STATE.costCounter = createCounter('claude_code.cost.usage', {
    description: 'Cost of the Claude Code session',
    unit: 'USD',
  })
  STATE.tokenCounter = createCounter('claude_code.token.usage', {
    description: 'Number of tokens used',
    unit: 'tokens',
  })
  STATE.codeEditToolDecisionCounter = createCounter(
    'claude_code.code_edit_tool.decision',
    {
      description:
        'Count of code editing tool permission decisions (accept/reject) for Edit, Write, and NotebookEdit tools',
    },
  )
  STATE.activeTimeCounter = createCounter('claude_code.active_time.total', {
    description: 'Total active time in seconds',
    unit: 's',
  })
}

// Usage: 3 calls
export function getMeter(): Meter | null {
  return STATE.meter
}

// Usage: 3 calls
export function getSessionCounter(): AttributedCounter | null {
  return STATE.sessionCounter
}

// Usage: 3 calls
export function getCommitCounter(): AttributedCounter | null {
  return STATE.commitCounter
}

// Usage: 3 calls
export function getCostCounter(): AttributedCounter | null {
  return STATE.costCounter
}

// Usage: 3 calls
export function getEventLogger(): ReturnType<typeof logs.getLogger> | null {
  return STATE.eventLogger
}

// Usage: 3 calls
export function getMeterProvider(): MeterProvider | null {
  return STATE.meterProvider
}

// Usage: 3 calls
export function setIsInteractive(value: boolean): void {
  STATE.isInteractive = value
}

// Usage: 3 calls
export function setClientType(type: string): void {
  STATE.clientType = type
}

// Usage: 3 calls
export function setSdkAgentProgressSummariesEnabled(value: boolean): void {
  STATE.sdkAgentProgressSummariesEnabled = value
}

// Usage: 3 calls
export function setSessionSource(source: string): void {
  STATE.sessionSource = source
}

// Usage: 3 calls
export function setFlagSettingsPath(path: string | undefined): void {
  STATE.flagSettingsPath = path
}

// Usage: 3 calls
export function setFlagSettingsInline(
  settings: Record<string, unknown> | null,
): void {
  STATE.flagSettingsInline = settings
}

// Usage: 3 calls
export function getSessionIngressToken(): string | null | undefined {
  return STATE.sessionIngressToken
}

// Usage: 3 calls
export function getOauthTokenFromFd(): string | null | undefined {
  return STATE.oauthTokenFromFd
}

// Usage: 3 calls
export function setOauthTokenFromFd(token: string | null): void {
  STATE.oauthTokenFromFd = token
}

// Usage: 3 calls
export function getApiKeyFromFd(): string | null | undefined {
  return STATE.apiKeyFromFd
}

// Usage: 3 calls
export function setApiKeyFromFd(key: string | null): void {
  STATE.apiKeyFromFd = key
}

// Usage: 3 calls
export function setLastAPIRequest(
  params: Omit<BetaMessageStreamParams, 'messages'> | null,
): void {
  STATE.lastAPIRequest = params
}

// Usage: 3 calls
export function getLastAPIRequest(): Omit<
  BetaMessageStreamParams,
  'messages'
> | null {
  return STATE.lastAPIRequest
}

// Usage: 3 calls
export function setLastAPIRequestMessages(
  messages: BetaMessageStreamParams['messages'] | null,
): void {
  STATE.lastAPIRequestMessages = messages
}

// Usage: 3 calls
export function getLastClassifierRequests(): unknown[] | null {
  return STATE.lastClassifierRequests
}

// Usage: 3 calls
export function setCachedClaudeMdContent(content: string | null): void {
  STATE.cachedClaudeMdContent = content
}

// Usage: 3 calls
export function getCachedClaudeMdContent(): string | null {
  return STATE.cachedClaudeMdContent
}

// Usage: 3 calls
export function addToInMemoryErrorLog(errorInfo: {
  error: string
  timestamp: string
}): void {
  const MAX_IN_MEMORY_ERRORS = 100
  if (STATE.inMemoryErrorLog.length >= MAX_IN_MEMORY_ERRORS) {
    STATE.inMemoryErrorLog.shift() // Remove oldest error
  }
  STATE.inMemoryErrorLog.push(errorInfo)
}

// Usage: 3 calls
export function getAllowedSettingSources(): SettingSource[] {
  return STATE.allowedSettingSources
}

// Usage: 3 calls
export function setAllowedSettingSources(sources: SettingSource[]): void {
  STATE.allowedSettingSources = sources
}

// Usage: 3 calls
export function setInlinePlugins(plugins: Array<string>): void {
  STATE.inlinePlugins = plugins
}

// Usage: 3 calls
export function setChromeFlagOverride(value: boolean | undefined): void {
  STATE.chromeFlagOverride = value
}

// Usage: 3 calls
export function setSessionBypassPermissionsMode(enabled: boolean): void {
  STATE.sessionBypassPermissionsMode = enabled
}

// Usage: 3 calls
export function addSessionCronTask(task: SessionCronTask): void {
  STATE.sessionCronTasks.push(task)
}

/**
 * Returns the number of tasks actually removed. Callers use this to skip
 * downstream work (e.g. the disk read in removeCronTasks) when all ids
 * were accounted for here.
 */
// Usage: 3 calls
export function setSessionPersistenceDisabled(disabled: boolean): void {
  STATE.sessionPersistenceDisabled = disabled
}

// Usage: 3 calls
export function handleAutoModeTransition(
  fromMode: string,
  toMode: string,
): void {
  // Auto↔plan transitions are handled by prepareContextForPlanMode (auto may
  // stay active through plan if opted in) and ExitPlanMode (restores mode).
  // Skip both directions so this function only handles direct auto transitions.
  if (
    (fromMode === 'auto' && toMode === 'plan') ||
    (fromMode === 'plan' && toMode === 'auto')
  ) {
    return
  }
  const fromIsAuto = fromMode === 'auto'
  const toIsAuto = toMode === 'auto'

  // If switching TO auto mode, clear any pending exit attachment
  // This prevents sending both auto_mode and auto_mode_exit when user toggles quickly
  if (toIsAuto && !fromIsAuto) {
    STATE.needsAutoModeExitAttachment = false
  }

  // If switching out of auto mode, trigger the auto_mode_exit attachment
  if (fromIsAuto && !toIsAuto) {
    STATE.needsAutoModeExitAttachment = true
  }
}

// LSP plugin recommendation session tracking
// Usage: 3 calls
export function hasShownLspRecommendationThisSession(): boolean {
  return STATE.lspRecommendationShownThisSession
}

// Usage: 3 calls
export function setLspRecommendationShownThisSession(value: boolean): void {
  STATE.lspRecommendationShownThisSession = value
}

// SDK init event state
// Usage: 3 calls
export function setInitJsonSchema(schema: Record<string, unknown>): void {
  STATE.initJsonSchema = schema
}

// Usage: 3 calls
export function resetSdkInitState(): void {
  STATE.initJsonSchema = null
  STATE.registeredHooks = null
}

// Usage: 3 calls
export function getSystemPromptSectionCache(): Map<string, string | null> {
  return STATE.systemPromptSectionCache
}

// Usage: 3 calls
export function setSystemPromptSectionCacheEntry(
  name: string,
  value: string | null,
): void {
  STATE.systemPromptSectionCache.set(name, value)
}

// Usage: 3 calls
export function clearSystemPromptSectionState(): void {
  STATE.systemPromptSectionCache.clear()
}

// Last emitted date accessors (for detecting midnight date changes)

// Usage: 3 calls
export function getLastEmittedDate(): string | null {
  return STATE.lastEmittedDate
}

// Usage: 3 calls
export function getHasDevChannels(): boolean {
  return STATE.hasDevChannels
}

// Usage: 3 calls
export function getPromptCache1hAllowlist(): string[] | null {
  return STATE.promptCache1hAllowlist
}

// Usage: 3 calls
export function setPromptCache1hAllowlist(allowlist: string[] | null): void {
  STATE.promptCache1hAllowlist = allowlist
}

// Usage: 3 calls
export function getPromptCache1hEligible(): boolean | null {
  return STATE.promptCache1hEligible
}

// Usage: 3 calls
export function setPromptCache1hEligible(eligible: boolean | null): void {
  STATE.promptCache1hEligible = eligible
}

// Usage: 3 calls
export function getAfkModeHeaderLatched(): boolean | null {
  return STATE.afkModeHeaderLatched
}

// Usage: 3 calls
export function setAfkModeHeaderLatched(v: boolean): void {
  STATE.afkModeHeaderLatched = v
}

// Usage: 3 calls
export function getFastModeHeaderLatched(): boolean | null {
  return STATE.fastModeHeaderLatched
}

// Usage: 3 calls
export function setFastModeHeaderLatched(v: boolean): void {
  STATE.fastModeHeaderLatched = v
}

// Usage: 3 calls
export function getCacheEditingHeaderLatched(): boolean | null {
  return STATE.cacheEditingHeaderLatched
}

// Usage: 3 calls
export function setCacheEditingHeaderLatched(v: boolean): void {
  STATE.cacheEditingHeaderLatched = v
}

// Usage: 3 calls
export function getThinkingClearLatched(): boolean | null {
  return STATE.thinkingClearLatched
}

// Usage: 3 calls
export function setThinkingClearLatched(v: boolean): void {
  STATE.thinkingClearLatched = v
}

/**
 * Reset beta header latches to null. Called on /clear and /compact so a
 * fresh conversation gets fresh header evaluation.
 */
// Usage: 1 calls
export function resetTotalDurationStateAndCost_FOR_TESTS_ONLY(): void {
  STATE.totalAPIDuration = 0
  STATE.totalAPIDurationWithoutRetries = 0
  STATE.totalCostUSD = 0
}

// Usage: 1 calls
export function resetModelStringsForTestingOnly() {
  STATE.modelStrings = null
}

// Usage: 1 calls
export function setStrictToolResultPairing(value: boolean): void {
  STATE.strictToolResultPairing = value
}

// Field name 'userMsgOptIn' avoids excluded-string substrings ('BriefTool',
// 'SendUserMessage' — case-insensitive). All callers are inside feature()
// guards so these accessors don't need their own (matches getKairosActive).
// Usage: 1 calls
export function getSessionSource(): string | undefined {
  return STATE.sessionSource
}

// Usage: 1 calls
export function getLastAPIRequestMessages():
  | BetaMessageStreamParams['messages']
  | null {
  return STATE.lastAPIRequestMessages
}

// Usage: 1 calls
export function clearRegisteredHooks(): void {
  STATE.registeredHooks = null
}

// Usage: 1 calls
export function getInvokedSkills(): Map<string, InvokedSkillInfo> {
  return STATE.invokedSkills
}

// Stub: not in restored source (referenced by SendMessageTool, ToolSearchTool)
export function isReplBridgeActive(): boolean {
  return false
}
