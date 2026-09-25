/**
 * `launchTeleportRepoMismatchDialog` — pick a local checkout of the target repo.
 *
 * Which screen appears is decided by a *function*, not a prop: on selection the
 * dialog calls `validateRepoAtPath` and shows one of three things depending on
 * what comes back. So the variants here are mock sets rather than props, and two
 * of the four need a keypress to reach:
 *
 *   paths         both paths still valid, so the Select is the screen
 *   none          no known paths, so it can only tell you to run claude elsewhere
 *   validating    the check never settles, so the spinner stays up. Press Enter
 *                 on a path: it only exists while a check is in flight
 *   invalid-path  the check fails, so the path is dropped and an error appears.
 *                 Press Enter on a path
 */
import { mock } from 'bun:test';
import React from 'react';
import type { StoryModule } from './story-types.js';

/**
 * Realistic checkouts, because the dialog shows them through `getDisplayPath`,
 * which rewrites the home directory to `~`. Paths outside the home directory
 * would print in full and hide that behaviour.
 */
const PATHS = ['/Users/durui/Projects/claude-code', '/Users/durui/work/anthropics-claude-code'];

const TARGET_REPO = 'anthropics/claude-code';

export async function mocks(variant?: string): Promise<void> {
  const mode = variant ?? 'paths';
  // The specifier must be the one the component writes, since that is what
  // `mock.module` matches on. Importing the real module by the same alias keeps
  // the spread honest: everything except the two stubs is the real thing.
  const real = await import('src/utils/githubRepoPathMapping.js');
  mock.module('src/utils/githubRepoPathMapping.js', () => ({
    ...real,
    validateRepoAtPath:
      mode === 'validating'
        ? // A promise that never settles, so `validating` stays true and the
          // spinner is visible for as long as you care to look at it.
          () => new Promise<boolean>(() => {})
        : async () => mode !== 'invalid-path',
    // The real one edits the repo-to-path mapping on disk. Left real it would
    // write into the worker's throwaway config dir, which is harmless but makes
    // the story's second keypress mutate state for no visible reason.
    removePathFromRepo: () => {},
  }));
}

export async function element(variant?: string): Promise<React.ReactNode> {
  const { TeleportRepoMismatchDialog } = await import(
    '../../../components/TeleportRepoMismatchDialog.js'
  );

  return (
    <TeleportRepoMismatchDialog
      targetRepo={TARGET_REPO}
      initialPaths={variant === 'none' ? [] : PATHS}
      // Recorded rather than ignored: confirming that the right callback fires
      // on Enter is half of what the gallery is for.
      onSelectPath={path => console.log(`[story] onSelectPath ${path}`)}
      onCancel={() => console.log('[story] onCancel')}
    />
  );
}
