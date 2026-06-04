import type { SetAppState, Task, TaskStateBase } from '../../Task.js'
import { createTaskStateBase } from '../../Task.js'
import { updateTaskState, registerTask } from '../../utils/task/framework.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
} from '../../constants/xml.js'

export type WorkflowProgressData = {
  type: 'workflow_agent' | 'workflow_log' | 'workflow_phase'
  agentId?: string
  index?: number
  title?: string
  kind?: string
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

export type LocalWorkflowTaskState = TaskStateBase & {
  type: 'local_workflow'
  script: string
  scriptPath: string
  workflowName?: string
  title?: string
  summary?: string
  phases?: Array<{ title: string; detail?: string }>
  workflowRunId: string
  args?: unknown
  defaultModel?: string
  workflowProgress: WorkflowProgressData[]
  agentCount: number
  totalTokens: number
  totalToolCalls: number
  workflowController: AbortController
  agentControllers: Map<string, AbortController>
  error?: string
  result?: unknown
  isBackgrounded: true
}

export function isLocalWorkflowTask(
  task: unknown,
): task is LocalWorkflowTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'local_workflow'
  )
}

export function registerWorkflowTask(input: {
  id: string
  description: string
  toolUseId?: string
  script: string
  scriptPath: string
  workflowName?: string
  title?: string
  phases?: Array<{ title: string; detail?: string }>
  defaultModel?: string
  workflowRunId: string
  args?: unknown
  workflowController: AbortController
  setAppState: SetAppState
}): void {
  const task: LocalWorkflowTaskState = {
    ...createTaskStateBase(input.id, 'local_workflow', input.description, input.toolUseId),
    type: 'local_workflow',
    status: 'running',
    script: input.script,
    scriptPath: input.scriptPath,
    workflowName: input.workflowName,
    title: input.title,
    summary: input.description,
    phases: input.phases,
    defaultModel: input.defaultModel,
    workflowRunId: input.workflowRunId,
    args: input.args,
    workflowProgress: [],
    agentCount: 0,
    totalTokens: 0,
    totalToolCalls: 0,
    workflowController: input.workflowController,
    agentControllers: new Map(),
    isBackgrounded: true,
  }
  registerTask(task, input.setAppState)
}

export function registerWorkflowAgentController(input: {
  taskId: string
  agentId: string
  controller: AbortController | null
  setAppState: SetAppState
}): void {
  updateTaskState<LocalWorkflowTaskState>(input.taskId, input.setAppState, task => {
    const agentControllers = new Map(task.agentControllers)
    if (input.controller) {
      agentControllers.set(input.agentId, input.controller)
    } else {
      agentControllers.delete(input.agentId)
    }
    return {
      ...task,
      agentControllers,
    }
  })
}

export function completeWorkflowTask(
  taskId: string,
  result: unknown,
  agentCount: number,
  setAppState: SetAppState,
): void {
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    return {
      ...task,
      status: 'completed',
      result,
      agentCount,
      endTime: Date.now(),
    }
  })
}

export function failWorkflowTask(
  taskId: string,
  error: string,
  agentCount: number,
  setAppState: SetAppState,
): void {
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    return {
      ...task,
      status: 'failed',
      error,
      agentCount,
      endTime: Date.now(),
    }
  })
}

export function killWorkflowTask(taskId: string, setAppState: SetAppState): void {
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    task.workflowController.abort('workflow-abort')
    for (const controller of task.agentControllers.values()) {
      controller.abort('workflow-abort')
    }
    return {
      ...task,
      status: 'killed',
      agentControllers: new Map(),
      endTime: Date.now(),
    }
  })
}

export function skipWorkflowAgent(
  taskId: string,
  agentId: string,
  setAppState: SetAppState,
): void {
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    task.agentControllers.get(agentId)?.abort('user-skip')
    const agentControllers = new Map(task.agentControllers)
    agentControllers.delete(agentId)
    return {
      ...task,
      agentControllers,
      workflowProgress: [
        ...task.workflowProgress,
        {
          type: 'workflow_agent',
          agentId,
          state: 'error',
          skipped: true,
          stalledReason: 'user-skip',
          error: 'skipped by user',
          timestamp: Date.now(),
        },
      ],
    }
  })
}

export function retryWorkflowAgent(
  taskId: string,
  agentId: string,
  setAppState: SetAppState,
): void {
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    task.agentControllers.get(agentId)?.abort('user-retry')
    return {
      ...task,
      workflowProgress: [
        ...task.workflowProgress,
        {
          type: 'workflow_agent',
          agentId,
          state: 'progress',
          stalledReason: 'user-retry',
          lastAttemptReason: 'retry requested by user',
          timestamp: Date.now(),
        },
      ],
    }
  })
}

export function enqueueWorkflowNotification(input: {
  taskId: string
  description: string
  startTime: number
  summary?: string
  status: 'completed' | 'failed' | 'killed'
  error?: string
  agentCount: number
  totalTokens: number
  totalToolCalls: number
  durationMs: number
  transcriptDir?: string
  setAppState: SetAppState
}): void {
  const statusText =
    input.status === 'completed'
      ? 'completed'
      : input.status === 'failed'
        ? `failed: ${input.error ?? 'Unknown error'}`
        : 'was stopped'
  const summary = input.summary || input.description
  const transcriptDir = input.transcriptDir
    ? `\n<transcript_dir>${escapeXml(input.transcriptDir)}</transcript_dir>`
    : ''

  enqueuePendingNotification({
    value: `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${input.taskId}</${TASK_ID_TAG}>
<${OUTPUT_FILE_TAG}>${escapeXml(getTaskOutputPath(input.taskId))}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>${input.status}</${STATUS_TAG}>
<${SUMMARY_TAG}>${escapeXml(`Dynamic workflow "${summary}" ${statusText}`)}</${SUMMARY_TAG}>${transcriptDir}
</${TASK_NOTIFICATION_TAG}>`,
    mode: 'task-notification',
    priority: 'next',
  })

  updateTaskState<LocalWorkflowTaskState>(input.taskId, input.setAppState, task => ({
    ...task,
    notified: true,
  }))
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export const LocalWorkflowTask: Task = {
  name: 'LocalWorkflowTask',
  type: 'local_workflow',
  async kill(taskId: string, setAppState: SetAppState): Promise<void> {
    killWorkflowTask(taskId, setAppState)
  },
}
