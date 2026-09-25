/**
 * `TeleportStash` — the prompt shown when teleport needs to switch branches but
 * the worktree is dirty. It is mounted by `TeleportError`, not by a launcher.
 *
 * The component reads git status on mount and takes only two callbacks as props,
 * so nothing about which screen appears can be set from outside. Every variant
 * here is therefore a mock, and the variants are the reason `mocks()` receives
 * the story's variant at all:
 *
 *   loading       `getFileStatus` never settles, so the first thing you see
 *                 stays up: "Checking git status…"
 *   files         four changed files, listed one per line
 *   many          twelve changed files, collapsed to a count. The threshold is
 *                 hardcoded at more than eight
 *   clean         no changes at all. Reachable in the app only if git goes clean
 *                 between the precondition check and this read
 *   error-files   `getFileStatus` throws, which is what a non-git directory does
 *   stashing      press Enter on "Stash changes and continue" while the stash
 *                 never completes
 *   error-stash   the stash reports failure
 */
import { mock } from 'bun:test';
import React from 'react';
import type { StoryModule } from './story-types.js';

const FILES = {
  tracked: ['src/components/TeleportStash.tsx', 'src/tests/storybook/worker.tsx', 'README.md'],
  untracked: ['src/tests/storybook/stories/teleport-stash.tsx'],
};

/** Over the component's `> 8` threshold, so it prints a count instead of lines. */
const MANY = {
  tracked: [
    'src/components/ResumeTask.tsx',
    'src/components/TeleportError.tsx',
    'src/components/Spinner.tsx',
    'src/components/CustomSelect/index.tsx',
    'src/components/design-system/Dialog.tsx',
    'src/ink/reconciler.ts',
    'src/ink/log-update.ts',
    'src/ink/screen.ts',
    'src/ink/parse-keypress.ts',
    'src/utils/git.ts',
  ],
  untracked: ['src/tests/storybook/server.ts', 'src/tests/storybook/client.js'],
};

export async function mocks(variant?: string): Promise<void> {
  const mode = variant ?? 'files';
  const real = await import('src/utils/git.js');
  mock.module('src/utils/git.js', () => ({
    ...real,
    getFileStatus:
      mode === 'loading'
        ? () => new Promise<never>(() => {})
        : mode === 'error-files'
          ? async () => {
              throw new Error('not a git repository');
            }
          : async () => (mode === 'many' ? MANY : mode === 'clean' ? { tracked: [], untracked: [] } : FILES),
    stashToCleanState:
      mode === 'stashing'
        ? () => new Promise<never>(() => {})
        : async () => mode !== 'error-stash',
  }));
}

export async function element(): Promise<React.ReactNode> {
  const { TeleportStash } = await import('../../../components/TeleportStash.js');

  return (
    <TeleportStash
      onStashAndContinue={() => console.log('[story] onStashAndContinue')}
      onCancel={() => console.log('[story] onCancel')}
    />
  );
}
