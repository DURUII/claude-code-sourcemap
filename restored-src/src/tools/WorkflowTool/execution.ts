import { createHash } from 'crypto'
import { cpus } from 'os'
import { createContext, type Script } from 'vm'
import type { AppState } from '../../state/AppState.js'
import type { SetAppState } from '../../Task.js'
import { toolMatchesName, type Tool, type Tools, type ToolUseContext } from '../../Tool.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { AgentDefinition } from '../AgentTool/loadAgentsDir.js'
import { runAgent } from '../AgentTool/runAgent.js'
import { finalizeAgentTool } from '../AgentTool/agentToolUtils.js'
import { extractTextContent } from '../../utils/messages.js'
import { createUserMessage } from '../../utils/messages.js'
import { asAgentId } from '../../types/ids.js'
import { getQuerySourceForAgent } from '../../utils/promptCategory.js'
import {
  filterDeniedAgents,
  getDenyRuleForAgent,
} from '../../utils/permissions/permissions.js'
import { isLocalWorkflowTask } from '../../tasks/LocalWorkflowTask/types.js'
import { getCwd, runWithCwdOverride } from '../../utils/cwd.js'
import {
  createAgentWorktree,
  hasWorktreeChanges,
  removeAgentWorktree,
} from '../../utils/worktree.js'
import { registerStructuredOutputEnforcement } from '../../utils/hooks/hookHelpers.js'
import { clearSessionHooks } from '../../utils/hooks/sessionHooks.js'
import { buildWorktreeNotice } from '../AgentTool/forkSubagent.js'
import {
  createSyntheticOutputTool,
  SYNTHETIC_OUTPUT_TOOL_NAME,
} from '../SyntheticOutputTool/SyntheticOutputTool.js'
import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'
import { LocalFileJournal } from './journal.js'

// ---------------------------------------------------------------------------
// Concurrency & budget constants
// ---------------------------------------------------------------------------

/** Max concurrent agent() calls per workflow (clamped by core count) */
const MAX_CONCURRENT_AGENTS = Math.min(16, Math.max(2, cpus().length - 2))

/** Hard cap on total agent() calls across a workflow's lifetime */
const MAX_TOTAL_AGENTS = 1000

/** Progress event batch interval (ms) — matches v159's S=16. */
const PROGRESS_BATCH_INTERVAL_MS = 16
const PREVIEW_MAX_LENGTH = 400
const DEFAULT_STALL_MS = 180_000
const MAX_STALL_RETRIES = 5

function VEH(value: unknown): string | undefined {
  if (value == null) return undefined
  const text = (typeof value === 'string' ? value : JSON.stringify(value)).trim()
  if (!text) return undefined
  return text.length > PREVIEW_MAX_LENGTH
    ? `${text.slice(0, PREVIEW_MAX_LENGTH)}…`
    : text
}

