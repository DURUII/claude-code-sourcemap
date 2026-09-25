/**
 * Check the story states that a keypress is required to reach.
 *
 *   bun run src/tests/storybook/probe-story-states.ts
 *
 * `check-stories.ts` proves each story paints its opening screen. That leaves
 * the most interesting half unverified: six stories in the manifest say "press
 * Enter to reach X" in their descriptions, and until this probe existed, nothing
 * established that X was reachable at all. A story whose second screen never
 * appears looks exactly like a story that works, as long as you only ever look
 * at the first frame.
 *
 * Each case is the same shape as the browser's own protocol, which is the point:
 * it spawns the worker, waits for the first frame, writes the same JSON `key`
 * message the server writes, and then looks for the expected text in the next
 * frame. So this exercises the real stdin path, not a simulation of it.
 *
 * The expectations are substrings of real rendered text rather than callback
 * names where possible, so this fails if the *screen* changes, not merely if a
 * handler stops firing.
 *
 * A case passes only when both conditions hold: a frame arrived after the keys
 * were written, and the expectation was not already on the mounting screen. The
 * second is what makes the case mean what its description says. A search that
 * only asked "is this text on screen" passed a story whose fixture happened to
 * open in the state the case claims a keypress reaches, which is the failure this
 * probe exists to catch rather than to commit.
 */
import { mkdtempSync } from 'fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { payloadToText, type FramePayload } from './frame-payload.js';

const WORKER = join(import.meta.dir, 'worker.tsx');
const ROOT = join(import.meta.dir, '..', '..', '..');
const TIMEOUT_MS = Number(process.env.SB_PROBE_TIMEOUT ?? 20_000);

/** Enter, as `keyToBytes` maps it. Down is the sequence a terminal sends. */
const ENTER = '\r';
const DOWN = '\x1b[B';

type Case = {
  story: string;
  /** Sent in order, back to back, exactly as the client sends them. */
  keys: string[];
  /** Must appear in the resulting screen or in a story log line. */
  expect: string;
  /** What the keypress is meant to demonstrate. */
  why: string;
};

/*
 * `expect` strings are copied out of the components, not retyped. That is worth
 * insisting on because the trailing character is not consistent across them:
 * TeleportStash writes "Stashing changes" + three ASCII periods, while the
 * wrapper and the mismatch dialog write a single U+2026. An expectation typed
 * from memory will silently match one and miss the other, and a miss here reads
 * as a broken component rather than a broken assertion. To check a string
 * before adding it: grep -o '<text>.\{0,3\}' <component> | od -c
 */

const CASES: Case[] = [
  {
    story: 'invalid-settings',
    keys: [DOWN, ENTER],
    expect: '[story] onContinue',
    why: 'a key sequence reaches a callback, not just a redraw',
  },
  {
    story: 'resume-task',
    keys: [DOWN, ENTER],
    expect: '[story] onSelect sess_02',
    why: 'the session list selects the row you moved to, not the first one',
  },
  {
    story: 'teleport-resume-resuming',
    keys: [ENTER],
    expect: 'Resuming session…',
    why: 'the wrapper replaces the list with a resume in progress',
  },
  {
    story: 'teleport-resume-error',
    keys: [ENTER],
    expect: 'Failed to resume session',
    why: 'a failed resume replaces the list rather than returning to it',
  },
  {
    story: 'teleport-stash-stashing',
    keys: [ENTER],
    expect: 'Stashing changes...',
    why: 'the stash prompt swaps its options for a spinner',
  },
  {
    story: 'teleport-stash-error-stash',
    keys: [ENTER],
    expect: 'Failed to stash changes',
    why: 'a failed stash replaces the file list entirely',
  },
  {
    story: 'teleport-repo-mismatch-validating',
    keys: [ENTER],
    expect: 'Validating repository…',
    why: 'the path check is visible while it runs',
  },
  {
    story: 'teleport-repo-mismatch-invalid',
    keys: [ENTER],
    expect: 'no longer contains the correct repository',
    why: 'a failed check drops the path and explains why',
  },
];

