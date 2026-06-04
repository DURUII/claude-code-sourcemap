/**
 *TODO:把流式 tool_use 块物化后并行/串行执行，回填
  tool_result；定义 Tool.ts:803 的 Tool 接口（name / description /
  input_schema / call() / prompt()），Bash/Read/Edit/Agent 等所有工具都实现它
 */
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { findToolByName, type ToolUseContext } from '../../Tool.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { all } from '../../utils/generators.js'
import { type MessageUpdateLazy, runToolUse } from './toolExecution.js'

// 并发上限
function getMaxToolUseConcurrency(): number {
  return (
    parseInt(process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY || '', 10) || 10
  )
}

// for await (update) in query.ts -> yield 流给 SDK
export type MessageUpdate = {
  message?: Message
  newContext: ToolUseContext
}

export async function* runTools(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdate, void> {
  let currentContext = toolUseContext
  for (const { isConcurrencySafe, blocks } of partitionToolCalls(
    toolUseMessages,
    currentContext,
  )) {
    if (isConcurrencySafe) {
      const queuedContextModifiers: Record<
        string,
        ((context: ToolUseContext) => ToolUseContext)[]
      > = {}
      // Run read-only batch concurrently
      for await (const update of runToolsConcurrently(
        blocks,
        assistantMessages,
        canUseTool,
        currentContext,
      )) {
        if (update.contextModifier) {
          const { toolUseID, modifyContext } = update.contextModifier
          if (!queuedContextModifiers[toolUseID]) {
            queuedContextModifiers[toolUseID] = []
          }
          queuedContextModifiers[toolUseID].push(modifyContext)
        }
        yield {
          message: update.message,
          newContext: currentContext,
        }
      }
      for (const block of blocks) {
        const modifiers = queuedContextModifiers[block.id]
        if (!modifiers) {
          continue
        }
        for (const modifier of modifiers) {
          currentContext = modifier(currentContext)
        }
      }
      yield { newContext: currentContext }
    } else {
      // Run non-read-only batch serially
      for await (const update of runToolsSerially(
        blocks,
        assistantMessages,
        canUseTool,
        currentContext,
      )) {
        if (update.newContext) {
          currentContext = update.newContext
        }
        yield {
          message: update.message,
          newContext: currentContext,
        }
      }
    }
  }
}

// partitionToolCalls 切分出来的调度单位
type Batch = { isConcurrencySafe: boolean; blocks: ToolUseBlock[] }

/**
 * Partition tool calls into batches where each batch is either:
 * 1. A single non-read-only tool, or
 * 2. Multiple consecutive read-only tools
 */
function partitionToolCalls(
  toolUseMessages: ToolUseBlock[],
  toolUseContext: ToolUseContext,
): Batch[] {
  return toolUseMessages.reduce((acc: Batch[], toolUse) => {
    const tool = findToolByName(toolUseContext.options.tools, toolUse.name)
    const parsedInput = tool?.inputSchema.safeParse(toolUse.input)
    const isConcurrencySafe = parsedInput?.success
      ? (() => {
          try {
            return Boolean(tool?.isConcurrencySafe(parsedInput.data))
          } catch {
            // If isConcurrencySafe throws (e.g., due to shell-quote parse failure),
            // treat as not concurrency-safe to be conservative
            return false
          }
        })()
      : false
    if (isConcurrencySafe && acc[acc.length - 1]?.isConcurrencySafe) {
      acc[acc.length - 1]!.blocks.push(toolUse)
    } else {
      acc.push({ isConcurrencySafe, blocks: [toolUse] })
    }
    return acc
  }, [])
}

async function* runToolsSerially(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdate, void> {
  let currentContext = toolUseContext

  for (const toolUse of toolUseMessages) {
    toolUseContext.setInProgressToolUseIDs(prev =>
      new Set(prev).add(toolUse.id),
    )
    for await (const update of runToolUse(
      toolUse,
      assistantMessages.find(_ =>
        _.message.content.some(
          _ => _.type === 'tool_use' && _.id === toolUse.id,
        ),
      )!,
      canUseTool,
      currentContext,
    )) {
      if (update.contextModifier) {
        currentContext = update.contextModifier.modifyContext(currentContext)
      }
      yield {
        message: update.message,
        newContext: currentContext,
      }
    }
    markToolUseAsComplete(toolUseContext, toolUse.id)
  }
}

async function* runToolsConcurrently(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdateLazy, void> {
  yield* all(
    toolUseMessages.map(async function* (toolUse) {
      toolUseContext.setInProgressToolUseIDs(prev =>
        new Set(prev).add(toolUse.id),
      )
      yield* runToolUse(
        toolUse,
        assistantMessages.find(_ =>
          _.message.content.some(
            _ => _.type === 'tool_use' && _.id === toolUse.id,
          ),
        )!,
        canUseTool,
        toolUseContext,
      )
      markToolUseAsComplete(toolUseContext, toolUse.id)
    }),
    getMaxToolUseConcurrency(),
  )
}

// 结束/打断/中断；从 ctx 上的一个 Set<string> 删掉这个 toolUseID，tool_use 和 tool_result 配对； inProgressToolUseIDs 在 abort 后需要重置
function markToolUseAsComplete(
  toolUseContext: ToolUseContext,
  toolUseID: string,
) {
  toolUseContext.setInProgressToolUseIDs(prev => {
    const next = new Set(prev)
    next.delete(toolUseID)
    return next
  })
}

// RMW 冲突模式，保证「要么一起成功要么一起放弃」的原子性、隔离性、可恢复，方法：1. 串行化队列，阻塞 2. 函数式变换， 3. 乐观锁： read-with-version/mtime/etag，不匹配就 retry/重新读再改再写/merge/LWW
