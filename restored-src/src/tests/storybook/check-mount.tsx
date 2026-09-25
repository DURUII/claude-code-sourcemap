/**
 * Terminal-only proof for the two pieces the gallery stands on:
 *   `mountStory()`      — a live, drivable Ink instance
 *   `serializeFrame()`  — a portable, lossless-enough picture of its screen
 *
 * No browser and no HTTP here on purpose. If this passes, the remaining work is
 * transport, and any breakage is the transport's fault.
 *
 * Run: FORCE_COLOR=3 bun run src/tests/storybook/check-mount.tsx
 */
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Must precede any config-reading import, or reads fall through to the real
// ~/.claude (src/utils/envUtils.ts:7-13). See the plan's finding 7.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'sb-config-'));

import React from 'react';
import chalk from 'chalk';
import { enableConfigs } from '../../utils/config.js';
import { Text } from '../../ink.js';
import { InvalidSettingsDialog } from '../../components/InvalidSettingsDialog.js';
import { mountStory } from './harness.js';
import {
  findDanglingLinks,
  findRaggedRows,
  payloadToText,
  serializeFrame,
} from './frame-payload.js';
import { cellStyleKey } from './ansi-to-css.js';

enableConfigs();

if (chalk.level === 0) {
  console.error('chalk.level is 0: the theme will emit no colour, so colour assertions would be vacuous.');
  console.error('Re-run with FORCE_COLOR=3.');
  process.exit(1);
}

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}\n         expected ${e}\n         actual   ${a}`);
  }
};

// Shared with the browser-side and probe helpers rather than duplicated here.
const toText = payloadToText;

console.log('\n1. mount a live story');
const fired: string[] = [];
const story = await mountStory(
  <InvalidSettingsDialog
    settingsErrors={[{ file: 'settings.json', path: 'model', message: 'must be a string' }] as never}
    onContinue={() => fired.push('continue')}
    onExit={() => fired.push('exit')}
  />,
  { columns: 80, rows: 20 },
);

const first = story.latest();
check('a frame was painted', first !== undefined, true);
// Deliberately not `typeof story.stylePool() === 'object'`, which could not fail:
// `mountStory` throws before returning when the pool is missing, and
// `typeof null === 'object'` besides, so it passed even then. What a reader wants
// from a pool is that a lookup returns something usable, and that is what section
// 3 measures, on the colours the frame actually shipped.

console.log('\n2. serialize it');
const payload = serializeFrame(first!, story.stylePool());
check('columns', payload.columns, 80);
// Deliberately not `payload.rows === first.screen.height`, which is how
// `serializeFrame` assigns the field (frame-payload.ts:176) and therefore could
// not fail. The three checks below are what a reader actually assumes, and they
// are not equally load-bearing. The first two are bounds: the height Ink painted
// must not exceed the terminal it was given, and the browser must not be told
// about more rows than that. A change that took `rows` from the requested height
// while still looping over the content height satisfies both, because the
// requested height is exactly the bound.
//
// The third is the only one that compares the count `serializeFrame` reports
// against the grid it shipped: two separate code sites, the field assignment at
// frame-payload.ts:176 and the loop at :143, both reading `screen.height`. It is
// not, however, the only check that would catch either swap. Taking `rows` from
// the requested height also trips the `payload.rows < 20` check below. Padding the
// grid out instead, so that `rows` follows the content height while the loop runs
// to the requested height, passes that check and both bounds, but trips the ragged
// check on the next line, because the padding rows are empty and `findRaggedRows`
// counts an empty row as covering 0 of the columns (frame-payload.ts:193).
check('the screen is no taller than the terminal we asked for', first!.screen.height <= 20, true);
check('the reported row count never exceeds the requested height', payload.rows <= 20, true);
check('the reported row count matches the grid that was shipped', payload.grid.length, payload.rows);
check('every row covers exactly `columns`', findRaggedRows(payload), []);
// The link table exists whether or not anything is linked, and index 0 is the
// no-link sentinel, mirroring `HyperlinkPool` (src/ink/screen.ts:56-67). The
// channel itself is exercised in probe-hyperlink.tsx, which can force a link to
// render; this dialog happens to contain none.
check('link table starts with the no-link sentinel', payload.links[0], '');
check('no run points outside the link table', findDanglingLinks(payload), []);
check('stream fields default when the caller has no stream', [payload.seq, payload.generation], [0, 0]);

const text = toText(payload);
console.log('\n--- reconstructed grid ---');
console.log(text);
console.log('--- end ---\n');

check('shows the dialog title', text.includes('Settings Error'), true);
check('shows the error file', text.includes('settings.json'), true);
check('shows both choices',
  text.includes('Exit and fix manually') && text.includes('Continue without these settings'), true);

console.log('\n3. colours survive into the style table');
const styleKeys = payload.styles.map(cellStyleKey);
check('at least one style carries a colour', payload.styles.some(s => s.color !== undefined), true);
check('styles are deduplicated', new Set(styleKeys).size, styleKeys.length);
console.log('     distinct styles:', payload.styles.length,
  '| with colour:', payload.styles.filter(s => s.color).length);

console.log('\n4. payload size');
// What matters is bytes on the wire at up to 30fps, so measure the real thing
// against an explicit budget. A run costs ~20 bytes of JSON, so comparing byte
// count against cell count would be meaningless; the budget is the check.
const bytes = JSON.stringify(payload).length;
check('a dialog frame fits in 12KB', bytes < 12_000, true);
console.log(`     ${bytes} bytes for ${payload.columns}x${payload.rows} ` +
  `(${payload.grid.reduce((n, r) => n + r.length, 0)} runs)`);

// The structural claim behind the RLE, asserted at width so it cannot drift:
// many identical adjacent cells must collapse into a single run. 200 columns of
// one glyph is the clearest case.
{
  const wide = await mountStory(<Text>{'─'.repeat(200)}</Text>, { columns: 200, rows: 5 });
  const widePayload = serializeFrame(wide.latest()!, wide.stylePool());
  check('200 identical columns collapse to one run', widePayload.grid[0]!.length, 1);
  check('that run covers all 200 columns', widePayload.grid[0]![0]![0] * widePayload.grid[0]![0]![3], 200);

  // Frame ordering is metadata: it must ride along without touching the pixels,
  // or a client that compares grids across generations would see phantom edits.
  const stamped = serializeFrame(wide.latest()!, wide.stylePool(), { seq: 7, generation: 3 });
  check('seq and generation pass through', [stamped.seq, stamped.generation], [7, 3]);
  check('and leave the picture untouched', stamped.grid, widePayload.grid);
  await wide.unmount();
}

// Ink sizes the screen to its content, not to the requested rows: this dialog
// is 13 rows tall inside a 20-row terminal. The browser must therefore resize
// its grid per frame rather than allocating a fixed canvas up front.
check('screen height is content height, not the requested rows', payload.rows < 20, true);
console.log(`     frame is ${payload.columns}x${payload.rows} inside a 80x20 terminal`);

// The same fact in the direction that is actually load-bearing. A content-shorter
// frame only tells you the screen is not padded; what the comment above claims is
// that the client cannot allocate a fixed canvas, and that rests on the other
// direction, where the content is taller than the terminal that was asked for and
// Ink does not clamp it. Measured: the 13-row dialog inside a 5-row terminal
// comes back whole. If that ever starts being clamped, this check fails and the
// batching assumption behind the browser's per-frame grid resize needs revisiting.
{
  const small = await mountStory(
    <InvalidSettingsDialog
      settingsErrors={[{ file: 'settings.json', path: 'model', message: 'must be a string' }] as never}
      onContinue={() => {}} onExit={() => {}} />,
    { columns: 80, rows: 5 },
  );
  await new Promise(r => setTimeout(r, 200));
  const overflow = serializeFrame(small.latest()!, small.stylePool());
  check('content taller than the requested height is not clamped', overflow.rows > 5, true);
  check('and the oversized frame is still well formed', findRaggedRows(overflow), []);
  console.log(`     asked for 5 rows, got ${overflow.rows}`);
  await small.unmount();
}

console.log('\n5. the story is still live and drivable');
const before = story.latest();
story.push('\x1b[B'); // Down
await new Promise(r => setTimeout(r, 200));
story.push('\r'); // Enter
await new Promise(r => setTimeout(r, 200));
check('the callback fired', fired, ['continue']);
check('frames kept arriving', story.latest() !== before, true);
check('the latest frame is serializable',
  findRaggedRows(serializeFrame(story.latest()!, story.stylePool())), []);

console.log('\n6. resize happens in place');
// Focus is on index 1 (Continue) from section 5, and a remount would reset it to
// index 0. So the assertion that matters is not the new width but that the
// component's state is still there afterwards.
story.resize(100, 24);
await new Promise(r => setTimeout(r, 200));
const resized = serializeFrame(story.latest()!, story.stylePool());
check('new columns', resized.columns, 100);
check('still not ragged', findRaggedRows(resized), []);
check('content survived the resize', toText(resized).includes('Settings Error'), true);

fired.length = 0;
story.push('\r');
await new Promise(r => setTimeout(r, 200));
check('focus survived the resize (a remount would reset it to exit)', fired, ['continue']);

console.log('\n7. teardown is clean');
await story.unmount();
check('latest() is empty after unmount', story.latest(), undefined);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll checks passed.');
process.exit(0);
