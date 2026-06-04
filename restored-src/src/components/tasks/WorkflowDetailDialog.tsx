import React, { useMemo } from 'react'
import type { DeepImmutable } from 'src/types/utils.js'
import { useElapsedTime } from '../../hooks/useElapsedTime.js'
import { Box, Text } from '../../ink.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import type {
  LocalWorkflowTaskState,
  WorkflowProgressData,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { formatNumber } from '../../utils/format.js'
import { Byline } from '../design-system/Byline.js'
import { Dialog } from '../design-system/Dialog.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { getTaskStatusColor, getTaskStatusIcon } from './taskStatusUtils.js'

type Props = {
  workflow: DeepImmutable<LocalWorkflowTaskState>
  onDone: (...args: unknown[]) => void
  onKill?: () => void
  onSkipAgent?: (agentId: string) => void
  onRetryAgent?: (agentId: string) => void
  onBack?: () => void
}

export function WorkflowDetailDialog({
  workflow,
  onDone,
  onKill,
  onSkipAgent,
  onRetryAgent,
  onBack,
}: Props): React.ReactNode {
  const elapsedTime = useElapsedTime(
    workflow.startTime,
    workflow.status === 'running',
    1000,
    workflow.totalPausedMs ?? 0,
  )

  const close = () =>
    onDone('Workflow details dismissed', { display: 'system' })
  useKeybindings({ 'confirm:yes': close }, { context: 'Confirmation' })

  const agents = useMemo(
    () => latestAgentEvents(workflow.workflowProgress),
    [workflow.workflowProgress],
  )
  const activeAgent = [...agents]
    .reverse()
    .find(a => a.state === 'start' || a.state === 'progress')

  const handleKeyDown = (event: { key: string; preventDefault: () => void }) => {
    if (event.key === ' ') {
      event.preventDefault()
      close()
    } else if (event.key === 'left' && onBack) {
      event.preventDefault()
      onBack()
    } else if (event.key === 'x' && workflow.status === 'running' && onKill) {
      event.preventDefault()
      onKill()
    } else if (
      event.key === 's' &&
      activeAgent?.agentId &&
      workflow.status === 'running' &&
      onSkipAgent
    ) {
      event.preventDefault()
      onSkipAgent(activeAgent.agentId)
    } else if (
      event.key === 'r' &&
      activeAgent?.agentId &&
      workflow.status === 'running' &&
      onRetryAgent
    ) {
      event.preventDefault()
      onRetryAgent(activeAgent.agentId)
    }
  }

  const title = (
    <Text>
      {workflow.workflowName ?? workflow.title ?? 'workflow'} ›{' '}
      {workflow.summary ?? workflow.scriptPath}
    </Text>
  )
  const statusPrefix =
    workflow.status !== 'running' ? (
      <Text color={getTaskStatusColor(workflow.status)}>
        {getTaskStatusIcon(workflow.status)}{' '}
        {workflow.status === 'completed'
          ? 'Completed'
          : workflow.status === 'failed'
            ? 'Failed'
            : 'Stopped'}{' '}
        ·{' '}
      </Text>
    ) : null
  const subtitle = (
    <Text>
      {statusPrefix}
      <Text dimColor>
        {elapsedTime}
        {workflow.totalTokens > 0
          ? ` · ${formatNumber(workflow.totalTokens)} tokens`
          : ''}
        {workflow.totalToolCalls > 0
          ? ` · ${workflow.totalToolCalls} tools`
          : ''}
      </Text>
    </Text>
  )

  const inputGuide = (exitState: { pending: boolean; keyName: string }) =>
    exitState.pending ? (
      <Text>Press {exitState.keyName} again to exit</Text>
    ) : (
      <Byline>
        {onBack ? <KeyboardShortcutHint shortcut="←" action="go back" /> : null}
        <KeyboardShortcutHint shortcut="Esc/Enter/Space" action="close" />
        {workflow.status === 'running' && onKill ? (
          <KeyboardShortcutHint shortcut="x" action="stop" />
        ) : null}
        {activeAgent?.agentId && workflow.status === 'running' && onSkipAgent ? (
          <KeyboardShortcutHint shortcut="s" action="skip agent" />
        ) : null}
        {activeAgent?.agentId && workflow.status === 'running' && onRetryAgent ? (
          <KeyboardShortcutHint shortcut="r" action="retry agent" />
        ) : null}
      </Byline>
    )

  return (
    <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Dialog
        title={title}
        subtitle={subtitle}
        onCancel={close}
        color="background"
        inputGuide={inputGuide}
      >
        <Box flexDirection="column">
          {workflow.phases && workflow.phases.length > 0 ? (
            <Box flexDirection="column">
              <Text bold dimColor>
                Phases
              </Text>
              {workflow.phases.map((phase, index) => (
                <Text key={`${phase.title}-${index}`} dimColor>
                  {index + 1}. {phase.title}
                  {phase.detail ? ` — ${phase.detail}` : ''}
                </Text>
              ))}
            </Box>
          ) : null}
          {agents.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              <Text bold dimColor>
                Agents
              </Text>
              {agents.map(agent => (
                <Text
                  key={agent.agentId}
                  color={agent.state === 'error' ? 'error' : undefined}
                  dimColor={agent.state === 'done'}
                  wrap="truncate-end"
                >
                  {agentGlyph(agent.state)} {agent.label ?? agent.agentId}
                  {agent.phaseTitle ? ` [${agent.phaseTitle}]` : ''}
                  {agent.tokens ? ` · ${formatNumber(agent.tokens)} tokens` : ''}
                  {agent.error ? ` · ${agent.error}` : ''}
                </Text>
              ))}
            </Box>
          ) : null}
          {workflow.error ? (
            <Box flexDirection="column" marginTop={1}>
              <Text bold color="error">
                Error
              </Text>
              <Text color="error" wrap="wrap">
                {workflow.error}
              </Text>
            </Box>
          ) : null}
        </Box>
      </Dialog>
    </Box>
  )
}

function latestAgentEvents(
  progress: readonly DeepImmutable<WorkflowProgressData>[],
): DeepImmutable<WorkflowProgressData>[] {
  const byId = new Map<string, DeepImmutable<WorkflowProgressData>>()
  for (const event of progress) {
    if (event.type === 'workflow_agent' && event.agentId) {
      byId.set(event.agentId, event)
    }
  }
  return [...byId.values()]
}

function agentGlyph(state: WorkflowProgressData['state']): string {
  switch (state) {
    case 'completed':
    case 'done':
      return '✓'
    case 'error':
      return '✗'
    case 'progress':
      return '›'
    case 'start':
      return '…'
    default:
      return '·'
  }
}
