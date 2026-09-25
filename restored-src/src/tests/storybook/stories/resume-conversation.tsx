/**
 * `launchResumeChooser` — the conversation picker, which is a different screen
 * from the teleport session picker despite the similar name. This one reads
 * *local* session logs; teleport asks a server.
 *
 * Four mocks, all in `sessionStorage`, plus two stubs for reads that
 * `LogSelector` fires and forgets. Two details in this component are traps, and
 * both are why the variants exist:
 *
 *   The loader's rejection path is indistinguishable from success with no logs.
 *   It logs the error and sets `logs` to the empty array it started with, so
 *   "the read failed" and "you have no conversations" are the same screen. There
 *   is no error variant to write, because there is no error screen.
 *
 *   A log whose `sessionId` is falsy is dropped by the grouping pass, so it
 *   counts towards "do I have any conversations" and then renders as nothing.
 *   Every fixture here carries one.
 *
 * `nextIndex` is set to `allStatLogs.length` in every variant. The component
 * re-enters its loader whenever the focused row comes near the end of the list,
 * and a mock that returns `nextIndex: 0` alongside a non-empty `allStatLogs`
 * recurses until the stack gives out.
 *
 * Variants:
 *
 *   list        five conversations, including a pair sharing a session id so the
 *               group affordance is visible
 *   one         the smallest list that is not the empty state
 *   empty       no conversations, which is also what a failed read looks like
 *   sidechains  all logs are sidechains, filtered out before the count is taken,
 *               so an abundant result still lands on the empty message
 *   loading     the loader never settles, holding the first paint open
 */
import { mock } from 'bun:test';
import React from 'react';
import type { StoryModule } from './story-types.js';

const PROJECT = '/Users/durui/Projects/claude-code';

/**
 * One session log, shaped to what the render path reads. The real `LogOption`
 * carries about twenty-five fields; the ones omitted here are read only on the
 * paths this story does not drive (selecting a row, renaming, PR filtering).
 *
 * `customTitle` is set because the title precedence is
 * `agentName -> customTitle -> summary -> firstPrompt`, so a fixture without it
 * shows the first prompt instead and makes the list look less like the real one.
 */
function conversation(options: {
  sessionId: string;
  title?: string;
  prompt: string;
  messageCount: number;
  fileSize: number;
  /** Hours before the fixed reference time; higher is older. */
  hoursAgo: number;
  gitBranch?: string;
  tag?: string;
  isSidechain?: boolean;
  prNumber?: number;
}): never {
  // Relative to the real clock, not a fixed date. A pinned reference reads
  // correctly only on the day it was written and then drifts: pinned to a
  // mid-afternoon timestamp, every row older than a few hours turns into "in 3
  // hours" and the screen starts describing sessions from the future. Since the
  // column is relative time, it cannot be byte-reproducible anyway, so this
  // trades the illusion of determinism for output that stays sensible.
  const modified = new Date(Date.now() - options.hoursAgo * 3600e3);
  const message = {
    type: 'user',
    uuid: '11111111-1111-4111-8111-111111111111',
    message: { role: 'user', content: options.prompt },
    cwd: PROJECT,
    userType: 'external',
    sessionId: options.sessionId,
    timestamp: modified.toISOString(),
    version: '2.1.88',
  };
  return {
    date: modified.toISOString(),
    // Must be a real array: the search index reads `messages.length` for every
    // log on every render, before any interaction.
    messages: [message],
    value: 0,
    created: modified,
    modified,
    firstPrompt: options.prompt,
    messageCount: options.messageCount,
    fileSize: options.fileSize,
    isSidechain: options.isSidechain ?? false,
    isLite: false,
    sessionId: options.sessionId,
    fullPath: `/Users/durui/.claude/projects/-Users-durui-Projects-claude-code/${options.sessionId}.jsonl`,
    gitBranch: options.gitBranch,
    projectPath: PROJECT,
    customTitle: options.title,
    tag: options.tag,
    prNumber: options.prNumber,
  } as never;
}

