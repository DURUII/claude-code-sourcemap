/**
 * One worker process per story.
 *
 * A separate process is not an optimisation, it is a requirement: `mock.module`
 * is process-global and must run before the component under test is imported, so
 * two stories with different mock sets cannot share a process without one
 * contaminating the other.
 *
 * Speaks newline-delimited JSON over stdio. Inbound:
 *
 *   {"type":"key","data":"[B"}       one keystroke, verbatim
 *   {"type":"resize","columns":120,"rows":40}
 *   {"type":"repaint"}                      re-send the current frame
 *
 * Outbound:
 *
 *   {"type":"ready","name":...,"generation":...,"columns":...,"rows":...}
 *   {"type":"frame","payload":{...}}        see frame-payload.ts
 *   {"type":"log","level":"log","text":...} anything the story printed
 *   {"type":"error","message":...,"stack":...}
 *
 * Three rules for whoever speaks this protocol:
 *
 *   Send nothing before `ready`. It is written after the story has mounted and
 *   a frame is available, so it is the only safe point to start driving.
 *
 *   Keys are settled, not merely queued. Commands are handled one at a time and
 *   each one waits for the story to paint the result before the next is
 *   handled, because dispatching a second key before the first has committed
 *   makes the component act on stale state. See `settleInput`.
 *
 *   `generation` in `ready` identifies this worker's run. A client must discard
 *   the state it held for a story when the generation changes, because a new
 *   generation means a respawned worker whose `seq` restarts from 1 and whose
 *   component state is fresh.
 *
 * Usage:
 *
 *   FORCE_COLOR=3 FORCE_HYPERLINK=1 CLAUDE_CONFIG_DIR=$(mktemp -d) \
 *     SB_STORY=<name> bun run src/tests/storybook/worker.tsx
 *
 * The parent must set four things in the environment before this file's imports
 * run, which is why they are asserted rather than assigned here. The first two
 * are read at *import* time by libraries this file imports transitively, so a
 * top-level assignment in this file would run too late — ESM imports are hoisted
 * above the module body:
 *
 *   FORCE_COLOR=3       chalk inspects the environment when it is imported.
 *                       Without it chalk sits at level 0 and the theme emits no
 *                       colour at all.
 *   FORCE_HYPERLINK=1   `supportsHyperlinks()` consults the npm library first
 *                       and returns immediately when it says yes
 *                       (src/ink/supports-hyperlinks.ts:29-33), which is how a
 *                       link renders at all here: the library is initialised at
 *                       module load off the real `process.stdout`, and a piped
 *                       stdout fails its isTTY test. Left unset, links would
 *                       depend on the ambient TERM_PROGRAM, so a developer on
 *                       iTerm2 and the CI runner would see different frames.
 *                       Measured both ways in the header of frame-payload.ts's
 *                       sibling probe, `probe-hyperlink.tsx`.
 *   CLAUDE_CONFIG_DIR   otherwise config reads fall through to the real
 *                       ~/.claude (src/utils/envUtils.ts:7-13).
 *   SB_STORY            which story to mount.
 *
 * SB_GENERATION is optional and read from the environment rather than asserted,
 * because a standalone run (the echo-pipe smoke test) legitimately has no server
 * to number it.
 */
import { enableConfigs } from '../../utils/config.js';
import { findStory } from './stories/manifest.js';
import { mountStory } from './harness.js';
import { serializeFrame } from './frame-payload.js';
import type { StoryModule } from './stories/story-types.js';
import type { FramePayload } from './frame-payload.js';

// ---------------------------------------------------------------------------
// Guard the environment before doing any work, so a misconfigured spawn fails
// loudly instead of rendering monochrome or reading the user's real config.
// ---------------------------------------------------------------------------

const storyName = process.env.SB_STORY;
if (!storyName) fail('SB_STORY is not set');

