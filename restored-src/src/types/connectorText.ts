/**
 * Restoration placeholder.
 *
 * The restored source references connector text content blocks, but this small
 * type/helper module was not present in the recovered tree. Keep it limited to
 * the runtime type guard required by message and API logging paths.
 */

export type ConnectorTextBlock = {
  type: 'connector_text'
  text?: string
}

export type ConnectorTextDelta = {
  type: 'connector_text_delta'
  text?: string
}

export function isConnectorTextBlock(
  value: unknown,
): value is ConnectorTextBlock {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    (value as { type?: unknown }).type === 'connector_text'
  )
}
