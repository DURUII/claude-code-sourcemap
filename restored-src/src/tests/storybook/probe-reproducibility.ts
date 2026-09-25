/**
 * Two claims the plan makes about the gallery, measured in separate processes.
 *
 *   bun run src/tests/storybook/probe-reproducibility.ts
 *
 * 1. Reproducibility. Two runs of the same story produce byte-identical cell
 *    grids. This is what makes the gallery CI-able, so it is checked across two
 *    worker spawns rather than two mounts in one process: separate processes are
 *    what the gallery actually does, and they also catch module-level state that
 *    happens to survive a second mount.
 *
 *    The default is strict: every story must paint the same first frame in both
 *    processes, and an undeclared story that drifts is a FAIL with exit 1, not a
 *    report. `SETTLED_FRAME` below is the exception list, one entry per story
 *    allowed to be compared after it has settled instead, each carrying its
 *    reason. That list is the only way to opt out and it is deliberately
 *    conspicuous, because an entry claims the story's first paint is not
 *    comparable as a property of the component rather than of the fixture.
 *
 * 2. FORCE_COLOR is not measured here, though the plan lists both claims as one
 *    item. The colour half compares the raw SGR of two processes, one with the
 *    flag and one without, which is a different experiment from comparing two
 *    screens, and it lives in probe-colour-flag.tsx. This file sets FORCE_COLOR=3
 *    for its children because it has to: worker.tsx refuses to start unless the
 *    flag is exactly "3" (worker.tsx:84), so a child without it emits no frame at
 *    all and the story fails as uncomparable rather than as uncoloured. Measured,
 *    not reasoned: dropping the flag from the child env makes the worker refuse,
 *    so every story reports `no frame: FORCE_COLOR must be "3", got null. It has
 *    to be set by the parent process, because chalk reads it at import time.`
 *    (the worker's whole message, both sentences), and the summary line counts
 *    `0 stories compared`.
 */
import { mkdtempSync } from 'fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { STORIES } from './stories/manifest.js';
import { payloadToText, type FramePayload } from './frame-payload.js';

const WORKER = join(import.meta.dir, 'worker.tsx');
const ROOT = join(import.meta.dir, '..', '..', '..');
const TIMEOUT_MS = Number(process.env.SB_REPRO_TIMEOUT ?? 25_000);

/**
 * Stories that are only reproducible once their data has arrived, and why.
 *
 * The default is stricter: every story not named here must paint the same first
 * frame in both processes, and an undeclared story that drifts fails. That is
 * deliberate. `resume-conversation` is the one exception, and it earns it:
 * `LogSelector` reads the current branch in an effect
 * (`src/components/LogSelector.tsx:308`, `getBranch().then(setCurrentBranch)`),
 * so the very first paint either has the `Ctrl+B` hint or does not depending on
 * whether the promise settled before Ink committed. Measured: the two runs
 * differed on that hint. It is a race between a promise and the first commit,
 * not a clock reading, and it cannot be removed from the fixture, because the
 * asynchronous read is the component's own behaviour.
 *
 * The settled frame is deterministic, so that is what gets compared. Waiting is
 * only legitimate here because this story has nothing that animates: a story
 * with a Spinner never goes quiet, and its spinner glyph is a counter, so this
 * mode would compare two different spinner phases. Do not add a spinner story
 * to this list; compare its first frame instead.
 *
 * Only the variants that render that hint row need the exemption, and which
 * those are is measured rather than assumed. `resume-conversation` carries the
 * row on row 17 of its first frame and `resume-conversation-one` on row 11,
 * counted from 1 as `firstDifferingRow` below counts them;
 * `-empty` and `-sidechains` render the two-line empty state instead and
 * `-loading` a one-line spinner, so none of those three has a row the branch
 * lookup can change, and all three stay under the strict first-frame default.
 * The drift itself is rare: one full sweep of 35 stories reported `-one` once,
 * and 12 isolated runs under CPU load did not repeat it, which is why the
 * reason for the entry names the shared mechanism rather than a reproduction of
 * the failure.
 */
const SETTLED_FRAME: Record<string, string> = {
  'resume-conversation': 'first paint races the branch lookup, settles deterministic',
  'resume-conversation-one': 'same component and mock, and the same hint row on row 11',
};

/** How long to collect frames before taking the last, in settled mode. */
const SETTLE_MS = Number(process.env.SB_REPRO_SETTLE ?? 1_500);

type Spawned = { payload: FramePayload | null; error: string | null };