if (process.env.FORCE_COLOR !== '3') {
  fail(
    `FORCE_COLOR must be "3", got ${JSON.stringify(process.env.FORCE_COLOR ?? null)}. ` +
      'It has to be set by the parent process, because chalk reads it at import time.',
  );
}
if (process.env.FORCE_HYPERLINK !== '1') {
  fail(
    `FORCE_HYPERLINK must be "1", got ${JSON.stringify(process.env.FORCE_HYPERLINK ?? null)}. ` +
      'It has to be set by the parent process, because supports-hyperlinks reads it at import ' +
      'time, and without it whether a link renders depends on the ambient terminal.',
  );
}
if (!process.env.CLAUDE_CONFIG_DIR) {
  fail('CLAUDE_CONFIG_DIR must be set by the parent, or config reads hit the real ~/.claude.');
}

const meta = findStory(storyName!);
if (!meta) fail(`unknown story ${JSON.stringify(storyName)}`);

/**
 * Identifies this worker's run. The server increments it on every respawn, so a
 * client that sees a generation it has not seen before knows to discard the
 * state it was holding for that story. Standalone runs default to 0.
 */
const generation = Number.parseInt(process.env.SB_GENERATION ?? '0', 10);
if (!Number.isSafeInteger(generation) || generation < 0) {
  fail(`SB_GENERATION must be a non-negative integer, got ${JSON.stringify(process.env.SB_GENERATION)}`);
}

// ---------------------------------------------------------------------------
// Protocol plumbing
// ---------------------------------------------------------------------------

/**
 * Frames are throttled rather than sent as they arrive. Spinner-driven stories
 * repaint far faster than a browser can use, and a socket flooded at paint rate
 * would spend its time on frames nobody sees. Only the newest frame is kept, so
 * throttling drops intermediate states rather than delaying the latest one.
 */
const FRAME_INTERVAL_MS = 33; // ~30fps
let pendingFrame: FramePayload | undefined;
let flushTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Count of frames painted so far. Used to tell when a keystroke has been
 * absorbed; see `settleInput`.
 */
let paintCount = 0;

/**
 * Numbers frames as they are *painted*, not as they are sent, so a gap in the
 * sequence a client receives means the throttle dropped intermediate states
 * rather than that the socket lost data. Those are different problems and are
 * worth being able to tell apart.
 */
let frameSeq = 0;

function write(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function flushFrame(): void {
  flushTimer = undefined;
  if (!pendingFrame) return;
  write({ type: 'frame', payload: pendingFrame });
  pendingFrame = undefined;
}

function queueFrame(payload: FramePayload): void {
  pendingFrame = payload;
  if (flushTimer === undefined) flushTimer = setTimeout(flushFrame, FRAME_INTERVAL_MS);
}

/**
 * Wait until the story has painted a new frame, or `timeoutMs` passes.
 *
 * This is the only correct way to know a keystroke has been absorbed. Ink paints
 * from React's `resetAfterCommit` (src/ink/ink.tsx:203-216), so an observed
 * paint means the key's state change is committed and the next key can safely be
 * dispatched. Dispatching two keys in one turn without this is not merely racy
 * in theory: `down` then `enter` on InvalidSettingsDialog, whose options are
 * [exit, continue] and whose focus starts at index 0, fires `onExit` instead of
 * `onContinue`, because the Enter is handled against the pre-Down state.
 *
 * Sleeping instead was measured and rejected. src/tests/storybook/probe-key-sync.tsx
 * runs this same `down`-then-`enter` pair against seven candidate waits and
 * asserts two things about them: the no-wait control loses every trial, and the
 * paint wait below wins every trial. The three in between pass some runs and lose
 * others. No counts are quoted here, because they move between runs, and a wait
 * that passes is still only racing the commit: passing a race is not winning it.
 *
 * The timeout exists because a key that changes nothing visible never paints.
 * It is the rare path, not the expected one: probe-key-settle.tsx asserts that a
 * key which moves focus repaints inside this cap, so the cap is measured to be
 * generous rather than assumed to be.
 */
async function settleInput(timeoutMs = 30): Promise<void> {
  const from = paintCount;
  const start = performance.now();
  while (paintCount <= from && performance.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 1));
  }
}

/**
 * Console output is part of the protocol, not noise.
 *
 * The stdout stream carries NDJSON, so a stray `console.log` from a story would
 * corrupt the stream. Frames are also unhelpful to read raw, whereas the text a
 * story logs explains what it is doing, so logs are forwarded to the browser and
 * shown next to the screen.
 */
