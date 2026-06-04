import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { randomUUID } from 'crypto'
import { join as pathJoin, resolve as pathResolve } from 'path'
import type { ValidationResult, ToolDef, ToolResult, PermissionResult } from '../../Tool.js'
import { buildTool } from '../../Tool.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { ToolUseContext } from '../../Tool.js'
import type { AssistantMessage } from '../../types/message.js'
import { getCwd } from '../../utils/cwd.js'
import { logError } from '../../utils/log.js'
import { generateTaskId } from '../../Task.js'
import { getProjectRoot } from '../../bootstrap/state.js'
import { getRuleByContentsForToolName } from '../../utils/permissions/permissions.js'

// Task lifecycle functions
import {
  registerWorkflowTask,
  completeWorkflowTask,
  failWorkflowTask,
  enqueueWorkflowNotification,
  registerWorkflowAgentController,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'

// Internal imports
import {
  parseWorkflowMeta,
  compileWorkflowScript,
  hasNonDeterministicCalls,
} from './sandbox.js'
import { LocalFileJournal } from './journal.js'
import { executeWorkflowScript } from './execution.js'
import { DESCRIPTION, WORKFLOW_PROMPT } from './prompts.js'
import {
  WORKFLOW_TOOL_NAME,
  MAX_SCRIPT_SIZE,
  RUN_ID_PREFIX,
  RUN_ID_REGEX,
} from './constants.js'
import { getWorkflowByName, listWorkflowNames } from './bundled/index.js'
import * as UI from './UI.js'

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * Input schema for the Workflow tool.
 * Mirrors v159's qL3 schema.
 */
const inputSchema = z.strictObject({
  script: z
    .string()
    .max(MAX_SCRIPT_SIZE)
    .optional()
    .describe(
      'Self-contained workflow script. Must begin with `export const meta = { name, description, phases }` ' +
        '(pure literal, no computed values) followed by the script body using agent()/parallel()/pipeline()/phase().',
    ),
  name: z
    .string()
    .optional()
    .describe(
      'Name of a predefined workflow (built-in or from .claude/workflows/). ' +
        'Resolves to a self-contained script.',
    ),
  description: z
    .string()
    .optional()
    .describe('Ignored — set the workflow description in the script\'s `meta` block.'),
  title: z
    .string()
    .optional()
    .describe('Ignored — set the workflow title in the script\'s `meta` block.'),
  args: z
    .unknown()
    .optional()
    .describe(
      'Optional input value exposed to the script as the global `args`, verbatim. ' +
        'Pass arrays/objects as actual JSON values, NOT as a JSON-encoded string — ' +
        'a stringified list breaks args.filter/args.map in the script. Use for parameterized named workflows (e.g. a research question).',
    ),
  scriptPath: z
    .string()
    .optional()
    .describe(
      'Path to a workflow script file on disk. Every Workflow invocation persists its script ' +
        'under the session directory and returns the path in the tool result. ' +
        'To iterate, edit that file with Write/Edit and re-invoke Workflow with the same `scriptPath`. ' +
        'Takes precedence over `script` and `name`.',
    ),
  resumeFromRunId: z
    .string()
    .regex(RUN_ID_REGEX)
    .optional()
    .describe(
      'Run ID of a prior Workflow invocation to resume from. ' +
        'Completed agent() calls with unchanged (prompt, opts) return their cached results instantly; ' +
        'only edited or new calls re-run. Same-session only. ' +
        'Stop the prior run with TaskStopTool({taskId}) before resuming.',
    ),
}).refine(
  (input) => input.script || input.name || input.scriptPath,
  { message: 'Must provide script, name, or scriptPath' },
)

type InputSchema = typeof inputSchema
type Input = z.infer<InputSchema>

/**
 * Output schema — what the tool returns to the model.
 * Mirrors v159's KL3 schema.
 */
const outputSchema = z.object({
  status: z.enum(['async_launched', 'remote_launched']),
  taskId: z.string(),
  runId: z
    .string()
    .optional()
    .describe(
      'Local workflow run identifier for resumeFromRunId. ' +
        'Absent for remote_launched (the CCR session URL is the resume handle there) ' +
        'and on transcripts written before this field existed.',
    ),
  summary: z.string().optional(),
  transcriptDir: z
    .string()
    .optional()
    .describe('Directory where subagent transcripts are written during execution'),
  scriptPath: z
    .string()
    .optional()
    .describe(
      'Path to the persisted workflow script for this invocation. ' +
        'Editable via Write/Edit; pass back as `scriptPath` to re-run without resending the script.',
    ),
  sessionUrl: z
    .string()
    .optional()
    .describe('CCR session URL when status is remote_launched'),
  warning: z
    .string()
    .optional()
    .describe(
      'Non-blocking heads-up (e.g. local git state diverges from the pushed branch).',
    ),
  error: z
    .string()
    .optional()
    .describe('Set if syntax check failed'),
})

type OutputSchema = typeof outputSchema
type Output = z.infer<OutputSchema>

// ---------------------------------------------------------------------------
// Script resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the script from the tool input.
 * Returns the script source and metadata about where it came from.
 */
type ScriptResolution =
  | { script: string; source?: string; resolvedScriptPath?: string }
  | { error: string }

async function resolveScript(input: Input): Promise<ScriptResolution> {
  // Priority 1: scriptPath (read from disk)
  if (input.scriptPath) {
    if (input.script) {
      // Both script and scriptPath provided — use script but return scriptPath for persistence
      return {
        script: input.script,
        resolvedScriptPath: pathResolve(getCwd(), input.scriptPath),
      }
    }

    // SECURITY: Reject UNC paths to prevent credential leakage
    if (input.scriptPath.startsWith('\\\\') || input.scriptPath.startsWith('//')) {
      return { error: `UNC paths are not allowed for workflow scriptPath: ${input.scriptPath}` }
    }

    try {
      const { readFile, stat } = await import('fs/promises')
      const fileStat = await stat(input.scriptPath)

      if (fileStat.size > MAX_SCRIPT_SIZE) {
        return {
          error: `Workflow script file ${input.scriptPath} exceeds ${MAX_SCRIPT_SIZE} bytes`,
        }
      }

      const script = await readFile(input.scriptPath, 'utf8')
      return {
        script,
        resolvedScriptPath: pathResolve(getCwd(), input.scriptPath),
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e)
      return { error: `Failed to read workflow script file ${input.scriptPath}: ${message}` }
    }
  }

  // Priority 2: name (look up in built-in / plugin / user / project registry)
  if (input.name) {
    const workflow = await getWorkflowByName(input.name, getCwd())
    if (workflow) {
      return {
        script: workflow.script,
        source: workflow.source,
        resolvedScriptPath: workflow.filePath,
      }
    }
    const available = await listWorkflowNames(getCwd())
    return { error: `Workflow "${input.name}" not found. Available: ${available.join(', ')}` }
  }

  // Priority 3: inline script
  if (input.script) {
    return { script: input.script }
  }

  return { error: 'Must provide script, name, or scriptPath' }
}

// ---------------------------------------------------------------------------
// The WorkflowTool
// ---------------------------------------------------------------------------

export const WorkflowTool = buildTool({
  name: WORKFLOW_TOOL_NAME,
  aliases: ['RunWorkflow'],
  searchHint: 'orchestrate subagents with deterministic JavaScript workflow',
  maxResultSizeChars: 100_000,

  // ── Schemas ───────────────────────────────────────────────────────
  get inputSchema(): InputSchema {
    return inputSchema
  },

  get outputSchema(): OutputSchema {
    return outputSchema
  },

  // ── Feature gate ──────────────────────────────────────────────────
  isEnabled(): boolean {
    if (feature('WORKFLOW_SCRIPTS')) return true
    return false
  },

  // ── Prompts ───────────────────────────────────────────────────────
  async prompt() {
    return WORKFLOW_PROMPT
  },

  async description() {
    return DESCRIPTION
  },

  // ── Classification ────────────────────────────────────────────────
  // ── Validation ────────────────────────────────────────────────────
  async validateInput(input: Input, context: ToolUseContext): Promise<ValidationResult> {
    const settings = (context.getAppState() as unknown as { settings?: Record<string, unknown> })
      .settings
    if (
      settings?.disableWorkflows === true ||
      process.env.CLAUDE_CODE_DISABLE_WORKFLOWS === '1' ||
      process.env.CLAUDE_CODE_DISABLE_WORKFLOWS === 'true'
    ) {
      return {
        result: false,
        message: 'Dynamic workflows are disabled by managed settings (`disableWorkflows`).',
        errorCode: 5,
      }
    }

    if (feature('WORKFLOW_SCRIPTS')) {
      // enabled
    } else {
      return {
        result: false,
        message:
          'Dynamic workflows are not enabled for this session (org policy, launch gate, or the "Dynamic workflows" setting in /config).',
        errorCode: 6,
      }
    }

    // Resolve script
    const resolution = await resolveScript(input)
    if ('error' in resolution) {
      return { result: false, message: resolution.error, errorCode: 1 }
    }

    // Parse meta
    const metaResult = parseWorkflowMeta(resolution.script)
    if (!metaResult.ok) {
      return {
        result: false,
        message: `Invalid workflow script: ${metaResult.error}`,
        errorCode: 2,
      }
    }

    // Determinism check (block Date.now / Math.random / new Date())
    if (
      hasNonDeterministicCalls(metaResult.meta.scriptBody)
    ) {
      return {
        result: false,
        message:
          'Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() ' +
          'are unavailable (breaks resume). Stamp results after the workflow returns, ' +
          'or pass timestamps via args.',
        errorCode: 4,
      }
    }

    // Resume validation: check that the runId is not still running
    if (input.resumeFromRunId) {
      for (const [taskId, task] of Object.entries(context.getAppState().tasks)) {
        if (
          task.type === 'local_workflow' &&
          task.status === 'running' &&
          (task as any).workflowRunId === input.resumeFromRunId
        ) {
          return {
            result: false,
            message:
              `Workflow ${input.resumeFromRunId} is still running (task ${taskId}). ` +
              `Stop it first with TaskStopTool({taskId: "${taskId}"}) before resuming.`,
            errorCode: 3,
          }
        }
      }
    }

    return { result: true }
  },

  // ── Permissions ───────────────────────────────────────────────────
  async checkPermissions(
    input: Input,
    context: ToolUseContext,
  ): Promise<PermissionResult> {
    let effectiveInput = input
    const workflowName = input.scriptPath ? undefined : input.name

    if (input.scriptPath || input.name) {
      const resolution = await resolveScript(input)
      if (!('error' in resolution)) {
        effectiveInput = { ...input, script: resolution.script }
      }
    }

    if (workflowName) {
      const permissionContext = context.getAppState().toolPermissionContext
      const denyRule = getRuleByContentsForToolName(
        permissionContext,
        WORKFLOW_TOOL_NAME,
        'deny',
      ).get(workflowName)
      if (denyRule) {
        return {
          behavior: 'deny',
          message: `Workflow ${workflowName} blocked by permission rules`,
          decisionReason: { type: 'rule', rule: denyRule },
        }
      }

      const askRule = getRuleByContentsForToolName(
        permissionContext,
        WORKFLOW_TOOL_NAME,
        'ask',
      ).get(workflowName)
      if (askRule) {
        return {
          behavior: 'ask',
          message: 'Review dynamic workflow before running',
          updatedInput: effectiveInput,
          decisionReason: { type: 'rule', rule: askRule },
        }
      }

      const allowRule = getRuleByContentsForToolName(
        permissionContext,
        WORKFLOW_TOOL_NAME,
        'allow',
      ).get(workflowName)
      if (allowRule) {
        return {
          behavior: 'allow',
          updatedInput: effectiveInput,
          decisionReason: { type: 'rule', rule: allowRule },
        }
      }
    }

    return {
      behavior: 'ask',
      message: 'Review dynamic workflow before running',
      updatedInput: effectiveInput,
      suggestions: workflowName
        ? [
            {
              type: 'addRules',
              rules: [{ toolName: WORKFLOW_TOOL_NAME, ruleContent: workflowName }],
              behavior: 'allow',
              destination: 'localSettings',
            },
          ]
        : undefined,
    }
  },

  // ── Main execution ────────────────────────────────────────────────
  async call(
    input: Input,
    context: ToolUseContext,
    _canUseTool: CanUseToolFn,
    _parentMessage: AssistantMessage,
    onProgress?: (progress: { type: 'progress'; data: unknown }) => void,
  ): Promise<ToolResult<Output>> {
    // 1. Resolve script
    const resolution = await resolveScript(input)
    if ('error' in resolution) {
      throw new Error(resolution.error)
    }

    const { script, resolvedScriptPath } = resolution
    const metaResult = parseWorkflowMeta(script)
    if (!metaResult.ok) {
      throw new Error(`Invalid workflow script: ${metaResult.error}`)
    }

    const meta = metaResult.meta

    // 2. Generate runId
    const runId = input.resumeFromRunId ?? `${RUN_ID_PREFIX}${randomUUID().slice(0, 12)}`
    const taskId = generateTaskId('local_workflow')

    // 3. Compile script in sandbox
    const compiled = compileWorkflowScript(meta.scriptBody)
    if (!compiled.ok) {
      return {
        data: {
          status: 'async_launched',
          taskId,
          runId,
          summary: meta.description,
          error: compiled.error,
        },
      }
    }

    // 4. Determine script persistence path
    const scriptPath = resolvedScriptPath ?? await persistScriptPath(
      meta.name,
      runId,
      script,
    )

    // 5. Resume: clean up old non-running tasks with same runId
    if (input.resumeFromRunId) {
      context.setAppState((prev) => {
        const newTasks = { ...prev.tasks }
        for (const [tid, task] of Object.entries(newTasks)) {
          if (
            task.type === 'local_workflow' &&
            (task as any).workflowRunId === input.resumeFromRunId &&
            task.status !== 'running'
          ) {
            delete newTasks[tid]
          }
        }
        return { ...prev, tasks: newTasks }
      })
    }

    const workflowController = new AbortController()
    context.abortController?.signal.addEventListener(
      'abort',
      () => workflowController.abort('workflow-abort'),
      { once: true },
    )

    // 6. Register task in AppState
    registerWorkflowTask({
      id: taskId,
      description: meta.description ?? meta.name,
      toolUseId: context.toolUseId,
      script,
      scriptPath,
      workflowName: meta.name,
      title: meta.title,
      phases: meta.phases,
      defaultModel: context.options.mainLoopModel,
      workflowRunId: runId,
      args: input.args,
      workflowController,
      setAppState: context.setAppState,
    })

    // 7. Token budget (placeholder — would integrate with real budget tracking)
    const tokenBudget = {
      total: null as number | null,
      getTurnSpent: () => 0,
    }

    // 8. Create journal instance
    const journal = new LocalFileJournal(runId)

    // 9. Fire-and-forget background execution
    const { getAppState, setAppState } = context

    // Build the tool pool for workflow subagents.
    // Workflow subagents get all tools with 'acceptEdits' permission mode.
    const { assembleToolPool } = require('../../tools.js') as {
      assembleToolPool: (ctx: unknown, mcpTools: unknown) => import('../../Tool.js').Tools
    }
    const appState = getAppState()
    const workerPermissionContext = {
      ...appState.toolPermissionContext,
      mode: 'acceptEdits',
    }
    const availableTools = assembleToolPool(workerPermissionContext, appState.mcp.tools)

    void (async () => {
      const startTime = Date.now()
      try {
        const result = await executeWorkflowScript(
          compiled.vmScript,
          getAppState,
          setAppState,
          {
            workflowRunId: runId,
            taskId,
            onProgress: onProgress ?? (() => {}),
            args: input.args,
            seedPhaseTitles: meta.phases?.map((p) => p.title),
            tokenBudget,
            journal,
            toolUseContext: context,
            abortSignal: workflowController.signal,
            canUseTool: _canUseTool,
            availableTools,
            onAgentController: (agentId, controller) =>
              registerWorkflowAgentController({
                taskId,
                agentId,
                controller,
                setAppState,
              }),
          },
        )

        const taskAfterRun = getAppState().tasks[taskId]
        if (
          taskAfterRun?.type === 'local_workflow' &&
          taskAfterRun.status === 'killed'
        ) {
          await persistSnapshot(runId, {
            taskId,
            script,
            scriptPath,
            args: input.args,
            result: null,
            agentCount: result.agentCount,
            logs: result.logs,
            durationMs: result.durationMs,
            error: result.error,
            summary: meta.description,
            workflowName: meta.name,
            title: meta.title,
            status: 'killed',
            startTime,
            phases: meta.phases,
            totalTokens: 0,
            totalToolCalls: 0,
          })
          return
        }

        // Persist snapshot
        await persistSnapshot(runId, {
          taskId,
          script,
          scriptPath,
          args: input.args,
          result: result.result,
          agentCount: result.agentCount,
          logs: result.logs,
          durationMs: result.durationMs,
          error: result.error,
          summary: meta.description,
          workflowName: meta.name,
          title: meta.title,
          status: result.error ? 'failed' : 'completed',
          startTime,
          phases: meta.phases,
          totalTokens: 0,
          totalToolCalls: 0,
        })

        // Complete or fail the task
        if (result.error) {
          failWorkflowTask(taskId, result.error, result.agentCount, setAppState)
        } else {
          completeWorkflowTask(taskId, result.result, result.agentCount, setAppState)
        }

        // Enqueue notification
        enqueueWorkflowNotification({
          taskId,
          description: meta.description ?? meta.name,
          startTime,
          summary: meta.description ?? '',
          status: result.error ? 'failed' : 'completed',
          error: result.error,
          agentCount: result.agentCount,
          totalTokens: 0,
          totalToolCalls: 0,
          durationMs: result.durationMs,
          transcriptDir: getTranscriptDir(runId),
          setAppState,
        })
      } catch (e: unknown) {
        const error = e instanceof Error ? e.message : String(e)
        logError(error)

        const taskAfterError = getAppState().tasks[taskId]
        if (
          taskAfterError?.type === 'local_workflow' &&
          taskAfterError.status === 'killed'
        ) {
          return
        }

        failWorkflowTask(taskId, error, 0, setAppState)
        enqueueWorkflowNotification({
          taskId,
          description: meta.description ?? meta.name,
          startTime,
          summary: meta.description ?? '',
          status: 'failed',
          error,
          agentCount: 0,
          totalTokens: 0,
          totalToolCalls: 0,
          durationMs: Date.now() - startTime,
          transcriptDir: getTranscriptDir(runId),
          setAppState,
        })
      }
    })()

    // 10. Return immediately (fire-and-forget)
    return {
      data: {
        status: 'async_launched',
        taskId,
        runId,
        summary: meta.description,
        transcriptDir: getTranscriptDir(runId),
        scriptPath,
      },
    }
  },

  // ── Concurrency ───────────────────────────────────────────────────
  isConcurrencySafe(): boolean {
    return true // Workflow itself is safe; agents inside handle their own concurrency
  },

  isReadOnly(): boolean {
    return true // The tool call itself doesn't modify files (agents inside might)
  },

  // ── UI rendering ──────────────────────────────────────────────────
  renderToolUseMessage: UI.renderToolUseMessage,
  renderToolUseProgressMessage: UI.renderToolUseProgressMessage,
  renderToolResultMessage: UI.renderToolResultMessage,
  renderToolUseErrorMessage: UI.renderToolUseErrorMessage,
  renderToolUseRejectedMessage: UI.renderToolUseRejectedMessage,
  renderToolUseTag: UI.renderToolUseTag,
  getToolUseSummary: UI.getToolUseSummary,
  getActivityDescription: UI.getActivityDescription,
  userFacingName: UI.userFacingName,
  toAutoClassifierInput: UI.toAutoClassifierInput,
} satisfies ToolDef<InputSchema, Output>)

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Generate a persistence path for the workflow script.
 * Writes to disk and returns the absolute path.
 */
async function persistScriptPath(
  workflowName: string,
  runId: string,
  script: string,
): Promise<string> {
  const safeName = workflowName.replace(/[^a-zA-Z0-9_-]/g, '-')
  const { mkdir, writeFile } = await import('fs/promises')
  const { dirname, join } = await import('path')

  const dir = join(getProjectRoot(), '.claude', 'scripts')
  const filePath = join(dir, `${safeName}-${runId}.js`)
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, script, 'utf8')
  return filePath
}

/**
 * Persist a workflow snapshot to disk.
 * Path: .claude/projects/{hash}/workflows/{runId}.json
 */
async function persistSnapshot(
  runId: string,
  snapshot: Record<string, unknown>,
): Promise<void> {
  const { mkdir, writeFile } = await import('fs/promises')
  const { dirname, join } = await import('path')

  const snapshotPath = join(
    getProjectRoot(),
    '.claude',
    'workflows',
    `${runId}.json`,
  )
  await mkdir(dirname(snapshotPath), { recursive: true })
  await writeFile(
    snapshotPath,
    JSON.stringify(
      { runId, timestamp: new Date().toISOString(), ...snapshot },
      null,
      2,
    ),
    'utf8',
  )
}

/**
 * Get the transcript directory for a workflow run.
 * Path: .claude/projects/{hash}/subagents/workflows/{runId}/
 */
function getTranscriptDir(runId: string): string {
  return pathJoin(
    getProjectRoot(),
    '.claude',
    'subagents',
    'workflows',
    runId,
  )
}
