/**
 * `TeleportError` — the precondition gate that `ResumeTask` mounts before it
 * loads a single session.
 *
 * Worth a story of its own for two reasons. It is the first thing the teleport
 * flow paints, so "the session list looked empty" usually means this component
 * is still unresolved rather than that the list is empty. And its two screens
 * are reached only through preconditions, so nothing but a mock can show them:
 *
 *   login   a Claude account is required, so the login dialog appears
 *   stash   the worktree is dirty, so `TeleportStash` is what you get instead
 *           (the same component as stories/teleport-stash.tsx, arrived at the
 *           way the app arrives at it)
 *
 * When neither precondition fails it returns null and calls `onComplete`, which
 * is what lets ResumeTask proceed; a blank screen here is success, not failure.
 *
 * Two honest warnings about what the buttons do. Escape calls the component's
 * own `onCancel`, which is `gracefulShutdownSync(0)` — it really does terminate
 * the process, so through the gallery the worker exits and the Restart button
 * brings it back. And in the `login` variant the first option starts a real
 * console OAuth flow, which will try to open a browser; the second exits.
 */
import { mock } from 'bun:test';
import React from 'react';
import type { StoryModule } from './story-types.js';

export async function mocks(variant?: string): Promise<void> {
  const mode = variant ?? 'login';
  const real = await import('src/utils/background/remote/preconditions.js');
  mock.module('src/utils/background/remote/preconditions.js', () => ({
    ...real,
    checkNeedsClaudeAiLogin: async () => mode === 'login',
    checkIsGitClean: async () => mode !== 'stash',
  }));

  // The `stash` variant renders TeleportStash, which reads git status on mount.
  // Without this it would shell out to the real `git` in the server's cwd and
  // show whatever the restoration repo's working tree happens to be.
  const git = await import('src/utils/git.js');
  mock.module('src/utils/git.js', () => ({
    ...git,
    getFileStatus: async () => ({
      tracked: ['src/components/TeleportError.tsx'],
      untracked: ['src/tests/storybook/stories/teleport-error.tsx'],
    }),
    stashToCleanState: async () => true,
  }));
}

export async function element(): Promise<React.ReactNode> {
  const { TeleportError } = await import('../../../components/TeleportError.js');

  return (
    <TeleportError
      onComplete={() => console.log('[story] onComplete (preconditions passed)')}
    />
  );
}
