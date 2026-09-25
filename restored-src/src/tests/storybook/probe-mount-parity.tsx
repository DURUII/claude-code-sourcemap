/**
 * Prove the harness's two mounting paths render the same screen.
 *
 *   bun run src/tests/storybook/probe-mount-parity.tsx
 *
 * `harness.tsx` puts components on screen two ways, and both matter:
 *
 *   `snapshot()`   mounts, settles, tears down, and returns the raw ANSI Ink
 *                  wrote. This is what run.tsx / run-teleport.tsx / run-resume.tsx
 *                  have always used.
 *   `mountStory()` keeps the instance alive and reports `Frame` objects. This is
 *                  what the gallery uses, and it was added later, on top of the
 *                  same <AppStateProvider><KeybindingSetup> wrapper.
 *
 * The refactor that introduced `mountStory()` touched the file the one-shot
 * runners depend on, so "did it change their output" is a real question. There
 * is no stored baseline to diff against, and nothing downstream supplies one
 * either: check-stories.ts asserts only that a story painted a frame, and prints
 * each story's first line without ever comparing it. This file is not a
 * regression test against a known-good screen. What it can rule out is the
 * asymmetric failure, where the new path drifts from the one the one-shot
 * runners still use. A refactor that moved both
 * paths the same way passes here; that gap is real and is not covered elsewhere.
 *
 * The two paths carry the same text by construction:
 *
 *   - both mount the identical wrapper, so the component tree is the same;
 *   - both drive a FakeStdout with `isTTY = false`, so every paint is a full
 *     frame and the last one is a whole screen rather than a cell diff;
 *   - `plain()` and `payloadToText()` both trim trailing whitespace per row.
 *
 * A failure here means one of those three stopped being true.
 */
import React from 'react';
import { enableConfigs } from '../../utils/config.js';
import { plain, mountStory, snapshot } from './harness.js';
import { payloadToText, serializeFrame, type FramePayload } from './frame-payload.js';
import type { Frame } from '../../ink/frame.js';
import type { StylePool } from '../../ink/screen.js';

enableConfigs();

/**
 * `snapshot()`'s FakeStdout pins rows to 40 with no option to change it, so the
 * live mount has to match that for the comparison to mean anything.
 */
const COLUMNS = 96;
const ROWS = 40;

const { InvalidSettingsDialog } = await import('../../components/InvalidSettingsDialog.js');
const { TeleportRepoMismatchDialog } = await import(
  '../../components/TeleportRepoMismatchDialog.js'
);

type Pair = { name: string; node: React.ReactNode };

/** Deliberately the same fixtures run.tsx prints, so this checks that file's subject. */
const PAIRS: Pair[] = [
  {
    name: 'InvalidSettingsDialog (2 errors)',
    node: (
      <InvalidSettingsDialog
        settingsErrors={
          [
            {
              file: '~/.claude/settings.json',
              path: 'permissions.defaultMode',
              message: 'Invalid enum value',
              expected: "'default' | 'acceptEdits' | 'plan'",
              invalidValue: 'yolo',
              suggestion: "Did you mean 'acceptEdits'?",
            },
            {
              file: '.claude/settings.local.json',
              path: 'env.OPENAI_API_KEY',
              message: 'Expected string, received number',
              invalidValue: 12345,
            },
          ] as never
        }
        onContinue={() => {}}
        onExit={() => {}}
      />
    ),
  },
  {
    name: 'TeleportRepoMismatchDialog (2 paths)',
    node: (
      <TeleportRepoMismatchDialog
        targetRepo="anthropics/claude-code"
        initialPaths={['/Users/durui/code/claude-code', '/Users/durui/code/cc-fork']}
        onSelectPath={() => {}}
        onCancel={() => {}}
      />
    ),
  },
  {
    name: 'TeleportRepoMismatchDialog (no paths)',
    node: (
      <TeleportRepoMismatchDialog
        targetRepo="anthropics/claude-code"
        initialPaths={[]}
        onSelectPath={() => {}}
        onCancel={() => {}}
      />
    ),
  },
];

/** The screen the live path paints, as text, waiting for a frame to arrive. */
async function liveText(node: React.ReactNode): Promise<string> {
  let latest: { frame: Frame; pool: StylePool } | null = null;
  const story = await mountStory(node, {
    columns: COLUMNS,
    rows: ROWS,
    onFrame: (frame, pool) => {
      latest = { frame, pool };
    },
  });
  try {
    const deadline = Date.now() + 5_000;
    while (!latest && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    if (!latest) throw new Error('the live mount never painted a frame');
    const { frame, pool } = latest as { frame: Frame; pool: StylePool };
    return payloadToText(serializeFrame(frame, pool));
  } finally {
    await story.unmount();
  }
}

/** The first row they disagree on, or null when the grids match. */
function firstDifference(a: string, b: string): { row: number; a: string; b: string } | null {
  const left = a.split('\n');
  const right = b.split('\n');
  const rows = Math.max(left.length, right.length);
  for (let i = 0; i < rows; i++) {
    if ((left[i] ?? '') !== (right[i] ?? '')) {
      return { row: i + 1, a: left[i] ?? '(no row)', b: right[i] ?? '(no row)' };
    }
  }
  return null;
}

let failures = 0;
for (const { name, node } of PAIRS) {
  // One-shot path: the API run.tsx uses, at the same width.
  const oneShot = plain(await snapshot(node, { columns: COLUMNS, settleMs: 300, tty: false }));
  // Live path: what the gallery shows for the same component.
  const live = await liveText(node);

  const diff = firstDifference(oneShot, live);
  const rows = oneShot.split('\n').length;
  if (diff) {
    failures++;
    console.log(`FAIL ${name}`);
    console.log(`       row ${diff.row} differs`);
    console.log(`       snapshot: ${JSON.stringify(diff.a.slice(0, 88))}`);
    console.log(`       live:     ${JSON.stringify(diff.b.slice(0, 88))}`);
  } else {
    console.log(`ok   ${name.padEnd(38)} ${rows} rows identical, ${oneShot.length} bytes`);
  }
}

console.log(
  `\n${PAIRS.length} components rendered both ways, ${failures} disagreeing.`,
);
if (failures > 0) process.exit(1);
console.log('snapshot() and mountStory() produce the same screen.');
process.exit(0);