type Result = { testCase: Case; passed: boolean; saw: string };

async function drive(testCase: Case): Promise<Result> {
  const configDir = mkdtempSync(join(tmpdir(), `sb-probe-${testCase.story}-`));
  const proc = Bun.spawn([process.execPath, 'run', WORKER], {
    cwd: ROOT,
    env: {
      ...process.env,
      SB_STORY: testCase.story,
      FORCE_COLOR: '3',
      FORCE_HYPERLINK: '1',
      CLAUDE_CONFIG_DIR: configDir,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const result = await new Promise<Result>((resolve, reject) => {
    let latest = '';
    // Log lines count too: a callback firing is proven by the story logging it,
    // and that is a better signal than inferring it from a redraw.
    let logs: string[] = [];
    let sent = false;
    let settled = false;
    // A search that only asks "is the expectation on screen" cannot tell a state
    // the keypress reached from one the story was already showing, and the case is
    // precisely that this state is one keypress away. So the first screen is kept
    // and the expectation must not be in it.
    let preKeyText = '';
    let frames = 0;
    let keysSentAtFrame = -1;

    const done = (passed: boolean, detail?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.kill();
      resolve({
        testCase,
        passed,
        saw: detail ? `${detail}\n${latest || logs.join(' | ')}` : latest || logs.join(' | '),
      });
    };

    const timer = setTimeout(() => done(false), TIMEOUT_MS);

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
          let message: { type?: string; text?: string; payload?: FramePayload };
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if (message.type === 'log' && message.text) logs.push(message.text);
          if (message.type === 'frame' && message.payload) {
            frames++;
            latest = payloadToText(message.payload);
            if (!sent) {
              // First complete screen is on the wire: now send the keys.
              sent = true;
              keysSentAtFrame = frames;
              preKeyText = `${latest}\n${logs.join('\n')}`;
              for (const data of testCase.keys) {
                proc.stdin.write(JSON.stringify({ type: 'key', data }) + '\n');
              }
              proc.stdin.flush();
            }
          }
          if (frames <= keysSentAtFrame) continue;
          const haystack = `${latest}\n${logs.join('\n')}`;
          if (!haystack.includes(testCase.expect)) continue;
          // The expectation is on screen and a frame arrived after the keys were
          // written. If it was also on the mounting screen, the keypress is not
          // what put it there, so the case proves nothing and fails. A frame that
          // was already in flight when the keys were written counts as post-key
          // here, which is why this second condition is the load-bearing one.
          if (preKeyText.includes(testCase.expect)) {
            return done(
              false,
              'the expectation was already on screen before the keys were sent, so this ' +
                'case does not show that a keypress reaches it',
            );
          }
          return done(true);
        }
      }
    })();

    proc.exited.then(code => {
      // Reaching here means the search never matched. Report what was on screen
      // for the last frame, which is what makes a failure diagnosable.
      void code;
      done(false);
    });
  });

  await rm(configDir, { recursive: true, force: true }).catch(() => {});
  return result;
}

let failures = 0;
for (const testCase of CASES) {
  const result = await drive(testCase);
  if (result.passed) {
    console.log(`ok   ${testCase.story.padEnd(34)} ${testCase.why}`);
  } else {
    failures++;
    console.log(`FAIL ${testCase.story.padEnd(34)} expected ${JSON.stringify(testCase.expect)}`);
    const lines = result.saw.split('\n').map(l => l.trim()).filter(Boolean);
    console.log(`       saw: ${lines.slice(0, 4).join(' / ') || '(nothing)'}`);
  }
}

console.log(`\n${CASES.length} keypress-reachable states, ${failures} wrong.`);
if (failures > 0) process.exit(1);
console.log('Every state the manifest says is one keypress away really is.');
process.exit(0);
