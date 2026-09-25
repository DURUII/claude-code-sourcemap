/**
 * Which way of waiting between two keystrokes is actually safe?
 *
 * Delivering `down` and `enter` in one event-loop turn dispatches the Enter
 * against state the Down has not committed, so focus is still on index 0 and
 * `onExit` fires instead of `onContinue`. probe-key-settle.tsx established the
 * cause (a React commit race, not a tokenizer problem) and the latency
 * (4-9ms for a key that changes the screen).
 *
 * Timing-based yields are the obvious fix and they are the wrong one: they win
 * the race by luck, and the luck runs out. Some of them lose every trial; others
 * pass every trial, and the passing ones are the dangerous ones, because 20
 * green trials cannot tell "safe" from "lucky". What is used instead is the only
 * signal that *proves* the commit landed: the next painted frame, which Ink
 * emits from React's resetAfterCommit.
 *
 * Each strategy runs REPEATS trials of the same two keys. The correct outcome is
 * `onContinue` every single time; a strategy that is merely usually right is a
 * strategy that will corrupt a keystroke burst later.
 *
 * Which of those claims this file can enforce is declared per strategy in
 * VERDICT, and the three cases are not interchangeable:
 *
 *   must-lose  a strategy that never wins. Asserting that it still loses is a
 *              real check, because if the control ever starts passing, the race
 *              is no longer being exercised and every other row is meaningless.
 *   must-win   the paint wait that worker.tsx actually ships. Dropping a single
 *              trial here means the gallery drops keystrokes.
 *   reported   strategies that passed every trial but are not safe, only lucky.
 *              Printed, and deliberately not asserted: 20 trials cannot falsify
 *              luck. Do not promote one of these to must-win on the strength of
 *              a green run, which is the exact reasoning this file exists to
 *              reject. The header's numbers are allowed to drift for the same
 *              reason, so none of them are quoted here.
 *
 * Run: FORCE_COLOR=3 bun run src/tests/storybook/probe-key-sync.tsx
 */
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'sb-config-'));

import React from 'react';
import { enableConfigs } from '../../utils/config.js';
import { InvalidSettingsDialog } from '../../components/InvalidSettingsDialog.js';
import { mountStory, type MountedStory } from './harness.js';

enableConfigs();

const ESC = '\x1b';
const DOWN = ESC + '[B';
const ENTER = '\r';
const REPEATS = 20;

/**
 * Wait for one more painted frame, or give up after `timeoutMs`.
 *
 * A paint is emitted synchronously from Ink's `scheduleRender`, which React
 * calls in `resetAfterCommit`, so seeing one means the keystroke's state change
 * is committed and the next key can safely be dispatched. Keys that change
 * nothing visible never paint, which is why a timeout is needed; the caller
 * should treat the timeout as the rare case rather than the expected one.
 */
async function waitForPaint(
  count: () => number,
  from: number,
  timeoutMs: number,
): Promise<'painted' | 'timeout'> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    if (count() > from) return 'painted';
    // 1ms polling: fine enough to observe a 4ms repaint, and one timer per
    // iteration is negligible next to the paint it is waiting for.
    await new Promise(r => setTimeout(r, 1));
  }
  return count() > from ? 'painted' : 'timeout';
}

type Verdict = 'must-lose' | 'must-win' | 'reported';

type Strategy = {
  name: string;
  verdict: Verdict;
  /** Returns how the wait resolved, for the report. */
  wait: (story: MountedStory, paints: () => number) => Promise<string>;
};

const strategies: Strategy[] = [
  { name: 'nothing (control)', verdict: 'must-lose', wait: async () => 'none' },
  {
    name: 'queueMicrotask',
    verdict: 'must-lose',
    wait: async () => (await new Promise(r => queueMicrotask(r)), 'none'),
  },
  {
    name: 'setImmediate x1',
    verdict: 'must-lose',
    wait: async () => (await new Promise(r => setImmediate(r)), 'none'),
  },
  {
    name: 'setImmediate x2',
    verdict: 'reported',
    wait: async () => (await new Promise(r => setImmediate(() => setImmediate(r))), 'none'),
  },
  {
    name: 'setTimeout(0)',
    verdict: 'reported',
    wait: async () => (await new Promise(r => setTimeout(r, 0)), 'none'),
  },
  { name: 'Bun.sleep(0)', verdict: 'reported', wait: async () => (await Bun.sleep(0), 'none') },
  {
    // Called after the caller has pushed DOWN, so the paint being awaited is
    // the one that Down causes. `from` is sampled before it can have landed,
    // because Ink defers the render to a microtask.
    name: 'paint, 30ms cap',
    verdict: 'must-win',
    wait: (_story, paints) => waitForPaint(paints, paints(), 30),
  },
];

/** Mount a fresh dialog; `onContinue` is the correct outcome for down+enter. */
async function mountFor(fired: string[], onPaint: () => void): Promise<MountedStory> {
  const story = await mountStory(
    <InvalidSettingsDialog
      settingsErrors={
        [{ file: 'settings.json', path: 'model', message: 'must be a string' }] as never
      }
      onContinue={() => fired.push('continue')}
      onExit={() => fired.push('exit')}
    />,
    { columns: 80, rows: 20, onFrame: onPaint },
  );
  await new Promise(r => setTimeout(r, 200));
  return story;
}

console.log(`down + enter, ${REPEATS} trials per strategy; correct outcome is "continue"\n`);

const failures: string[] = [];

for (const s of strategies) {
  let ok = 0;
  const wrong: string[] = [];
  for (let i = 0; i < REPEATS; i++) {
    const fired: string[] = [];
    let paints = 0;
    const story = await mountFor(fired, () => {
      paints++;
    });
    paints = 0; // ignore the mount paint

    story.push(DOWN);
    await s.wait(story, () => paints);
    story.push(ENTER);

    await new Promise(r => setTimeout(r, 120));
    if (fired[0] === 'continue') ok++;
    else wrong.push(fired[0] ?? 'none');
    await story.unmount();
  }
  console.log(
    `${s.name.padEnd(20)} ${String(ok).padStart(3)}/${REPEATS}` +
      (wrong.length ? `   wrong (${wrong.length}): ${[...new Set(wrong)].join(', ')}` : '   all correct') +
      `   [${s.verdict}]`,
  );

  // The two enforced directions. A `must-lose` strategy that sweeps means the
  // race stopped happening, which invalidates the whole table rather than
  // flattering the control; a `must-win` strategy that drops one trial is the
  // shipped behaviour failing. `reported` rows are printed and left alone.
  if (s.verdict === 'must-lose' && ok === REPEATS) {
    failures.push(
      `${s.name} won every trial, so the race is no longer being exercised and the other rows say nothing`,
    );
  }
  if (s.verdict === 'must-win' && ok < REPEATS) {
    failures.push(
      `${s.name} lost ${REPEATS - ok} of ${REPEATS} trials; worker.tsx ships this wait, so the gallery is dropping keystrokes`,
    );
  }
}

console.log();
if (failures.length > 0) {
  for (const reason of failures) console.error(`FAIL ${reason}`);
  process.exit(1);
}
console.log(
  `The race is still live (every must-lose strategy lost at least one trial) and the ` +
    `paint wait won all ${REPEATS}.`,
);
console.log(
  'The reported rows are not evidence either way; see VERDICT in this file for why.',
);
process.exit(0);
