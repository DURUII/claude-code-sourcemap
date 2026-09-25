/**
 * `launchTeleportResumeWrapper` — the real launcher target, with the session
 * list mocks from resume-task.tsx plus the one seam unique to the wrapper.
 *
 * `TeleportResumeWrapper` owns three screens and only one of them is the session
 * list; the other two happen *after* you pick a session, which is where the
 * interesting part of this flow lives. The hook it calls, `useTeleportResume`,
 * does its work in a single call to `teleportResumeCodeSession`, so mocking that
 * one function is enough to reach them:
 *
 *   list      pick a session; this is the screen the launcher opens on
 *   resuming  pick a session and the resume never completes, so you keep looking
 *             at "Resuming session…" over the title you chose
 *   error     pick a session and the resume throws. Note the difference from
 *             `list`: the error screen replaces the list entirely, and Esc
 *             cancels from there rather than going back to it
 *
 * Worth comparing against resume-task: that story mounts ResumeTask directly, so
 * it cannot show the resuming or error screens at all. This is the one where the
 * wrapper's own behaviour is visible.
 */
import { mock } from 'bun:test';
import React from 'react';
import type { StoryModule } from './story-types.js';

const REPO = 'anthropics/claude-code';

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
];

export async function mocks(variant?: string): Promise<void> {
  const mode = variant ?? 'list';

  const preconditions = await import('src/utils/background/remote/preconditions.js');
  mock.module('src/utils/background/remote/preconditions.js', () => ({
    ...preconditions,
    checkNeedsClaudeAiLogin: async () => false,
    checkIsGitClean: async () => true,
  }));

  const repo = await import('src/utils/detectRepository.js');
  mock.module('src/utils/detectRepository.js', () => ({
    ...repo,
    detectCurrentRepository: async () => REPO,
  }));

  const api = await import('src/utils/teleport/api.js');
  mock.module('src/utils/teleport/api.js', () => ({
    ...api,
    fetchCodeSessionsFromSessionsAPI: async () => SESSIONS,
  }));

  const teleport = await import('src/utils/teleport.js');
  mock.module('src/utils/teleport.js', () => ({
    ...teleport,
    teleportResumeCodeSession:
      mode === 'resuming'
        ? () => new Promise<never>(() => {})
        : mode === 'error'
          ? async () => {
              throw new Error('the remote session could not be reached');
            }
          : // Unreached in the `list` variant, since nothing is selected. Left as
            // a rejection rather than a silent null so that pressing Enter there
            // produces the error screen instead of doing nothing.
            async () => {
              throw new Error('resume was not expected in the list variant');
            },
  }));
}

export async function element(): Promise<React.ReactNode> {
  const { TeleportResumeWrapper } = await import('../../../components/TeleportResumeWrapper.js');

  return (
    <TeleportResumeWrapper
      source="cliArg"
      onComplete={result => console.log(`[story] onComplete ${JSON.stringify(result).slice(0, 80)}`)}
      onCancel={() => console.log('[story] onCancel')}
    />
  );
}