const LOGS = [
  conversation({
    sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: 'Health endpoint',
    prompt: 'Add a /health endpoint that reports the git sha',
    messageCount: 42,
    fileSize: 18_432,
    hoursAgo: 2,
    gitBranch: 'feat/health-endpoint',
    tag: 'backend',
    prNumber: 128,
  }),
  // Shares a session id with the row below, which is what produces the
  // "(+1 other session)" group node.
  conversation({
    sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    title: 'Retry backoff',
    prompt: 'Make the teleport retry back off exponentially',
    messageCount: 17,
    fileSize: 7_904,
    hoursAgo: 5,
    gitBranch: 'fix/retry-backoff',
  }),
  conversation({
    sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    title: 'Retry backoff, second pass',
    prompt: 'The backoff needs a jitter component',
    messageCount: 9,
    fileSize: 4_112,
    hoursAgo: 3,
    gitBranch: 'fix/retry-backoff',
  }),
  conversation({
    sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    title: 'Token bucket flake',
    prompt: 'Fix the flaky TokenBucket test',
    messageCount: 88,
    fileSize: 40_960,
    hoursAgo: 26,
    gitBranch: 'test/token-bucket-flake',
    tag: 'tests',
  }),
  conversation({
    sessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    prompt: 'Why does the session GC never collect anything',
    messageCount: 6,
    fileSize: 2_048,
    hoursAgo: 72,
    gitBranch: 'investigate/session-gc',
  }),
];

/** Two session ids over four rows, so both a leaf and a group are present. */
const LIST = [LOGS[0]!, LOGS[1]!, LOGS[2]!, LOGS[3]!];
const ONE = [LOGS[3]!];
const SIDECHAINS = [
  conversation({
    sessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    prompt: 'subagent: search the repo for callers',
    messageCount: 3,
    fileSize: 1_024,
    hoursAgo: 1,
    isSidechain: true,
  }),
];

export async function mocks(variant?: string): Promise<void> {
  const mode = variant ?? 'list';

  const storage = await import('src/utils/sessionStorage.js');
  const result = { logs: mode === 'sidechains' ? SIDECHAINS : mode === 'one' ? ONE : mode === 'empty' ? [] : LIST };
  mock.module('src/utils/sessionStorage.js', () => ({
    ...storage,
    loadSameRepoMessageLogsProgressive:
      mode === 'loading'
        ? () => new Promise<never>(() => {})
        : async () => ({
            ...result,
            allStatLogs: result.logs,
            // Equal to the length on purpose: it is what stops the component's
            // own re-entry from recursing.
            nextIndex: result.logs.length,
          }),
    // Never reached, because `nextIndex` above is already at the end. Stubbed so
    // that a future change cannot quietly pull real JSONL off disk.
    enrichLogs: async (logs: unknown[]) => ({ logs, nextIndex: (logs as never[]).length }),
  }));

  const log = await import('src/utils/log.js');
  mock.module('src/utils/log.js', () => ({
    ...log,
    logError: (error: unknown) => console.log(`[story] logError ${String(error)}`),
  }));

  // Both of these are fired and forgotten by LogSelector with no catch, so an
  // unstubbed call is an unhandled rejection in the browser console rather than
  // a visible failure. They only feed hint text, so a fixed answer is honest.
  const git = await import('src/utils/git.js');
  mock.module('src/utils/git.js', () => ({
    ...git,
    getBranch: async () => 'feat/health-endpoint',
  }));

  const worktrees = await import('src/utils/getWorktreePaths.js');
  mock.module('src/utils/getWorktreePaths.js', () => ({
    ...worktrees,
    getWorktreePaths: async () => [],
  }));
}

/**
 * One array instance for every render. An inline array would be a new identity
 * each time, and the loader effect keys off it, so the component would reload
 * its logs on every repaint.
 */
const WORKTREE_PATHS: string[] = [];

export async function element(): Promise<React.ReactNode> {
  const { ResumeConversation } = await import('../../../screens/ResumeConversation.js');

  return (
    <ResumeConversation
      commands={[]}
      worktreePaths={WORKTREE_PATHS}
      initialTools={[]}
      debug={false}
      // The real call site passes a resolved thinking config; nothing this story
      // renders reads it, and `run-resume.tsx` sets it the same way.
      thinkingConfig={{} as never}
    />
  );
}
