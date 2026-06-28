import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { QuerySource } from 'src/constants/querySource.js'

type ApiRequestObserverEvent = {
  type: 'api_request'
  source: 'restored-src'
  timestamp: string
  correlationId: string
  handleId: string
  querySource?: QuerySource
  attempt?: number
  clientRequestId?: string
  payload: BetaMessageStreamParams
}

const OBSERVER_TIMEOUT_MS = 250

export function observeApiRequest(input: {
  params: BetaMessageStreamParams
  correlationId: string
  querySource?: QuerySource
  attempt?: number
  clientRequestId?: string
}): void {
  const endpoint = process.env.CLAUDE_CODE_HTTP_VISUALIZER_ENDPOINT
  if (!endpoint || endpoint === '0' || endpoint.toLowerCase() === 'false') {
    return
  }

  const event: ApiRequestObserverEvent = {
    type: 'api_request',
    source: 'restored-src',
    timestamp: new Date().toISOString(),
    correlationId: input.correlationId,
    handleId: input.correlationId,
    querySource: input.querySource,
    attempt: input.attempt,
    clientRequestId: input.clientRequestId,
    payload: input.params,
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), OBSERVER_TIMEOUT_MS)
  timeout.unref?.()

  void fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
    signal: controller.signal,
  })
    .catch(() => undefined)
    .finally(() => clearTimeout(timeout))
}