function summarizeToolInput(input: unknown): string | undefined {
  if (input == null || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'prompt']) {
    const value = record[key]
    if (typeof value === 'string') return VEH(value.replace(/\s+/g, ' '))
  }
  for (const value of Object.values(record)) {
    if (typeof value === 'string') return VEH(value.replace(/\s+/g, ' '))
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Cache key generation
// ---------------------------------------------------------------------------

const CACHE_VERSION = 'v2'

/**
 * Normalize agent() call options into a deterministic string for cache key.
 * Only includes: schema, model, isolation, agentType.
 * Keys are sorted alphabetically; arrays and objects are recursively sorted.
 */
function normalizeOpts(opts: Record<string, unknown>): string {
  const picked: Record<string, unknown> = {}
  for (const key of ['schema', 'model', 'isolation', 'agentType']) {
    if (opts[key] !== undefined && typeof opts[key] !== 'function') {
      picked[key] = opts[key]
    }
  }
  return JSON.stringify(sortKeysRecursive(picked))
}

function sortKeysRecursive(
  value: unknown,
): unknown {
  if (Array.isArray(value)) return value.map(sortKeysRecursive)
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysRecursive((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

/**
 * Generate a deterministic cache key for an agent() call.
 * Format: "v2:{sha256}"
 */
export function generateCacheKey(
  prompt: string,
  opts: Record<string, unknown>,
): string {
  const hash = createHash('sha256')
    .update(CACHE_VERSION)
    .update('\0')
    .update(prompt)
    .update('\0')
    .update(normalizeOpts(opts))
    .digest('hex')
  return `${CACHE_VERSION}:${hash}`
}

// ---------------------------------------------------------------------------
// Token budget
// ---------------------------------------------------------------------------

/**
 * Shared token budget across the main loop and all workflows in this turn.
 * When the user specifies a budget (e.g. "+500k"), agent() calls that would
 * exceed it throw an error.
 */
export type TokenBudget = {
  /** Total token target from the user's directive. null if not set. */
  total: number | null
  /** Read current output tokens spent this turn (main loop + all workflows) */
  getTurnSpent(): number
}

/**
 * Check remaining budget. Returns Infinity when no budget is set.
 */
export function budgetRemaining(budget: TokenBudget): number {
  if (budget.total === null) return Infinity
  return Math.max(0, budget.total - budget.getTurnSpent())
}

// ---------------------------------------------------------------------------
// Progress event types
// ---------------------------------------------------------------------------

export type WorkflowProgressData = {
  type: 'workflow_agent' | 'workflow_log' | 'workflow_phase'
  index?: number
  title?: string
  kind?: string
  agentId?: string
  agentType?: string
  isolation?: 'worktree' | 'remote'
  model?: string
  label?: string
  phaseTitle?: string
  phaseIndex?: number
  state?: 'start' | 'progress' | 'done' | 'error'
  error?: string
  tokens?: number
  toolCalls?: number
  durationMs?: number
  startedAt?: number
  queuedAt?: number
  lastProgressAt?: number
  worktreePath?: string
  stalledReason?: 'stalled' | 'user-retry' | 'user-skip' | 'throttled'
  structuredOutputAttempts?: number
  attempt?: number
  lastAttemptReason?: string
  lastToolName?: string
  lastToolSummary?: string
  promptPreview?: string
  resultPreview?: string
  skipped?: boolean
  cached?: boolean
  message?: string
  timestamp: number
}

class WorkflowAgentControlError extends Error {
  constructor(
    readonly reason: string,
    cause?: unknown,
  ) {
    super(reason)
    this.name = 'WorkflowAgentControlError'
    this.cause = cause
  }
}

export type OnProgressCallback = (event: {
  type: 'progress'
  data: WorkflowProgressData
}) => void

export type OnAgentControllerCallback = (
  agentId: string,
  controller: AbortController | null,
) => void

// ---------------------------------------------------------------------------
// Execution context
// ---------------------------------------------------------------------------

/**
 * Result of executing a workflow script.
 */
export type WorkflowExecutionResult = {
  /** Final return value from the script (or null if error) */
  result: unknown
  /** Total agents spawned */
  agentCount: number
  /** Log messages from log() calls */
  logs: string[]
  /** Wall-clock duration in ms */
  durationMs: number
  /** Error if the script threw or a fatal constraint was hit */
  error?: string
  /** Whether execution failed due to agent cap */
  agentCapReached?: boolean
}

// ---------------------------------------------------------------------------
// Workflow subagent system prompts (from v159 binary)
// ---------------------------------------------------------------------------

/**
 * System prompt for workflow subagents WITHOUT a schema.
 * The agent's text response is returned verbatim to the script.
 */
const WORKFLOW_SUBAGENT_PROMPT_NO_SCHEMA = `You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.
CRITICAL: Your final text response is returned **verbatim** as a string to the calling script — it is your return value, not a message to a human.
- Output the literal result (data, JSON, text). Do NOT output confirmations like "Done." or "Sent."
- If asked for JSON, return ONLY the raw JSON — no code fences, no prose, no markdown.
- Do NOT use SendUserMessage to deliver your answer. Put your answer in your final text response.
- Be concise. The script will parse your output.`

const WORKFLOW_CUSTOM_AGENT_SUFFIX_NO_SCHEMA = `
---
NOTE: You are running inside a workflow script. Your final text response is returned verbatim as a string to the calling script — it is your return value, not a message to a human. Output the literal result; do not output confirmations like "Done." Be concise — the script will parse your output.`

/**
 * System prompt for workflow subagents WITH a schema.
 * The agent must call StructuredOutput exactly once.
 */
function workflowSubagentPromptWithSchema(toolName: string): string {
  return `You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.
CRITICAL: You MUST call the ${toolName} tool exactly once to return your final answer. The tool's input schema defines the required shape.
- Do your work (Read files, run commands, etc.), then call ${toolName} with your answer.
- Do NOT put your answer in a text response. The script reads ONLY the ${toolName} tool call.
- If the schema validation fails, read the error and call ${toolName} again with a corrected shape.
- After calling ${toolName} successfully, end your turn. No acknowledgment needed.`
}

function workflowCustomAgentSuffixWithSchema(toolName: string): string {
  return `
---
NOTE: You are running inside a workflow script. You MUST return your final answer by calling the ${toolName} tool exactly once — the tool's input schema defines the required shape. Do your work, then call ${toolName}; do NOT put your answer in a text response (the script reads ONLY the tool call). If validation fails, read the error and call ${toolName} again with a corrected shape.`
}

// ---------------------------------------------------------------------------
// Workflow subagent agent definition (from v159 binary)
// ---------------------------------------------------------------------------

/**
 * Create an AgentDefinition for a workflow subagent.
 * Matches v159's bU8/JR3 definitions.
 */
function createWorkflowSubagentDef(opts?: {
  schema?: Record<string, unknown>
}): AgentDefinition {
  const hasSchema = opts?.schema != null

  return {
    agentType: 'workflow-subagent',
    whenToUse: 'Internal subagent for workflow script orchestration.',
    tools: ['*'],
    disallowedTools: ['AskUserQuestion', 'Skill'],
    source: 'built-in',
    baseDir: 'built-in',
    getSystemPrompt: () =>
      hasSchema
        ? workflowSubagentPromptWithSchema(SYNTHETIC_OUTPUT_TOOL_NAME)
        : WORKFLOW_SUBAGENT_PROMPT_NO_SCHEMA,
  }
}

// ---------------------------------------------------------------------------
// Execution context (extended with toolUseContext + canUseTool)
// ---------------------------------------------------------------------------

export type WorkflowExecuteOptions = {
  taskId: string
  workflowRunId: string
  onProgress: OnProgressCallback
  onAgentController: OnAgentControllerCallback
  args?: unknown
  seedPhaseTitles?: string[]
  tokenBudget: TokenBudget
  journal: LocalFileJournal
  /** Full toolUseContext from the parent — needed for runAgent() */
  toolUseContext: ToolUseContext
  abortSignal?: AbortSignal
  /** canUseTool function from the parent */
  canUseTool: CanUseToolFn
  /** Available tools for subagents */
  availableTools: Tools
}

// ---------------------------------------------------------------------------
// Main execution function
// ---------------------------------------------------------------------------

/**
 * Execute a compiled workflow script in a sandboxed context.
 *
 * Injects the runtime API:
 *   - agent(prompt, opts?) → Promise<string|object>
 *   - parallel(thunks) → Promise<any[]>
 *   - pipeline(items, stage1, stage2, ...) → Promise<any[]>
 *   - phase(title) → void
 *   - log(message) → void
 *   - args → whatever was passed in
 *   - budget → { total, spent(), remaining() }
 *
 * The script runs as an async IIFE. Progress events are emitted via
 * onProgress and persisted to the journal for resume support.
 */
export async function executeWorkflowScript(
  vmScript: Script,
  getAppState: () => AppState,
  setAppState: SetAppState,
  options: WorkflowExecuteOptions,
): Promise<WorkflowExecutionResult> {
  const {
    workflowRunId,
    taskId,
    onProgress,
    onAgentController,
    args,
    seedPhaseTitles = [],
    tokenBudget,
    journal,
    toolUseContext,
    abortSignal,
    canUseTool,
    availableTools,
  } = options

  const startTime = Date.now()
  let agentCount = 0
  const logs: string[] = []
  let currentPhaseTitle: string | undefined

  // Load existing journal for resume
  const journalView = await journal.load()

  // ---- Progress batching ----
  const progressQueue: WorkflowProgressData[] = []
  let batchTimer: ReturnType<typeof setTimeout> | null = null

  let activeAgents = 0
  const agentSlotQueue: Array<() => void> = []

  function assertWorkflowNotAborted(): void {
    if (abortSignal?.aborted) {
      throw new Error('Workflow aborted')
    }
  }

  async function waitForAgentSlot(): Promise<void> {
    if (activeAgents >= MAX_CONCURRENT_AGENTS) {
      await new Promise<void>((resolve, reject) => {
        const resume = () => {
          abortSignal?.removeEventListener('abort', abort)
          resolve()
        }
        const abort = () => {
          const index = agentSlotQueue.indexOf(resume)
          if (index >= 0) agentSlotQueue.splice(index, 1)
          reject(new Error('Workflow aborted'))
        }
        abortSignal?.addEventListener('abort', abort, { once: true })
        agentSlotQueue.push(resume)
      })
    }
  }

  async function withAgentSlot<T>(fn: () => Promise<T>): Promise<T> {
    assertWorkflowNotAborted()
    await waitForAgentSlot()
    assertWorkflowNotAborted()
    activeAgents++
    try {
      return await fn()
    } finally {
      activeAgents--
      agentSlotQueue.shift()?.()
    }
  }

  function flushProgress(): void {
    if (progressQueue.length === 0) return
    const batch = progressQueue.splice(0)

    // Filter out internal log-only events before updating task state
    const visibleEvents = batch.filter(
      (e) => e.type !== 'workflow_log',
    )
    if (visibleEvents.length === 0) return

    // Update task state with latest progress
    const appState = getAppState()
    const task = appState.tasks[taskId]
    if (
      !isLocalWorkflowTask(task) ||
      task.status !== 'running'
    ) {
      return
    }

    // Update workflowProgress array
    const lastAgentEvent = [...visibleEvents].findLast(
      (e) => e.type === 'workflow_agent',
    )

    setAppState((prev) => {
      const current = prev.tasks[taskId]
      if (!isLocalWorkflowTask(current) || current.status !== 'running') {
        return prev
      }
      return {
        ...prev,
        tasks: {
          ...prev.tasks,
          [taskId]: {
            ...current,
            workflowProgress: [
              ...current.workflowProgress,
              ...visibleEvents,
            ],
            totalTokens:
              lastAgentEvent?.tokens ?? current.totalTokens,
            totalToolCalls:
              lastAgentEvent?.toolCalls ?? current.totalToolCalls,
          },
        },
      }
    })

    // Emit SDK progress event
    const taskState = getAppState().tasks[taskId]
    if (isLocalWorkflowTask(taskState)) {
      // emitTaskProgress would go here — depends on SDK flag
    }
  }

  function emitProgress(data: WorkflowProgressData): void {
    progressQueue.push(data)
    onProgress({ type: 'progress', data })

    if (!batchTimer) {
      batchTimer = setTimeout(() => {
        batchTimer = null
        flushProgress()
      }, PROGRESS_BATCH_INTERVAL_MS)
    }
  }

  const phaseIds = new Map<string, number>()
  let nextPhaseId = 0

  function resolvePhase(title: string, kind?: string): number {
    const existing = phaseIds.get(title)
    if (existing != null) return existing
    const index = ++nextPhaseId
    phaseIds.set(title, index)
    emitProgress({
      type: 'workflow_phase',
      index,
      title,
      phaseTitle: title,
      kind,
      timestamp: Date.now(),
    })
    return index
  }

  for (const title of seedPhaseTitles) {
    resolvePhase(title)
  }

  // ---- Runtime API injected into the sandbox ----

  /**
   * agent(prompt, opts?) — spawn a subagent.
   *
   * Resume semantics:
   * 1. Generate cache key from prompt + opts
   * 2. Check journalView.results for existing result
   * 3. If found → return cached result (instant, no API call)
   * 4. If not found → spawn real agent, persist result to journal
   */
  async function callAgent(
    prompt: string,
    opts?: Record<string, unknown>,
  ): Promise<unknown> {
    assertWorkflowNotAborted()

    // Enforce agent cap
    if (agentCount >= MAX_TOTAL_AGENTS) {
      throw new Error(
        `Workflow agent() call cap reached (${MAX_TOTAL_AGENTS}). ` +
          'This usually means a loop using budget.remaining() never terminates. ' +
          'Add a hard iteration cap to the loop, or pass a token budget.',
      )
    }

    // Enforce token budget
    if (tokenBudget.total !== null) {
      const remaining = budgetRemaining(tokenBudget)
      if (remaining <= 0) {
        throw new Error(
          `Token budget exhausted. ${tokenBudget.total.toLocaleString()} token limit reached.`,
        )
      }
    }

    const cacheKey = generateCacheKey(prompt, opts ?? {})

    // Check journal for cached result (resume hit)
    const cachedResult = journalView.results.get(cacheKey)
    if (cachedResult && !cachedResult.error) {
      return cachedResult.result
    }

    // Spawn a new agent
    const agentIndex = agentCount + 1
    const agentId = `workflow_agent_${workflowRunId}_${agentIndex}`
    const label = (opts?.label as string) ?? prompt.slice(0, 80)
    const phaseIndex = currentPhaseTitle
      ? resolvePhase(currentPhaseTitle)
      : undefined

    agentCount = agentIndex
    const queuedAt = Date.now()
    const promptPreview = VEH(prompt)

    // Emit started event
    emitProgress({
      type: 'workflow_agent',
      index: agentIndex,
      agentId,
      agentType: typeof opts?.agentType === 'string' ? opts.agentType : undefined,
      isolation: opts?.isolation === 'worktree' || opts?.isolation === 'remote'
        ? opts.isolation
        : undefined,
      model: (opts?.model as string | undefined) ?? toolUseContext.options.mainLoopModel,
      label,
      phaseTitle: currentPhaseTitle,
      phaseIndex,
      state: 'start',
      queuedAt,
      startedAt: queuedAt,
      lastProgressAt: queuedAt,
      promptPreview,
      attempt: 1,
      timestamp: queuedAt,
    })

    // Persist started to journal
    await journal.append({
      type: 'started',
      key: cacheKey,
      agentId,
      label,
      prompt,
      phaseTitle: currentPhaseTitle,
      phaseIndex,
      timestamp: Date.now(),
    })

    let agentResult!: SpawnSubagentResult
    let attempt = 1
    const attemptReasons: string[] = []
    while (true) {
      try {
        agentResult = await withAgentSlot(() =>
          spawnSubagent({
            agentId,
            agentIndex,
            prompt,
            opts,
            toolUseContext,
            canUseTool,
            availableTools,
            transcriptSubdir: `workflows/${workflowRunId}`,
            workflowRunId,
            abortSignal,
            onProgress: emitProgress,
            onAgentController,
          }),
        )
        break
      } catch (e: unknown) {
        if (e instanceof WorkflowAgentControlError) {
          if (e.reason === 'user-skip') {
            emitProgress({
              type: 'workflow_agent',
              index: agentIndex,
              agentId,
              label,
              phaseTitle: currentPhaseTitle,
              phaseIndex,
              state: 'error',
              skipped: true,
              stalledReason: 'user-skip',
              error: 'skipped by user',
              attempt,
              timestamp: Date.now(),
            })
            return null
          }
          if (e.reason === 'user-retry' || e.reason === 'stalled') {
            attemptReasons.push(e.reason)
            if (attempt > MAX_STALL_RETRIES) {
              const allUserRetry = attemptReasons.every(reason => reason === 'user-retry')
              const allStalled = attemptReasons.every(reason => reason === 'stalled')
              throw new Error(
                allUserRetry
                  ? `agent abandoned: user requested retry on all ${attemptReasons.length} attempts`
                  : allStalled
                    ? `agent stalled on all ${attemptReasons.length} attempts (no progress for ${DEFAULT_STALL_MS}ms each)`
                    : `agent abandoned after ${attemptReasons.length} attempts (${attemptReasons.join(' → ')})`,
              )
            }
            attempt++
            const lastAttemptReason = e.reason === 'user-retry'
              ? 'retry requested by user'
              : 'stalled (no progress)'
            emitProgress({
              type: 'workflow_agent',
              index: agentIndex,
              agentId,
              label,
              phaseTitle: currentPhaseTitle,
              phaseIndex,
              state: 'start',
              stalledReason: e.reason,
              lastAttemptReason,
              attempt,
              timestamp: Date.now(),
            })
            continue
          }
        }
        const error = e instanceof Error ? e.message : String(e)
        emitProgress({
          type: 'workflow_agent',
          index: agentIndex,
          agentId,
          label,
          phaseTitle: currentPhaseTitle,
          phaseIndex,
          state: 'error',
          error,
          attempt,
          timestamp: Date.now(),
        })
        throw e
      }
    }

    // Persist result to journal
    await journal.append({
      type: 'result',
      key: cacheKey,
      agentId,
      label,
      result: opts?.schema != null ? agentResult.structured ?? agentResult.text : agentResult.text,
      tokens: agentResult.tokens,
      toolCalls: agentResult.toolCalls,
      durationMs: agentResult.durationMs,
      timestamp: Date.now(),
    })

    // Emit completed event
    emitProgress({
      type: 'workflow_agent',
      index: agentIndex,
      agentId,
      label,
      phaseTitle: currentPhaseTitle,
      phaseIndex,
      state: 'done',
      tokens: agentResult.tokens,
      toolCalls: agentResult.toolCalls,
      durationMs: agentResult.durationMs,
      resultPreview: VEH(opts?.schema != null ? agentResult.structured : agentResult.text),
      timestamp: Date.now(),
    })

    // Return structured result if schema was provided, else text
    return opts?.schema != null ? agentResult.structured ?? agentResult.text : agentResult.text
  }

  /**
   * parallel(thunks) — run all thunks concurrently, return results array.
   * Failed thunks resolve to null (call never rejects).
   */
  async function callParallel(
    thunks: Array<() => Promise<unknown>>,
  ): Promise<unknown[]> {
    const results = await Promise.allSettled(
      thunks.map(async (thunk) => {
        try {
          return await thunk()
        } catch {
          return null
        }
      }),
    )
    return results.map((r) =>
      r.status === 'fulfilled' ? r.value : null,
    )
  }

  /**
   * pipeline(items, ...stages) — run each item through all stages.
   * Items flow independently — no barrier between stages.
   * A stage that throws drops that item to null and skips remaining stages.
   */
  async function callPipeline(
    items: unknown[],
    ...stages: Array<
      (prev: unknown, item: unknown, index: number) => Promise<unknown>
    >
  ): Promise<unknown[]> {
    return Promise.all(
      items.map(async (item, index) => {
        let value: unknown = item
        for (const [stageIndex, stage] of stages.entries()) {
          try {
            value = await stage(stageIndex === 0 ? item : value, item, index)
            if (value === null) return null
          } catch {
            return null
          }
        }
        return value
      }),
    )
  }

  /**
   * phase(title) — set the current phase for subsequent agent() calls.
   */
  function callPhase(title: string): void {
    currentPhaseTitle = title
    resolvePhase(title)
  }

  /**
   * log(message) — emit a progress log message.
   */
  function callLog(message: string): void {
    logs.push(message)
    emitProgress({
      type: 'workflow_log',
      message,
      timestamp: Date.now(),
    })
  }

  // ---- Build sandbox context ----
  const sandboxContext: Record<string, unknown> = {
    agent: callAgent,
    parallel: callParallel,
    pipeline: callPipeline,
    phase: callPhase,
    log: callLog,
    args,
    budget: {
      total: tokenBudget.total,
      spent: () => tokenBudget.getTurnSpent(),
      remaining: () => budgetRemaining(tokenBudget),
    },
  }

  // ---- Execute ----
  try {
    const vmContext = createContext(sandboxContext)
    const result = await vmScript.runInContext(vmContext, {
      timeout: 300_000,
    })

    // Final flush of progress queue
    if (batchTimer) {
      clearTimeout(batchTimer)
    }
    flushProgress()

    return {
      result,
      agentCount,
      logs,
      durationMs: Date.now() - startTime,
    }
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : String(e)

    if (batchTimer) {
      clearTimeout(batchTimer)
    }
    flushProgress()

    return {
      result: null,
      agentCount,
      logs,
      durationMs: Date.now() - startTime,
      error,
    }
  }
}

// ---------------------------------------------------------------------------
// Subagent spawning — integrates with AgentTool/runAgent pipeline
// ---------------------------------------------------------------------------

type SpawnSubagentResult = {
  text: string
  structured?: unknown
  tokens: number
  toolCalls: number
  durationMs: number
  structuredOutputAttempts?: number
  lastStructuredOutputInput?: unknown
}

/**
 * Spawn a workflow subagent using the real runAgent() pipeline.
 *
 * This mirrors v159's H_ function inside the execution engine:
 * 1. Create an inline AgentDefinition (workflow-subagent)
 * 2. Build prompt messages
 * 3. Call runAgent() — the async generator that streams the agent conversation
 * 4. Collect all messages
 * 5. Call finalizeAgentTool() to extract the result
 */
async function spawnSubagent(params: {
  agentId: string
  agentIndex: number
  prompt: string
  opts?: Record<string, unknown>
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  availableTools: Tools
  transcriptSubdir?: string
  workflowRunId: string
  abortSignal?: AbortSignal
  onProgress: (data: WorkflowProgressData) => void
  onAgentController: OnAgentControllerCallback
}): Promise<SpawnSubagentResult> {
  const {
    agentId,
    agentIndex,
    prompt,
    opts,
    toolUseContext,
    canUseTool,
    availableTools,
    transcriptSubdir,
    workflowRunId,
    abortSignal,
    onProgress,
    onAgentController,
  } = params

  const startTime = Date.now()

  const schema = opts?.schema as Record<string, unknown> | undefined
  const stallMs =
    opts?.stallMs != null && Number.isFinite(Number(opts.stallMs))
      ? Number(opts.stallMs)
      : DEFAULT_STALL_MS
  const agentDef = createWorkflowAgentDef(toolUseContext, opts, schema)
  const appState = toolUseContext.getAppState()
  const { assembleToolPool } = require('../../tools.js') as {
    assembleToolPool: (ctx: unknown, mcpTools: Tools) => Tools
  }
  const workerPermissionContext = {
    ...appState.toolPermissionContext,
    mode: (agentDef as { permissionMode?: string }).permissionMode ?? 'acceptEdits',
  }
  const freshTools = assembleToolPool(workerPermissionContext, appState.mcp.tools)
  const { tools, structuredOutputTool } = getWorkflowAgentTools(
    freshTools.length > 0 ? freshTools : availableTools,
    schema,
  )

  const promptMessages = [createUserMessage(prompt)]

  const abortController = new AbortController()
  if (abortSignal?.aborted) {
    abortController.abort(abortSignal.reason ?? 'workflow-abort')
  } else {
    abortSignal?.addEventListener(
      'abort',
      () => abortController.abort(abortSignal.reason ?? 'workflow-abort'),
      { once: true },
    )
  }
  onAgentController(agentId, abortController)
  const rootSetAppState = toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState
  if (schema) {
    registerStructuredOutputEnforcement(rootSetAppState, agentId, 'SubagentStop')
  }

  const messages: import('../../types/message.js').Message[] = []
  let structured: unknown = undefined
  let structuredOutputAttempts = 0
  let lastStructuredOutputInput: unknown = undefined
  let lastToolName: string | undefined
  let lastToolSummary: string | undefined
  let worktreeInfo: Awaited<ReturnType<typeof createAgentWorktree>> | null = null
  let stallTimer: ReturnType<typeof setTimeout> | undefined
  const resetStallTimer = () => {
    if (stallTimer) clearTimeout(stallTimer)
    if (stallMs > 0) {
      stallTimer = setTimeout(() => abortController.abort('stalled'), stallMs)
    }
  }

  try {
    if (opts?.isolation === 'worktree') {
      worktreeInfo = await createAgentWorktree(`${workflowRunId}-${agentIndex}`)
      promptMessages.push(createUserMessage({
        content: buildWorktreeNotice(
          getCwd(),
          worktreeInfo.worktreePath,
        ),
      }))
      onProgress({
        type: 'workflow_log',
        agentId,
        message:
          `You are running in an isolated git worktree at ${worktreeInfo.worktreePath}`,
        timestamp: Date.now(),
      })
    }

    const run = async () => {
      resetStallTimer()
      for await (const message of runAgent({
        agentDefinition: agentDef,
        promptMessages,
        toolUseContext: {
          ...toolUseContext,
          abortController,
          agentId: asAgentId(agentId),
        },
        canUseTool,
        isAsync: false,
        querySource: getQuerySourceForAgent(agentDef.agentType, agentDef.source === 'built-in'),
        availableTools: tools,
        override: {
          agentId: asAgentId(agentId),
          abortController,
          ...(opts?.model ? { systemContext: {} } : {}),
        },
        model: opts?.model as string | undefined,
        worktreePath: worktreeInfo?.worktreePath,
        transcriptSubdir,
        onQueryProgress: () => {
          resetStallTimer()
          onProgress({
            type: 'workflow_agent',
            index: agentIndex,
            agentId,
            agentType: agentDef.agentType,
            isolation: worktreeInfo ? 'worktree' : undefined,
            model: opts?.model as string ?? toolUseContext.options.mainLoopModel,
            label: (opts?.label as string) ?? prompt.slice(0, 80),
            state: 'progress',
            lastProgressAt: Date.now(),
            lastToolName,
            lastToolSummary,
            worktreePath: worktreeInfo?.worktreePath,
            timestamp: Date.now(),
          })
        },
      })) {
        messages.push(message)
        resetStallTimer()
        if (
          message.type === 'attachment' &&
          message.attachment.type === 'structured_output'
        ) {
          structured = message.attachment.data
        }
        if (message.type === 'assistant') {
          let sawToolUse = false
          for (const block of message.message.content) {
            if (block.type === 'tool_use') {
              sawToolUse = true
              lastToolName = block.name
              lastToolSummary = summarizeToolInput(block.input)
            }
            if (
              block.type === 'tool_use' &&
              toolMatchesName(
                structuredOutputTool ?? { name: SYNTHETIC_OUTPUT_TOOL_NAME } as Tool,
                block.name,
              )
            ) {
              structuredOutputAttempts++
              lastStructuredOutputInput = block.input
            }
          }
          if (sawToolUse) {
            onProgress({
              type: 'workflow_agent',
              index: agentIndex,
              agentId,
              agentType: agentDef.agentType,
              isolation: worktreeInfo ? 'worktree' : undefined,
              model: opts?.model as string ?? toolUseContext.options.mainLoopModel,
              label: (opts?.label as string) ?? prompt.slice(0, 80),
              state: 'progress',
              lastProgressAt: Date.now(),
              lastToolName,
              lastToolSummary,
              worktreePath: worktreeInfo?.worktreePath,
              timestamp: Date.now(),
            })
          }
        }
      }
    }

    if (worktreeInfo?.worktreePath) {
      await runWithCwdOverride(worktreeInfo.worktreePath, run)
    } else {
      await run()
    }
  } catch (e: unknown) {
    if (abortController.signal.aborted) {
      if (
        abortController.signal.reason === 'stalled' &&
        schema &&
        structured !== undefined
      ) {
        // Match v159: if the subagent produced structured output before the
        // stall timer fired, accept that result instead of retrying.
      } else {
      throw new WorkflowAgentControlError(
        String(abortController.signal.reason ?? 'workflow-abort'),
        e,
      )
      }
    }
    if (!abortController.signal.aborted) throw e
  } finally {
    if (stallTimer) clearTimeout(stallTimer)
    onAgentController(agentId, null)
    if (schema) {
      clearSessionHooks(rootSetAppState, agentId)
    }
    if (worktreeInfo) {
      const { worktreePath, worktreeBranch, headCommit, gitRoot, hookBased } = worktreeInfo
      if (!hookBased && headCommit) {
        const changed = await hasWorktreeChanges(worktreePath, headCommit)
        if (!changed) {
          await removeAgentWorktree(worktreePath, worktreeBranch, gitRoot)
        }
      }
    }
  }

  const agentResult = finalizeAgentTool(messages, agentId, {
    prompt,
    resolvedAgentModel: opts?.model as string ?? toolUseContext.options.mainLoopModel,
    isBuiltInAgent: agentDef.source === 'built-in',
    startTime,
    agentType: agentDef.agentType,
    isAsync: false,
  })

  const text = extractTextContent(agentResult.content, '\n')

  if (schema && structured === undefined) {
    for (const msg of messages) {
      if (msg.type !== 'assistant') continue
      for (const block of msg.message.content) {
        if (
          block.type === 'tool_use' &&
          toolMatchesName(structuredOutputTool ?? { name: SYNTHETIC_OUTPUT_TOOL_NAME } as Tool, block.name)
        ) {
          structured = block.input
          break
        }
      }
      if (structured !== undefined) break
    }
  }

  if (schema && structured === undefined) {
    throw new Error(
      `agent({schema}): subagent completed without calling ${SYNTHETIC_OUTPUT_TOOL_NAME} (after 2 in-conversation nudges)`,
    )
  }

  return {
    text,
    structured,
    tokens: agentResult.totalTokens,
    toolCalls: agentResult.totalToolUseCount,
    durationMs: agentResult.totalDurationMs,
    structuredOutputAttempts,
    lastStructuredOutputInput,
  }
}

function createWorkflowAgentDef(
  toolUseContext: ToolUseContext,
  opts: Record<string, unknown> | undefined,
  schema?: Record<string, unknown>,
): AgentDefinition {
  const requestedAgentType =
    typeof opts?.agentType === 'string' && opts.agentType.trim()
      ? opts.agentType.trim()
      : undefined
  const allAgents = toolUseContext.options.agentDefinitions.activeAgents
  const { allowedAgentTypes } = toolUseContext.options.agentDefinitions
  const candidates = allowedAgentTypes
    ? allAgents.filter(agent => allowedAgentTypes.includes(agent.agentType))
    : allAgents
  const agents = filterDeniedAgents(
    candidates,
    toolUseContext.getAppState().toolPermissionContext,
    AGENT_TOOL_NAME,
  )
  const base = requestedAgentType
    ? agents.find(agent => agent.agentType === requestedAgentType)
    : undefined

  if (requestedAgentType && !base) {
    const existsButDenied = allAgents.find(
      agent => agent.agentType === requestedAgentType,
    )
    if (existsButDenied) {
      const denyRule = getDenyRuleForAgent(
        toolUseContext.getAppState().toolPermissionContext,
        AGENT_TOOL_NAME,
        requestedAgentType,
      )
      throw new Error(
        `agent({agentType}): '${requestedAgentType}' is denied by permission rule '${AGENT_TOOL_NAME}(${requestedAgentType})' from ${denyRule?.source ?? 'settings'}.`,
      )
    }
    const available = agents.map(agent => agent.agentType).join(', ')
    throw new Error(
      `agent({agentType}): agent type '${requestedAgentType}' not found. Available agents: ${available}`,
    )
  }

  const agentDef = base ?? createWorkflowSubagentDef({ schema })
  if (!base) return agentDef

  const suffix = schema
    ? workflowCustomAgentSuffixWithSchema(SYNTHETIC_OUTPUT_TOOL_NAME)
    : WORKFLOW_CUSTOM_AGENT_SUFFIX_NO_SCHEMA
  const defaultWorkflowAgent = createWorkflowSubagentDef()

  return {
    ...agentDef,
    tools: addToolIfMissing(agentDef.tools, SYNTHETIC_OUTPUT_TOOL_NAME, schema !== undefined),
    disallowedTools: [
      ...(agentDef.disallowedTools ?? []),
      ...(defaultWorkflowAgent.disallowedTools ?? []),
    ],
    getSystemPrompt: (params: { toolUseContext: Pick<ToolUseContext, 'options'> }) => {
      const original = (agentDef.getSystemPrompt as (p?: unknown) => string)(params)
      return `${original}${suffix}`
    },
  } as AgentDefinition
}

function addToolIfMissing(
  tools: string[] | undefined,
  toolName: string,
  shouldAdd: boolean,
): string[] | undefined {
  if (!shouldAdd) return tools
  if (!tools || tools.length === 0 || (tools.length === 1 && tools[0] === '*')) {
    return tools
  }
  return tools.includes(toolName) ? tools : [...tools, toolName]
}

function getWorkflowAgentTools(
  availableTools: Tools,
  schema?: Record<string, unknown>,
): { tools: Tools; structuredOutputTool?: Tool } {
  if (!schema) return { tools: availableTools }
  const result = createSyntheticOutputTool(schema)
  if ('error' in result) {
    throw new Error(`agent({schema}) received an invalid JSON Schema: ${result.error}`)
  }
  const tools = availableTools.filter(
    tool => !toolMatchesName(tool, SYNTHETIC_OUTPUT_TOOL_NAME),
  )
  tools.push(result.tool)
  return { tools, structuredOutputTool: result.tool }
}
