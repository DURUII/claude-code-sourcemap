/**
 * How long after a keystroke is the key actually absorbed, and does waiting for
 * a paint actually fix the two-keys-in-one-turn hazard?
 *
 * This exists because delivering two keys within one event-loop turn is unsafe:
 * the second is dispatched against state the first has not committed yet. On
 * InvalidSettingsDialog, whose options are [exit, continue] with focus starting
 * at index 0, `down` + `enter` in one write fires `onExit`; split by a paint it
 * fires `onContinue`. A sleep long enough to paper over that is a race with a
 * magic constant, so what is measured here is the *observable* that makes the
 * wait principled: the next painted frame.
 *
 * What this file establishes and what it does not:
 *
 *   it does    the one-turn pair really does fire the wrong callback, and
 *              waiting for a paint instead of a duration fixes it, measured on
 *              two independently mounted stories rather than twice on one.
 *   it does not distinguish a React commit race from a tokenizer problem. Only
 *              the timing side is observable from here; the tokenizer's own
 *              field-by-field behaviour is probe-keymap.tsx's subject.
 *
 * Two assertions below are tied to constants that shipped code depends on:
 * a key that moves focus must repaint inside the cap `worker.tsx` uses (30ms),
 * and a key that changes nothing visible must not repaint at all, which is the
 * only reason that cap is needed.
 *
 * Run: FORCE_COLOR=3 bun run src/tests/storybook/probe-key-settle.tsx
 */
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Set before the first call that reads it, not before the import.
// `getClaudeConfigHomeDir` is memoized with `process.env.CLAUDE_CONFIG_DIR` as
// the cache key (src/utils/envUtils.ts:7-14), so the value is read lazily at
// call time and a later assignment still takes effect. This runs before
// `enableConfigs()`, which is the first thing that needs it.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'sb-config-'));

import React from 'react';
import { enableConfigs } from '../../utils/config.js';
import { InvalidSettingsDialog } from '../../components/InvalidSettingsDialog.js';
import { mountStory, type MountedStory } from './harness.js';
import { payloadToText, serializeFrame } from './frame-payload.js';

enableConfigs();

const ESC = '\x1b';
const DOWN = ESC + '[B';

/** The cap `worker.tsx`'s `settleInput` waits for a paint before giving up. */
const CAP_MS = 30;

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

/** Mount a dialog whose callbacks are recorded rather than asserted on arrival. */
async function mountRecorder(): Promise<{ story: MountedStory; fired: string[]; paints: () => number }> {
  const fired: string[] = [];
  let paints = 0;
  const story = await mountStory(
    <InvalidSettingsDialog
      settingsErrors={
        [{ file: 'settings.json', path: 'model', message: 'must be a string' }] as never
      }
      onContinue={() => fired.push('continue')}
      onExit={() => fired.push('exit')}
    />,
    { columns: 80, rows: 20, onFrame: () => paints++ },
  );
  // Let the initial mount settle so its paint is not counted as a keystroke's.
  await new Promise(r => setTimeout(r, 250));
  return { story, fired, paints: () => paints };
}

/** Push `data`, then poll until the painted payload changes or `budgetMs` runs out. */
async function sendAndSettle(
  story: MountedStory,
  paints: () => number,
  data: string,
  budgetMs = 200,
): Promise<number | undefined> {
  const snap = (): string => JSON.stringify(serializeFrame(story.latest()!, story.stylePool()));
  const before = snap();
  const start = paints();
  const t0 = performance.now();
  story.push(data);

  while (performance.now() - t0 < budgetMs) {
    // 1ms polling keeps the resolution fine enough to see a sub-frame repaint,
    // and costs one timer per iteration which is far below the paint itself.
    await new Promise(r => setTimeout(r, 1));
    if (paints() > start && snap() !== before) return performance.now() - t0;
  }
  return undefined;
}

console.log('== 1. how long a keystroke takes to become visible ==\n');

const first = await mountRecorder();
console.log(`initial screen:\n${payloadToText(serializeFrame(first.story.latest()!, first.story.stylePool()))}\n`);

for (const [label, key, expectPaint] of [
  ['Down (moves focus)', DOWN, true],
  ['Up (moves focus back)', ESC + '[A', true],
  ['Unhandled key "x"', 'x', false],
  ['Escape (cancels)', ESC, false],
] as const) {
  const ms = await sendAndSettle(first.story, first.paints, key);
  console.log(
    `${label.padEnd(24)} settled in ${ms === undefined ? 'never (>200ms)' : `${ms.toFixed(1)}ms`}`,
  );
  if (expectPaint) {
    // The bound is the shipped cap, not a comfortable round number: if a focus
    // move takes longer than `worker.tsx` is willing to wait, the gallery drops
    // the key. Any larger bound would assert something that does not matter.
    check(`${label} repaints inside the ${CAP_MS}ms cap`, ms !== undefined && ms < CAP_MS, true);
  } else {
    check(`${label} paints nothing, which is why the cap exists`, ms, undefined);
  }
  await new Promise(r => setTimeout(r, 50));
}
check('Escape still reached the component', first.fired, ['exit']);
await first.story.unmount();

console.log('\n== 2. the same two keys, one turn apart vs one paint apart ==\n');

// Two independent mounts, so the second result cannot be explained by state the
// first trial left behind. An earlier version pushed Enter twice onto one
// instance and labelled the second one "enter alone"; whatever that measured, it
// was not a fresh pair.
const oneTurn = await mountRecorder();
oneTurn.story.push(DOWN);
oneTurn.story.push('\r');
await new Promise(r => setTimeout(r, 300));
check('one turn: the Enter landed on pre-Down state', oneTurn.fired, ['exit']);
await oneTurn.story.unmount();

const split = await mountRecorder();
// `sendAndSettle` pushes the key itself, so `before` is sampled while the
// pre-Down screen is still current. Pushing DOWN first and then watching for a
// change would miss the paint if it had already landed, and the trial would
// pass on the polling timeout instead of on the paint, which is the one thing
// this section exists to rule out.
const downSettled = await sendAndSettle(split.story, split.paints, DOWN);
check('Down really repainted before Enter was sent', downSettled !== undefined, true);
split.story.push('\r');
await new Promise(r => setTimeout(r, 300));
check('split by a paint: the Enter landed on committed state', split.fired, ['continue']);
await split.story.unmount();

console.log();
if (failures.length > 0) {
  for (const reason of failures) console.error(`FAIL ${reason}`);
  process.exit(1);
}
console.log(
  'A focus move repaints inside the cap, a no-op key does not, and the paint wait ' +
    'is what turns the pair into the right callback.',
);
process.exit(0);
