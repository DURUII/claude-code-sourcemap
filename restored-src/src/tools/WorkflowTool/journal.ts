import { mkdir, readFile, appendFile } from 'fs/promises'
import { dirname, join } from 'path'
import { getProjectRoot } from '../../bootstrap/state.js'
import { isENOENT } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'

/**
 * Journal event types written to the JSONL file.
 * Used by the execution engine to persist agent lifecycle events
 * for resume-after-edit cache matching.
 */
type JournalStartedEvent = {
  type: 'started'
  /** Cache key: sha256("v2" + prompt + "\0" + normalizedOpts) */
  key: string
  agentId: string
  label: string
  prompt: string
  phaseTitle?: string
  phaseIndex?: number
  timestamp: number
}

type JournalResultEvent = {
  type: 'result'
  /** Same key as the matching started event */
  key: string
  agentId: string
  label: string
  /** Text or structured output returned by the agent */
  result: unknown
  error?: string
  tokens?: number
  toolCalls?: number
  durationMs?: number
  timestamp: number
}

type JournalEvent = JournalStartedEvent | JournalResultEvent

/**
 * Deduplicated view of a loaded journal.
 * - results: latest result per cache key (Map)
 * - started: all started events per cache key (Map<string, JournalStartedEvent[]>)
 *
 * This supports the resume semantics where:
 * - If a cache key has a result → skip that agent() call, return cached result
 * - If a cache key has started but no result → the agent was interrupted, re-run
 * - If a cache key has neither → first time running, execute normally
 */
export type JournalView = {
  results: Map<string, JournalResultEvent>
  started: Map<string, JournalStartedEvent[]>
}

/**
 * Append-only JSONL journal for workflow agent() calls.
 *
 * File layout:
 *   .claude/projects/{hash}/subagents/workflows/{runId}/journal.jsonl
 *
 * Each line is one JournalEvent (JSON). The journal is read once at resume
 * time, then appended to during execution. Unparseable lines are silently
 * skipped (forward-compat with future event shapes).
 */
export class LocalFileJournal {
  readonly path: string
  private dirReady = false

  constructor(runId: string) {
    const projectDir = getProjectRoot()
    // Path matches v159: {sessionDir}/subagents/workflows/{runId}/journal.jsonl
    this.path = join(
      projectDir,
      '.claude',
      'subagents',
      'workflows',
      runId,
      'journal.jsonl',
    )
  }

  /**
   * Read and parse the journal file.
   * Returns empty JournalView if file doesn't exist.
   */
  async load(): Promise<JournalView> {
    let content: string
    try {
      content = await readFile(this.path, 'utf8')
    } catch (e: unknown) {
      if (isENOENT(e)) return deduplicateEvents([])
      throw e
    }

    const events: JournalEvent[] = []
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line) as JournalEvent)
      } catch (parseError: unknown) {
        logError(
          `LocalFileJournal: skipping unparseable line in ${this.path}: ${parseError}`,
        )
      }
    }
    return deduplicateEvents(events)
  }

  /**
   * Append a single event to the journal file.
   * Ensures the parent directory exists on first write.
   */
  async append(event: JournalEvent): Promise<void> {
    if (!this.dirReady) {
      await mkdir(dirname(this.path), { recursive: true })
      this.dirReady = true
    }
    await appendFile(this.path, `${JSON.stringify(event)}\n`, 'utf8')
  }
}

/**
 * Deduplicate a flat list of journal events into a JournalView.
 *
 * Strategy:
 * - For 'result' events: latest wins (Map.set overwrites)
 * - For 'started' events: accumulate in array (push)
 *
 * This handles the case where an agent() call was started but interrupted
 * (e.g. user edit + resume) — the started event exists but no result,
 * so the agent gets re-run.
 */
function deduplicateEvents(events: JournalEvent[]): JournalView {
  const results = new Map<string, JournalResultEvent>()
  const started = new Map<string, JournalStartedEvent[]>()

  for (const event of events) {
    if (event.type === 'result') {
      if (!event.error) {
        results.set(event.key, event)
      }
    } else if (event.type === 'started') {
      const existing = started.get(event.key)
      if (existing) {
        existing.push(event)
      } else {
        started.set(event.key, [event])
      }
    }
  }

  return { results, started }
}