for (const level of ['log', 'info', 'warn', 'error'] as const) {
  console[level] = (...args: unknown[]) => {
    write({
      type: 'log',
      level,
      text: args
        .map(a => (typeof a === 'string' ? a : safeInspect(a)))
        .join(' '),
    });
  };
}

function safeInspect(value: unknown): string {
  try {
    return typeof value === 'object' && value !== null
      ? JSON.stringify(value)
      : String(value);
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

enableConfigs();

try {
  // Applied before the component is imported, which is the whole reason this
  // runs in its own process.
  const storyModule = (await import(`./stories/${meta!.module}.js`)) as StoryModule;
  // The variant goes to both: a component whose *data* selects the state it
  // renders (TeleportStash's file list versus its error screen) can only be
  // steered through its mocks, and mocks must be installed before the import
  // that `element()` performs.
  const variant = meta!.variant ?? meta!.missingPath;
  await storyModule.mocks?.(variant);

  const node = await storyModule.element(variant);

  const story = await mountStory(node, {
    columns: meta!.columns,
    rows: meta!.rows,
    onFrame: (frame, stylePool) => {
      paintCount++;
      // Serialized here rather than in `flushFrame` on purpose: Ink swaps its
      // front/back frame buffers between paints, so holding the `Frame` for
      // 33ms and serializing it later would risk sending a buffer that has
      // already been overwritten by the next paint.
      queueFrame(serializeFrame(frame, stylePool, { seq: ++frameSeq, generation }));
    },
  });

  // A safety net rather than the normal path: `mountStory` replays whatever
  // painted before the sink was attached, so mounting a static dialog has
  // already queued its frame by the time this runs. Guarded so it cannot send
  // the same screen twice.
  if (frameSeq === 0) {
    const initial = story.latest();
    if (initial) {
      queueFrame(serializeFrame(initial, story.stylePool(), { seq: ++frameSeq, generation }));
    }
  }

  write({
    type: 'ready',
    name: meta!.name,
    generation,
    columns: story.columns,
    rows: story.rows,
  });

  // -------------------------------------------------------------------------
  // Inbound commands
  // -------------------------------------------------------------------------

  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        await handle(JSON.parse(line));
      } catch (error) {
        write({
          type: 'log',
          level: 'error',
          text: `bad command ${JSON.stringify(line)}: ${String(error)}`,
        });
      }

      // One command is not finished until the story has painted its result.
      // Commands arriving in the same chunk are otherwise handled back to back,
      // and the second is dispatched against state the first has not committed.
      //
      // A real terminal never batches keystrokes, but a browser can pack two
      // into one WebSocket frame and a held-down arrow key arrives as a burst,
      // so the worker cannot rely on the chunk boundary.
      await settleInput();
    }
  }

  async function handle(command: { type: string; data?: string; columns?: number; rows?: number }): Promise<void> {
    switch (command.type) {
      case 'key':
        // Exactly one keystroke per call. The input tokenizer coalesces
        // consecutive printable characters into a single event
        // (src/ink/termio/tokenize.ts:117-125), so batching keys here would
        // deliver "abc" as one three-character keystroke rather than three.
        story.push(command.data ?? '');
        break;
      case 'resize':
        story.resize(command.columns ?? story.columns, command.rows ?? story.rows);
        break;
      case 'repaint': {
        const frame = story.latest();
        if (frame) {
          queueFrame(serializeFrame(frame, story.stylePool(), { seq: ++frameSeq, generation }));
        }
        break;
      }
      default:
        write({ type: 'log', level: 'warn', text: `unknown command ${command.type}` });
    }
  }

  // Flush whatever is still throttled, so the final state is not lost when the
  // pipe closes. Without this the last frame sits in `pendingFrame` forever,
  // because the timer that would have sent it is the only thing that flushes.
  if (flushTimer !== undefined) clearTimeout(flushTimer);
  flushTimer = undefined;
  flushFrame();

  await story.unmount();
} catch (error) {
  write({
    type: 'error',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
}

function fail(message: string): never {
  // Written as a protocol error so the server can surface it in the UI rather
  // than losing it in the parent's log.
  process.stdout.write(JSON.stringify({ type: 'error', message }) + '\n');
  process.exit(1);
}
