/**
 * Does `resize()` keep the story's state, or does it remount?
 *
 * This is the regression test for `mountStory`'s `resize()`
 * (harness.tsx:320-332), which harness.tsx:188 cites as "where focus survives
 * the resize". Remounting would not be a neutral cost: it throws away exactly
 * the state the gallery exists to let you drive, meaning `Select` focus, typed
 * query, and scroll offset, and it re-runs every mount-time effect. Resizing a
 * browser window would silently reset the story.
 *
 * Two earlier versions of this file were wrong in opposite directions, and both
 * mistakes are worth keeping in mind because the same file is cited from
 * harness.tsx:
 *
 *   - it claimed a resize *had* to remount, on the grounds that `handleResize`
 *     is private. That is true only of TypeScript: the privacy is a class-field
 *     declaration (src/ink/ink.tsx:309) erased at runtime, so `resize()` can and
 *     does call the method.
 *   - it then reached into Ink's instance registry and called `handleResize`
 *     directly instead of going through `resize()`. That made the resize work,
 *     and made a regression in `resize()` itself invisible, because `resize()`
 *     was never called.
 *
 * It calls `resize()` now. The test is therefore not "does the width change" but
 * "does focus survive": focus is moved to index 1 with Down, the story is
 * resized, and Enter is pressed. `onContinue` means focus survived; `onExit`
 * means it was reset to index 0 and the resize destroyed the state.
 *
 * Run: FORCE_COLOR=3 bun run src/tests/storybook/probe-resize.tsx
 */
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Set before the first call that reads it, and before `enableConfigs()` below.
// The read is lazy and memoized with this variable as the cache key
// (src/utils/envUtils.ts:7-14), so an earlier version's run line that exported
// CLAUDE_CONFIG_DIR from the shell was doing nothing here: a bare `bun run`
// would have read the real ~/.claude.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'sb-config-'));

import React from 'react';
import { enableConfigs } from '../../utils/config.js';
import { InvalidSettingsDialog } from '../../components/InvalidSettingsDialog.js';
import { mountStory, type MountedStory } from './harness.js';
import { payloadToText, serializeFrame } from './frame-payload.js';

enableConfigs();

const ESC = '\x1b';
const DOWN = ESC + '[B';
const RESIZED_TO = { columns: 120, rows: 30 };

const failures: string[] = [];

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)}` +
      (ok ? '' : ` (expected ${JSON.stringify(expected)})`),
  );
  if (!ok) {
    failures.push(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}

const fired: string[] = [];
let paints = 0;

const mount = (): Promise<MountedStory> =>
  mountStory(
    <InvalidSettingsDialog
      settingsErrors={
        [{ file: 'settings.json', path: 'model', message: 'must be a string' }] as never
      }
      onContinue={() => fired.push('continue')}
      onExit={() => fired.push('exit')}
    />,
    { columns: 80, rows: 20, onFrame: () => paints++ },
  );

const story = await mount();
await new Promise(r => setTimeout(r, 250));

const pool = story.stylePool();
const before = serializeFrame(story.latest()!, pool);
console.log(`mounted at ${story.columns}x${story.rows}`);
console.log(`frame is ${before.columns}x${before.rows} wide (rows = content height, not the requested 20)`);

// Move focus to index 1 (Continue) so there is state worth preserving.
story.push(DOWN);
await new Promise(r => setTimeout(r, 200));
const beforeResize = paints;

// The call under test. Anything it does after this point is what determines
// whether state survived; the assertions below must not touch Ink themselves, or
// they would be testing this file's own copy of the logic rather than `resize()`.
story.resize(RESIZED_TO.columns, RESIZED_TO.rows);
await new Promise(r => setTimeout(r, 200));

const after = serializeFrame(story.latest()!, pool);
console.log(`after resize: ${after.columns}x${after.rows}; ${paints - beforeResize} new paint(s)`);
// The first rows, not "the top border": row 0 of the grid is empty on this
// dialog, so a label promising a border would print a blank line and read as a
// failure. The widest row is the one that shows the new width.
const rowsAfter = payloadToText(after).split('\n');
const widest = rowsAfter.reduce((a, b) => (b.length > a.length ? b : a), '');
console.log(`widest row is ${widest.length} columns:`);
console.log(`  ${widest.slice(0, 60)}${widest.length > 60 ? '…' : ''}`);

check('resize reached the frame, not just the story object', after.columns, RESIZED_TO.columns);
// Bookkeeping, not corroboration: `resize()` writes this field itself, on the way
// to the stream, so it holds even when the resize never reached Ink. The frame
// check above is the one that can fail. This catches a refactor that stopped
// recording the size the public accessor reports.
check('the story records the width it was resized to', story.columns, RESIZED_TO.columns);
check('the dialog content is still there', payloadToText(after).includes('Settings Error'), true);

// The decisive part: a remount would have reset focus to index 0.
fired.length = 0;
story.push('\r');
await new Promise(r => setTimeout(r, 250));
check('focus survived the resize, so it was in place and not a remount', fired, ['continue']);

// `resize()` is documented to throw when there is nothing mounted
// (harness.tsx:325). That guard is worth pinning: silently doing nothing would
// leave a caller believing the story had been resized.
await story.unmount();
let threw = false;
try {
  story.resize(100, 24);
} catch {
  threw = true;
}
check('resizing an unmounted story throws rather than silently doing nothing', threw, true);

console.log();
if (failures.length > 0) {
  for (const reason of failures) console.error(`FAIL ${reason}`);
  process.exit(1);
}
console.log('resize() is in place and keeps focus, which is what harness.tsx cites it for.');
process.exit(0);
