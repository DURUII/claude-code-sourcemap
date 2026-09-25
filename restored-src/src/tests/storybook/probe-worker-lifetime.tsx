/**
 * Does a story keep its state after you stop watching it?
 *
 * It must not. The gallery exists to show a dialog's initial state, so opening a
 * story, pressing Down to move focus, and reloading the page has to put you back
 * at the top of the list rather than where you left off.
 *
 * The server therefore kills a worker when its last socket closes. That is a
 * reversal of the original plan, which reused workers between views, and this
 * probe is the reason: with reuse, step B below returned `onContinue` for a bare
 * `Enter`, i.e. the focus left behind by step A, while a genuinely fresh worker
 * returns `onExit`.
 *
 * So the assertion is deliberately the opposite of the old behaviour. If someone
 * reintroduces reuse, step B starts reporting `onContinue` and this fails.
 *
 * Needs the real server, because the property under test is a server decision
 * about process lifetime. It starts one on its own port and tears it down.
 *
 * Run: bun run src/tests/storybook/probe-worker-lifetime.tsx
 */
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';

const PORT = 6099;
const STORY = 'invalid-settings';
const BYTES: Record<string, string> = { down: '\x1b[B', enter: '\r', esc: '\x1b' };

/**
 * Connect, wait for the story to be ready, send `keys` one per painted frame,
 * and report which callback fired.
 */
function drive(keys: string[]): Promise<string> {
  return new Promise(resolve => {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws?story=${STORY}`);
    let frames = 0;
    let next = 0;
    let generation = -1;
    const finish = (what: string) => {
      try {
        socket.close();
      } catch {}
      resolve(what);
    };
    const timer = setTimeout(() => finish(`TIMEOUT after ${frames} frame(s)`), 25_000);
    const sendNext = () => {
      if (next < keys.length) {
        socket.send(JSON.stringify({ type: 'key', data: BYTES[keys[next++]!] }));
      }
    };

    socket.onmessage = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data));
      if (message.type === 'hello') generation = message.generation;
      if (message.type === 'status' && message.status === 'ready') {
        // The mount's own frames must settle before the first keystroke, or the
        // key is dispatched against a tree that is still being built.
        setTimeout(sendNext, 300);
      }
      if (message.type === 'log' && String(message.text).includes('[story]')) {
        clearTimeout(timer);
        finish(`${String(message.text).replace('[story] ', '')} (gen=${generation}, ${frames} frame(s))`);
      }
      if (message.type === 'frame') {
        frames++;
        sendNext();
      }
    };
    socket.onerror = () => {
      clearTimeout(timer);
      finish('WS ERROR');
    };
  });
}

/**
 * Wait until the server reports no live workers, so the next view cannot land on
 * a worker that is still winding down. Closing a socket is not instant, and
 * without this the next connection can arrive before the server has processed
 * the previous close, which would make every assertion a race.
 */
async function waitForNoWorkers(timeoutMs = 10_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const health = (await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()) as {
      workers: unknown[];
    };
    if (health.workers.length === 0) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

const server = Bun.spawn([process.execPath, 'run', join(import.meta.dir, 'server.ts')], {
  cwd: join(import.meta.dir, '..', '..', '..'),
  env: {
    ...process.env,
    SB_PORT: String(PORT),
    CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'sb-probe-lifetime-')),
  },
  stdout: 'pipe',
  stderr: 'pipe',
});

const failures: string[] = [];
try {
  // Poll rather than sleep a fixed amount, so a slow start does not look like a
  // broken server.
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try {
      up = (await fetch(`http://127.0.0.1:${PORT}/health`)).ok;
    } catch {
      await new Promise(r => setTimeout(r, 250));
    }
  }
  if (!up) throw new Error(`server did not come up on ${PORT}`);

  const a = await drive(['down', 'enter']);
  const diedAfterA = await waitForNoWorkers();
  const b = await drive(['enter']);
  const diedAfterB = await waitForNoWorkers();
  const c = await drive(['enter']);

  console.log(`A. fresh worker, Down then Enter : ${a}`);
  console.log(`B. reconnect,   Enter alone      : ${b}`);
  console.log(`C. reconnect,   Enter alone again: ${c}`);

  // The mechanism under test, asserted directly: if the worker is still there
  // when the next view arrives, the state assertions below only pass or fail by
  // luck of timing.
  if (!diedAfterA) failures.push('the worker was still alive after its last viewer left');
  if (!diedAfterB) failures.push('the second worker outlived its last viewer');

  // `down` then `enter` from the initial focus is the correct pairing: the
  // dialog's options are [exit, continue] and index 0 is focused, so the second
  // option is the one Enter should reach after one Down.
  if (!a.includes('onContinue')) {
    failures.push(`A should be onContinue (Down then Enter), got ${a}`);
  }
  for (const [label, result] of [['B', b], ['C', c]] as const) {
    if (!result.includes('onExit')) {
      failures.push(
        `${label} should be onExit: a bare Enter means the worker was respawned with fresh ` +
          `state. Got ${result}, which means state survived the disconnect.`,
      );
    }
  }

  // Each connection was served by a distinct worker, and that is not a separate
  // claim needing its own probe: A's worker was gone before B connected and B's
  // was gone before C did, which is exactly what `diedAfterA` and `diedAfterB`
  // above assert. What is left is the same property for C, the one view that was
  // not followed by a wait. Without this, a worker surviving its last viewer
  // would be caught only on the next view, where it would look like the state bug
  // this probe exists to rule out.
  const diedAfterC = await waitForNoWorkers();
  if (!diedAfterC) {
    failures.push('the third worker was still alive after its last viewer left');
  }

  // Read again after the wait rather than printing the poll's last result, and
  // assert what is printed: a count that is only printed is how this file
  // previously reported a property it never checked.
  const health = (await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()) as {
    workers: Array<{ name: string; status: string; subscribers: number }>;
  };
  console.log(`workers still registered after all three views: ${health.workers.length}`);
  if (health.workers.length !== 0) {
    failures.push(
      `${health.workers.length} worker(s) still registered with no viewer: ` +
        health.workers.map(w => `${w.name} (${w.status}, ${w.subscribers} subscriber(s))`).join(', '),
    );
  }
} catch (error) {
  failures.push(String(error));
} finally {
  server.kill();
}

if (failures.length > 0) {
  console.error('\n' + failures.map(f => `FAIL: ${f}`).join('\n'));
  process.exit(1);
}
console.log('\nPASS: a worker dies with its last viewer, so every view starts fresh.');
