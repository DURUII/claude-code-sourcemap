/**
 * `ResumeTask` — the session picker that `launchTeleportResumeWrapper` paints,
 * via `TeleportResumeWrapper`. Mocks follow run-teleport.tsx: three modules,
 * spread over the real ones so nothing but the three functions changes.
 *
 * The component mounts `TeleportError` first and loads nothing until that
 * resolves, so the preconditions are mocked clean here. That gate is why
 * `teleport-error` is a separate story: if this one ever shows a blank screen,
 * the gate is where to look.
 *
 * Variants split into what the sessions API returns and what repo detection
 * finds, because the two interact. The list is filtered to the detected repo, so
 * an empty screen can mean either "the API returned nothing" or "it returned
 * plenty, none of it for this repo", and those are worth telling apart:
 *
 *   sessions        three sessions, all in the detected repo
 *   empty           the API returns no sessions at all
 *   other-repo      the API returns sessions, none in the detected repo, so the
 *                   filter empties the list and the header still names the repo
 *   no-repo         detection finds nothing, so there is no filter and every
 *                   session shows
 *   error-network   the API throws "fetch failed"
 *   error-auth      the API throws "not authenticated"
 *   error-api       the API throws "rate limit"
 *   error-other     the API throws something the component cannot classify
 *
 * The four error variants are one per branch of the component's own
 * `determineErrorType`, and each renders different guidance text. `Ctrl+R`
 * retries and `Enter` leaves the flow, in every one of them.
 */
import { mock } from 'bun:test';
import React from 'react';
import type { StoryModule } from './story-types.js';

const REPO = 'anthropics/claude-code';

/** Shaped to match what the sessions API returns, as run-teleport.tsx does. */
const SESSIONS = [
  {
    id: 'sess_01',
    title: 'Fix flaky TokenBucket test',
    description: 'test flake',
    status: 'idle',
    repo: { name: 'claude-code', owner: { login: 'anthropics' } },
    turns: [],
    created_at: new Date(Date.now() - 86400e3).toISOString(),
    updated_at: new Date(Date.now() - 60e3).toISOString(),
  },
  {
    id: 'sess_02',
    title: 'Add teleport retry backoff',
    description: 'retry',
    status: 'working',
    repo: { name: 'claude-code', owner: { login: 'anthropics' } },
    turns: [],
    created_at: new Date(Date.now() - 3 * 86400e3).toISOString(),
    updated_at: new Date(Date.now() - 3600e3).toISOString(),
  },
  {
    id: 'sess_03',
    title: 'Investigate session GC leak',
    description: 'gc',
    status: 'completed',
    repo: { name: 'claude-code', owner: { login: 'anthropics' } },
    turns: [],
    created_at: new Date(Date.now() - 7 * 86400e3).toISOString(),
    updated_at: new Date(Date.now() - 26 * 3600e3).toISOString(),
  },
];

/** Same three fields, a repo that will not match the detected one. */
const ELSEWHERE = SESSIONS.map(s => ({
  ...s,
  repo: { name: 'other-project', owner: { login: 'someone-else' } },
}));

/** Chosen so each message lands on a different `determineErrorType` branch. */
const ERRORS: Record<string, string> = {
  'error-network': 'fetch failed: network unreachable',
  'error-auth': 'not authenticated, run /login',
  'error-api': 'rate limit exceeded (429)',
  'error-other': 'the server said something unexpected',
};

export async function mocks(variant?: string): Promise<void> {
  const mode = variant ?? 'sessions';

  const preconditions = await import('src/utils/background/remote/preconditions.js');
  mock.module('src/utils/background/remote/preconditions.js', () => ({
    ...preconditions,
    // Both must pass or ResumeTask renders TeleportError instead of the list.
    checkNeedsClaudeAiLogin: async () => false,
    checkIsGitClean: async () => true,
  }));

  const repo = await import('src/utils/detectRepository.js');
  mock.module('src/utils/detectRepository.js', () => ({
    ...repo,
    detectCurrentRepository: async () => (mode === 'no-repo' ? null : REPO),
  }));

  const api = await import('src/utils/teleport/api.js');
  const message = ERRORS[mode];
  mock.module('src/utils/teleport/api.js', () => ({
    ...api,
    fetchCodeSessionsFromSessionsAPI: message
      ? async () => {
          throw new Error(message);
        }
      : async () => {
          switch (mode) {
            case 'empty':
              return [];
            case 'other-repo':
              return ELSEWHERE;
            default:
              return SESSIONS;
          }
        },
  }));
}

export async function element(): Promise<React.ReactNode> {
  const { ResumeTask } = await import('../../../components/ResumeTask.js');

  return (
    <ResumeTask
      onSelect={session => console.log(`[story] onSelect ${session.id}`)}
      onCancel={() => console.log('[story] onCancel')}
    />
  );
}