async function firstFrame(
  name: string,
  mode: 'first' | 'settled' = 'first',
): Promise<Spawned> {
  const configDir = mkdtempSync(join(tmpdir(), `sb-repro-${name}-`));
  const env: Record<string, string | undefined> = {
    ...process.env,
    SB_STORY: name,
    FORCE_COLOR: '3',
    FORCE_HYPERLINK: '1',
    CLAUDE_CONFIG_DIR: configDir,
  };

  const proc = Bun.spawn([process.execPath, 'run', WORKER], {
    cwd: ROOT,
    env: env as Record<string, string>,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const result = await new Promise<Spawned>(resolve => {
    let settled = false;
    let latest: FramePayload | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (r: Spawned) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (settleTimer) clearTimeout(settleTimer);
      proc.kill();
      resolve(r);
    };
    const timer = setTimeout(
      () => finish({ payload: null, error: `no frame within ${TIMEOUT_MS}ms` }),
      TIMEOUT_MS,
    );
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of proc.stdout) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let message: { type?: string; payload?: FramePayload; message?: string };
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if (message.type === 'frame' && message.payload) {
            if (mode === 'first') {
              finish({ payload: message.payload, error: null });
              return;
            }
            // Settled mode: keep the newest and let the timer below collect it.
            latest = message.payload;
            if (!settleTimer) {
              settleTimer = setTimeout(
                () => finish({ payload: latest, error: null }),
                SETTLE_MS,
              );
            }
          }
          if (message.type === 'error') {
            finish({ payload: null, error: message.message ?? 'worker reported an error' });
            return;
          }
        }
      }
    })();
    void proc.exited.then(code => finish({ payload: null, error: `exited ${code}` }));
  });

  await rm(configDir, { recursive: true, force: true }).catch(() => {});
  return result;
}

/** `seq`/`generation` describe a stream position, not the picture. */
function picture(payload: FramePayload): string {
  return JSON.stringify({
    columns: payload.columns,
    rows: payload.rows,
    grid: payload.grid,
    styles: payload.styles,
    links: payload.links,
  });
}

function firstDifferingRow(a: FramePayload, b: FramePayload): string {
  const left = payloadToText(a).split('\n');
  const right = payloadToText(b).split('\n');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if ((left[i] ?? '') !== (right[i] ?? '')) {
      return `row ${i + 1}: ${JSON.stringify((left[i] ?? '').slice(0, 70))} vs ${JSON.stringify((right[i] ?? '').slice(0, 70))}`;
    }
  }
  return 'grids are textually identical but styles or links differ';
}

console.log('== 1. two runs of the same story ==\n');
const unstable: string[] = [];
let checked = 0;
const filter = process.argv[2];
for (const meta of STORIES) {
  if (filter && !meta.name.includes(filter)) continue;
  const settledReason = SETTLED_FRAME[meta.name];
  const mode = settledReason ? 'settled' : 'first';
  const a = await firstFrame(meta.name, mode);
  const b = await firstFrame(meta.name, mode);
  const where = mode === 'settled' ? `settled after ${SETTLE_MS}ms` : 'first frame';

  if (!a.payload || !b.payload) {
    // The negative control is supposed to fail to paint; it produces no frame
    // either run, which is reproducible in the only sense available to it.
    if (meta.expectFailure) {
      console.log(`ok   ${meta.name.padEnd(34)} fails by design, no frame either run`);
      continue;
    }
    unstable.push(meta.name);
    console.log(`FAIL ${meta.name.padEnd(34)} no frame: ${a.error ?? b.error}`);
    continue;
  }
  checked++;
  const same = picture(a.payload) === picture(b.payload);
  if (same) {
    console.log(
      `ok   ${meta.name.padEnd(34)} identical (${where}, ${a.payload.columns}x${a.payload.rows})`,
    );
    if (settledReason) console.log(`       declared: ${settledReason}`);
  } else {
    unstable.push(meta.name);
    console.log(`FAIL ${meta.name.padEnd(34)} ${where}s differ between two processes`);
    console.log(`       ${firstDifferingRow(a.payload, b.payload)}`);
    if (settledReason) {
      console.log(`       declared reproducible once settled: ${settledReason}`);
    } else {
      console.log(
        '       undeclared. Either remove the nondeterminism or declare it in SETTLED_FRAME ' +
          'with the reason, so the exception stays visible.',
      );
    }
  }
}

console.log(`\n${checked} stories compared across two processes, ${unstable.length} drifting.`);
if (unstable.length > 0) {
  console.error(`\ndrifting: ${unstable.join(', ')}`);
  process.exit(1);
}
console.log('Every story paints the same screen twice.');
console.log('The colour half of this plan item lives in probe-colour-flag.tsx.');
process.exit(0);
