import React, { createElement } from 'react'
import type { Tools } from '../../Tool.js'
import type { ThemeName } from '../../utils/theme.js'
import type { ProgressMessage } from '../../types/message.js'
import type { WorkflowProgressData } from './execution.js'

// ---------------------------------------------------------------------------
// Tool use message rendering
// ---------------------------------------------------------------------------

export function renderToolUseMessage(
  input: Record<string, unknown>,
  options: { theme: ThemeName; verbose: boolean },
): React.ReactNode {
  const { verbose } = options

  if (input.name) {
    return createElement(
      'div',
      null,
      createElement('span', { style: { color: 'subtle' } }, 'dynamic workflow: '),
      createElement('span', null, String(input.name)),
    )
  }

  if (!input.script) {
    return createElement('div', null, 'dynamic workflow')
  }

  // Extract first non-empty line from script as a preview
  const script = String(input.script)
  const firstLine = script.split('\n').find((line) => line.trim()) ?? ''
  const preview =
    firstLine.length > 80
      ? firstLine.slice(0, 79) + '…'
      : firstLine

  return createElement(
    'div',
    null,
    createElement('span', { style: { color: 'subtle' } }, 'running workflow: '),
    createElement('span', { style: { fontFamily: 'monospace', fontSize: 12 } }, preview),
  )
}

// ---------------------------------------------------------------------------
// Progress message rendering
// ---------------------------------------------------------------------------

export function renderToolUseProgressMessage(
  progressMessages: ProgressMessage<WorkflowProgressData>[],
  options: {
    tools: Tools
    verbose: boolean
    terminalSize?: { columns: number; rows: number }
    inProgressToolCallCount?: number
    isTranscriptMode?: boolean
  },
): React.ReactNode {
  const { verbose, isTranscriptMode } = options

  // Collect agent and log entries
  const agentEvents: WorkflowProgressData[] = []
  const logs: string[] = []

  for (const msg of progressMessages) {
    const data = msg.data
    if (data?.type === 'workflow_agent') {
      agentEvents.push(data)
    } else if (data?.type === 'workflow_log') {
      logs.push(data.message ?? '')
    }
  }
  const agents = latestAgentEvents(agentEvents)

  if (agents.length === 0 && logs.length === 0) {
    return null
  }

  const columns = options.terminalSize?.columns ?? 80
  const maxWidth = Math.min(80, Math.max(40, columns - 10))

  if (verbose || isTranscriptMode) {
    // Verbose: show all agent details
    return createElement(
      'div',
      { style: { maxWidth } },
      ...agents.map((a) =>
        createElement(
          'div',
          { key: a.agentId, style: { paddingLeft: 8 } },
          createElement('span', { style: { color: getAgentStateColor(a.state) } }, getAgentGlyph(a.state)),
          ' ',
          a.label ?? 'agent',
          a.phaseTitle ? ` [${a.phaseTitle}]` : '',
        ),
      ),
    )
  }

  // Non-verbose: show summary bar
  const done = agents.filter((a) => a.state === 'done').length
  const running = agents.filter((a) => a.state === 'start' || a.state === 'progress').length
  const failed = agents.filter((a) => a.state === 'error').length
  const total = agents.length
  const stateLabel = failed > 0 ? 'failed' : done === total && total > 0 ? 'done' : 'running'

  return createElement(
    'div',
    null,
    createElement(
      'span',
      {
        style: {
          display: 'inline-block',
          padding: '2px 8px',
          borderRadius: 4,
          backgroundColor: getPhaseBackgroundColor(stateLabel),
          fontSize: 11,
          fontFamily: 'monospace',
        },
      },
      `${done}/${total} agents · ${running} running`,
      failed > 0 ? ` · ${failed} failed` : '',
    ),
  )
}

// ---------------------------------------------------------------------------
// Result message rendering
// ---------------------------------------------------------------------------

