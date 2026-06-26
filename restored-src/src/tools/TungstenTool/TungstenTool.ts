/**
 * Restoration stub.
 *
 * The original Tungsten tmux tool implementation was not recovered with this
 * source tree. It is imported statically by the tool registry, so this disabled
 * Tool-shaped stub keeps normal CLI startup readable while making the missing
 * feature explicit if selected.
 */

import { z } from 'zod/v4'

const inputSchema = z.object({}).passthrough()

const unavailableMessage =
  'TungstenTool is unavailable in restored-src: original implementation was not recovered.'

export const TungstenTool = {
  name: 'tungsten',
  aliases: [],
  maxResultSizeChars: 0,
  inputSchema,
  async description() {
    return unavailableMessage
  },
  async prompt() {
    return unavailableMessage
  },
  async call() {
    return {
      data: {
        success: false,
        error: unavailableMessage,
      },
    }
  },
  isConcurrencySafe() {
    return true
  },
  isEnabled() {
    return false
  },
  isReadOnly() {
    return true
  },
  async checkPermissions() {
    return {
      behavior: 'deny' as const,
      message: unavailableMessage,
    }
  },
}

export function clearSessionsWithTungstenUsage(): void {}

export function resetInitializationState(): void {}
