/**
 * Mount every story in the manifest and report what came out.
 *
 *   bun run src/tests/storybook/check-stories.ts            # all stories
 *   bun run src/tests/storybook/check-stories.ts stash      # names containing
 *
 * This is the automated half of "does the gallery work": it runs each story
 * through its worker exactly as the server would, and fails if a story that
 * should paint does not, or if the story declared as the negative control
 * unexpectedly succeeds.
 *
 * It spawns workers directly rather than going through the server, so a failure
 * here is a story's fault and not the socket's. Nor does it cover the client: the
 * keymap and the frame layout are checked from the terminal side, by
 * probe-keys.tsx and probe-frame-layout.tsx, driving real components through the
 * client's own tables. What is left to the browser is the DOM half, painting a
 * payload the socket has already delivered.
 *
 * `expectFailure` in the manifest marks the one story that is supposed to fail.
 * Checking that it really does is the point: it is the evidence that a broken
 * story cannot take the others with it, and evidence that is never exercised is
 * not evidence.
 */
import { mkdtempSync } from 'fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { STORIES, type StoryMeta } from './stories/manifest.js';
import { payloadToText, type FramePayload } from './frame-payload.js';

const WORKER = join(import.meta.dir, 'worker.tsx');
/** The repo root, because the worker's imports use `src/...` aliases. */
const ROOT = join(import.meta.dir, '..', '..', '..');
const TIMEOUT_MS = Number(process.env.SB_CHECK_TIMEOUT ?? 25_000);

const filter = process.argv[2];
const selected = filter ? STORIES.filter(s => s.name.includes(filter)) : STORIES;

type Outcome = {
  meta: StoryMeta;
  /** True when the result matches what the manifest says should happen. */
  asExpected: boolean;
  status: string;
  detail: string;
  size: string;
  firstLine: string;
};

async function runStory(meta: StoryMeta): Promise<Outcome> {
  const configDir = mkdtempSync(join(tmpdir(), `sb-check-${meta.name}-`));
  const proc = Bun.spawn([process.execPath, 'run', WORKER], {
    cwd: ROOT,
    env: {
      ...process.env,
      SB_STORY: meta.name,
      SB_GENERATION: '1',
      FORCE_COLOR: '3',
      FORCE_HYPERLINK: '1',
      CLAUDE_CONFIG_DIR: configDir,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const outcome = await new Promise<Outcome>(resolve => {
    let settled = false;
    let stderr = '';
    let ready: { columns: number; rows: number } | null = null;

    const finish = (status: string, detail: string, frame?: FramePayload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        meta,
        asExpected: false,
        status,
        detail,
        size: frame ? `${frame.columns}x${frame.rows}` : '--',
        firstLine: frame ? firstNonBlankLine(frame) : '',
      });
    };

    const timer = setTimeout(() => {
      finish('timeout', `no frame within ${TIMEOUT_MS}ms`);
      proc.kill();
    }, TIMEOUT_MS);

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
          let message: { type?: string; columns?: number; rows?: number; payload?: FramePayload; message?: string; stack?: string };
          try {
            message = JSON.parse(line);
          } catch {
            // The worker writes JSON only, so this is a stray print from a story.
            finish('stray-output', line.slice(0, 120));
            proc.kill();
            return;
          }
          if (message.type === 'ready') {
            ready = { columns: message.columns ?? 0, rows: message.rows ?? 0 };
          } else if (message.type === 'error') {
            finish('error', message.message ?? 'worker reported an error');
            proc.kill();
            return;
          } else if (message.type === 'frame' && message.payload) {
            // A frame is the finish line: `mountStory` replays anything painted
            // before the sink attached, so the first one is a complete screen.
            finish(ready ? 'painted' : 'painted-without-ready', '', message.payload);
            proc.kill();
            return;
          }
        }
      }
    })();

    void (async () => {
      stderr = await new Response(proc.stderr).text();
      const code = await proc.exited;
      finish('exited', `exit ${code}: ${stderr.trim().split('\n').slice(-1)[0] ?? 'no stderr'}`);
    })();
  });

  await rm(configDir, { recursive: true, force: true }).catch(() => {});

  const painted = outcome.status === 'painted';
  outcome.asExpected = meta.expectFailure ? !painted : painted;
  return outcome;
}

/** The first line with visible content, so a screen's opening text is legible. */
function firstNonBlankLine(frame: FramePayload): string {
  for (const line of payloadToText(frame).split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed.length > 92 ? `${trimmed.slice(0, 89)}...` : trimmed;
  }
  return '(blank screen)';
}

const results: Outcome[] = [];
for (const meta of selected) {
  const outcome = await runStory(meta);
  results.push(outcome);
  const mark = outcome.asExpected ? 'ok  ' : 'FAIL';
  const control = meta.expectFailure ? ' [expected to fail]' : '';
  console.log(`${mark} ${meta.name.padEnd(34)} ${outcome.status.padEnd(22)} ${outcome.size.padStart(9)}${control}`);
  if (outcome.firstLine) console.log(`       ${outcome.firstLine}`);
  if (!outcome.asExpected) console.log(`       -> ${outcome.detail}`);
}

const failed = results.filter(r => !r.asExpected);
const painted = results.filter(r => r.status === 'painted').length;
console.log(
  `\n${results.length} stories: ${painted} painted, ` +
    `${results.filter(r => r.meta.expectFailure).length} expected to fail, ${failed.length} wrong.`,
);

if (failed.length > 0) {
  console.error(`\n${failed.map(f => `${f.meta.name}: ${f.detail}`).join('\n')}`);
  process.exit(1);
}
console.log('Every story behaved as the manifest says it should.');
process.exit(0);