export function renderToolResultMessage(
  content: {
    status: 'async_launched' | 'remote_launched'
    taskId: string
    runId?: string
    summary?: string
    transcriptDir?: string
    scriptPath?: string
    sessionUrl?: string
    warning?: string
    error?: string
  },
  _progressMessages: ProgressMessage<WorkflowProgressData>[],
  options: {
    style?: 'condensed'
    theme: ThemeName
    tools: Tools
    verbose: boolean
    isTranscriptMode?: boolean
    input?: unknown
  },
): React.ReactNode {
  if (content.error) {
    return createElement(
      'div',
      null,
      createElement('span', { style: { color: 'error' } }, '✗ '),
      `Workflow script has a syntax error and was not launched: ${content.error}`,
    )
  }

  if (content.status === 'remote_launched') {
    return createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column' } },
      createElement(
        'span',
        { style: { color: 'subtle' } },
        'Running in remote session · ',
      ),
      createElement('span', { style: { color: 'suggestion' } }, content.sessionUrl),
      content.warning
        ? createElement(
            'span',
            { style: { color: 'warning' } },
            `⚠ ${content.warning}`,
          )
        : null,
    )
  }

  // Local workflow launched — show status badge
  return createElement(
    'div',
    null,
    createElement(
      'span',
      { style: { color: 'subtle' } },
      'Running in background · ',
    ),
    createElement('span', { style: { color: 'suggestion' } }, '/workflows'),
    createElement('span', { style: { color: 'subtle' } }, ' to monitor and save'),
  )
}

// ---------------------------------------------------------------------------
// Error message rendering
// ---------------------------------------------------------------------------

export function renderToolUseErrorMessage(
  result: string,
  options: {
    progressMessagesForMessage: ProgressMessage<WorkflowProgressData>[]
    tools: Tools
    verbose: boolean
    isTranscriptMode?: boolean
  },
): React.ReactNode {
  return createElement(
    'div',
    null,
    createElement('span', { style: { color: 'error' } }, '✗ '),
    `Workflow failed: ${result}`,
  )
}

// ---------------------------------------------------------------------------
// Rejected message rendering
// ---------------------------------------------------------------------------

export function renderToolUseRejectedMessage(): React.ReactNode {
  return createElement(
    'div',
    null,
    createElement('span', { style: { color: 'subtle' } }, 'Dynamic workflow cancelled'),
  )
}

// ---------------------------------------------------------------------------
// Summary for compact views
// ---------------------------------------------------------------------------

export function getToolUseSummary(
  input: Record<string, unknown> | undefined,
): string | null {
  if (!input) return null

  if (input.name) {
    return `dynamic workflow: ${input.name}`
  }

  if (input.script) {
    // Try to extract meta.name from script
    const script = String(input.script)
    const match = script.match(/name\s*:\s*["']([^"']+)["']/)
    return match ? `dynamic workflow: ${match[1]}` : null
  }

  return null
}

// ---------------------------------------------------------------------------
// Activity description for spinner
// ---------------------------------------------------------------------------

export function getActivityDescription(
  input: Record<string, unknown> | undefined,
): string | null {
  const summary = getToolUseSummary(input)
  return summary ? `Running ${summary}` : 'Running workflow'
}

// ---------------------------------------------------------------------------
// User-facing name
// ---------------------------------------------------------------------------

export function userFacingName(): string {
  return 'Workflow'
}

// ---------------------------------------------------------------------------
// Tag rendering (shows runId after tool use)
// ---------------------------------------------------------------------------

export function renderToolUseTag(
  input: Record<string, unknown>,
): React.ReactNode {
  if (input.resumeFromRunId) {
    return createElement(
      'span',
      { style: { color: 'subtle', fontSize: 10 } },
      ` resume: ${input.resumeFromRunId}`,
    )
  }
  return null
}

// ---------------------------------------------------------------------------
// Auto-classifier input
// ---------------------------------------------------------------------------

export function toAutoClassifierInput(
  input: Record<string, unknown>,
): string {
  return (input.script as string) ?? (input.name as string) ?? ''
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getAgentStateColor(state: string | undefined): string {
  switch (state) {
    case 'completed':
    case 'done':
      return '#788C5D' // olive
    case 'error':
      return '#B04A3F' // rust
    case 'start':
    case 'progress':
      return '#87867F' // g500
    default:
      return '#87867F'
  }
}

function getAgentGlyph(state: string | undefined): string {
  switch (state) {
    case 'completed':
    case 'done':
      return '✓'
    case 'error':
      return '✗'
    case 'start':
    case 'progress':
      return '…'
    default:
      return '·'
  }
}

function latestAgentEvents(events: WorkflowProgressData[]): WorkflowProgressData[] {
  const byId = new Map<string, WorkflowProgressData>()
  for (const event of events) {
    if (event.agentId) {
      byId.set(event.agentId, event)
    }
  }
  return [...byId.values()]
}

function getPhaseBackgroundColor(state: string): string {
  switch (state) {
    case 'done':
      return 'rgba(120, 140, 93, 0.12)' // olive tint
    case 'failed':
      return 'rgba(176, 74, 63, 0.10)' // rust tint
    default:
      return 'rgba(135, 134, 127, 0.08)' // g500 tint
  }
}
