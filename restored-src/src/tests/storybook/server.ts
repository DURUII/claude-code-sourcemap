/**
 * The gallery server: static client, story list, and one worker per story.
 *
 *   bun run src/tests/storybook/server.ts  →  http://localhost:6006
 *
 * This is a dev-time viewer, not the product's `claude server` command. It
 * serves no sessions and reads no user state: every story mocks its own data, and
 * each worker gets a throwaway CLAUDE_CONFIG_DIR so config reads cannot reach the
 * real ~/.claude. It binds to loopback only, because the gallery can drive real
 * components and nothing about that belongs on a network.
 *
 * Process model, which is the whole design:
 *
 *   browser ── WS ──► server ── stdio ──► worker (one per story) ──► Ink
 *
 * A worker per story is required rather than merely tidy. `mock.module` is
 * process-global and only affects modules imported after it runs, so two stories
 * with different mock sets cannot share a process without one contaminating the
 * other, and a story that throws must not take the gallery with it.
 *
 * A worker lives only as long as somebody is watching it: when its last socket
 * closes, it is killed. Reuse was tried and rejected on evidence. A persistent
 * worker keeps its component state, so state leaks from one view to the next:
 * with a worker left holding focus on index 1, `Enter` alone fired `onContinue`,
 * while the same keystroke on a fresh worker fired `onExit`
 * (src/tests/storybook/probe-worker-lifetime.tsx is that experiment). Reloading
 * the page then showed the leftovers of your own last interaction rather than
 * the dialog's initial state, which is the one thing this gallery exists to
 * show. Respawning costs a few hundred milliseconds and buys a predictable view.
 *
 * Three deliberate departures from the plan:
 *
 *   No second frame coalescer. The plan put one here, but the worker already
 *   throttles to ~30fps and keeps only the newest frame, so a server-side pass
 *   would add latency without reducing traffic for one local client. The worker's
 *   `seq` gaps are the honest measure of what it drops.
 *
 *   No idle-worker eviction policy. Killing on last disconnect covers a viewer
 *   that closes its tab, and a worker is only spawned when a socket asks for its
 *   story, so there is no pool to size: the manifest's 35 entries are not 35
 *   processes. The one request that could outlive its viewer without upgrading is
 *   handled at the /ws route.
 *
 *   No pool cap. Nothing to cap once workers are per-view.
 */
// `mkdtempSync`, not the async form: the worker's environment has to be complete
// before `Bun.spawn` is called, and there is nothing to overlap while awaiting a
// temp dir.
import { mkdtempSync } from 'fs';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { STORIES, findStory } from './stories/manifest.js';
import type { FramePayload } from './frame-payload.js';

const PORT = Number(process.env.SB_PORT ?? process.env.PORT ?? 6006);
const HOST = process.env.SB_HOST ?? '127.0.0.1';
const HERE = import.meta.dir;
const WORKER_PATH = join(HERE, 'worker.tsx');

type WorkerStatus = 'starting' | 'ready' | 'exited';

/** Per-connection state Bun hands back as `ws.data`. */
type ClientData = { story: string };

type WorkerHandle = {
  readonly name: string;
  /** Incremented on every respawn; the client uses it to discard stale state. */
  readonly generation: number;
  readonly proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
  readonly configDir: string;
  status: WorkerStatus;
  /** Buffered so a client connecting late still gets a picture immediately. */
  latestFrame?: FramePayload;
  readonly subscribers: Set<Bun.ServerWebSocket<ClientData>>;
};

const workers = new Map<string, WorkerHandle>();
/** Bumped per story so a respawn is distinguishable from a lost frame. */
const generations = new Map<string, number>();
let shuttingDown = false;

/**
 * The client's TypeScript modules, by the URL the browser asks for them under.
 * Both are imported directly by the probes, which is why they are not `.js`.
 */
const TRANSPILED = new Map([
  ['/keys.js', 'keys.ts'],
  ['/frame-layout.js', 'frame-layout.ts'],
]);

/** Transpiled output, memoised on first request. */
const transpiled = new Map<string, string>();

async function transpile(name: string): Promise<string> {
  const source = await Bun.file(join(HERE, name)).text();
  return new Bun.Transpiler({ loader: 'ts' }).transformSync(source);
}

function send(socket: Bun.ServerWebSocket<ClientData>, message: unknown): void {
  // `readyState` 1 is OPEN. A socket can be closing while frames are in flight,
  // and sending to it throws rather than dropping.
  if (socket.readyState !== 1) return;
  socket.send(JSON.stringify(message));
}

function broadcast(handle: WorkerHandle, message: unknown): void {
  const text = JSON.stringify(message);
  for (const socket of handle.subscribers) {
    if (socket.readyState === 1) socket.send(text);
  }
}

/**
 * Start a worker for `name`.
 *
 * `CLAUDE_CONFIG_DIR` is a fresh temp dir per worker, not per server: a story
 * that writes config must not be able to change what the next story reads.
 */
function spawnWorker(name: string): WorkerHandle {
  const generation = (generations.get(name) ?? 0) + 1;
  generations.set(name, generation);

  // Created before the spawn because the child reads it at import time.
  const configDir = mkdtempSync(join(tmpdir(), `sb-${name}-`));

  const proc = Bun.spawn([process.execPath, 'run', WORKER_PATH], {
    cwd: join(HERE, '..', '..', '..'),
    env: {
      ...process.env,
      SB_STORY: name,
      SB_GENERATION: String(generation),
      // Both are read at import time by libraries the worker imports, so they
      // must be in the spawn environment rather than assigned in the worker.
      FORCE_COLOR: '3',
      FORCE_HYPERLINK: '1',
      CLAUDE_CONFIG_DIR: configDir,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const handle: WorkerHandle = {
    name,
    generation,
    proc,
    configDir,
    status: 'starting',
    subscribers: new Set(),
  };

  // Supervises this worker for its whole life. Not awaited by anyone: it is the
  // only thing watching an unsupervised child, so it has to outlive the caller
  // and must not reject into nowhere.
  void (async () => {
    await readLines(proc.stdout, line => handleWorkerLine(handle, line));
    const code = await proc.exited;
    handle.status = 'exited';
    // stderr is drained after stdout closes so a crash's message is not lost;
    // it is usually the only explanation there is.
    const err = await new Response(proc.stderr).text();
    // A restarted worker's handle has already had its subscribers moved to the
    // replacement, so this broadcast reaches nobody, which is what we want.
    if (!shuttingDown) {
      broadcast(handle, {
        type: 'status',
        status: 'exited',
        code,
        stderr: err.trim() || undefined,
      });
    }
    // Only evict if this handle is still the current one, so the cleanup of a
    // restarted worker cannot drop its replacement from the map.
    if (workers.get(name) === handle) workers.delete(name);
    await rm(configDir, { recursive: true, force: true }).catch(() => {});
  })().catch(error => {
    broadcast(handle, {
      type: 'log',
      level: 'error',
      text: `supervisor for ${name} failed: ${String(error)}`,
    });
  });

  workers.set(name, handle);
  return handle;
}

/** Decode a byte stream into newline-delimited lines, ignoring a partial tail. */
async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onLine(line);
    }
  }
}

function handleWorkerLine(handle: WorkerHandle, line: string): void {
  let message: { type?: string; [k: string]: unknown };
  try {
    message = JSON.parse(line);
  } catch {
    // The worker writes only JSON to stdout, so this means a story printed
    // something that escaped the console patch. Surface it rather than hide it.
    broadcast(handle, { type: 'log', level: 'error', text: `non-JSON from worker: ${line}` });
    return;
  }

  switch (message.type) {
    case 'ready':
      handle.status = 'ready';
      broadcast(handle, {
        type: 'status',
        status: 'ready',
        generation: handle.generation,
        columns: message.columns,
        rows: message.rows,
      });
      break;
    case 'frame': {
      const payload = message.payload as FramePayload;
      handle.latestFrame = payload;
      broadcast(handle, { type: 'frame', payload });
      break;
    }
    case 'log':
      broadcast(handle, { type: 'log', level: message.level, text: message.text });
      break;
    case 'error':
      // A protocol error (bad env, unknown story) or a mount failure. The worker
      // exits after this, so the exit handler reports the status.
      broadcast(handle, {
        type: 'status',
        status: 'failed',
        message: message.message,
        stack: message.stack,
      });
      break;
    default:
      broadcast(handle, { type: 'log', level: 'warn', text: `unknown worker message ${message.type}` });
  }
}

function sendToWorker(handle: WorkerHandle, message: unknown): void {
  if (handle.status === 'exited') return;
  try {
    handle.proc.stdin.write(JSON.stringify(message) + '\n');
    handle.proc.stdin.flush();
  } catch (error) {
    // Writing to a dead worker's stdin throws. The exit handler is the place
    // that reports the death, so this only has to not crash the server.
    broadcast(handle, {
      type: 'log',
      level: 'warn',
      text: `could not reach worker ${handle.name}: ${String(error)}`,
    });
  }
}

const server = Bun.serve<ClientData>({
  port: PORT,
  hostname: HOST,

  async fetch(request, srv) {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      const name = url.searchParams.get('story') ?? '';
      const meta = findStory(name);
      if (!meta) return new Response(`unknown story ${JSON.stringify(name)}`, { status: 404 });

      // The worker is spawned before the upgrade is attempted, because the
      // `open` handler answers from the handle. That order is only safe if a
      // failed upgrade undoes the spawn: a request that never upgrades has no
      // socket to attach, so it never reaches the last-socket-close path that is
      // the only thing here that kills a worker, and a bare GET of this route
      // would leave a process running for good. Observed before this guard: a
      // GET left a worker listed in /health as ready with 0 subscribers, still
      // there minutes later.
      //
      // Only the request that created the worker tears it down, so a concurrent
      // upgrade that really will connect is never mistaken for a failed one.
      const spawned = !workers.has(name);
      const handle = spawned ? spawnWorker(name) : workers.get(name)!;
      if (srv.upgrade(request, { data: { story: name } })) return undefined;
      if (spawned) {
        // Identity-checked, like the supervisor's eviction at :175. Every step
        // between the `has` test above and here is synchronous, so this can only
        // be the handle this request created and the guard never skips the delete
        // today. It is written this way because one `await` added to `spawnWorker`
        // would break that: two requests would both read `spawned`, both spawn, and
        // the second `set` would overwrite the first's map entry. An unguarded
        // delete would then remove whichever handle the map holds, which by then is
        // the other request's, the one whose upgrade succeeded, leaving that worker
        // running with no map entry and its viewer unable to reach anything. The
        // guard is what keeps an upgrade that failed from evicting the request that
        // is about to connect.
        if (workers.get(name) === handle) workers.delete(name);
        handle.proc.kill();
      }
      // `upgrade` returns a boolean, `true` when the socket was taken over
      // (bun-types/serve.d.ts:976), so falling through here means the request was
      // not a valid upgrade and there is no socket to attach a viewer to.
      return new Response('websocket upgrade failed', { status: 400 });
    }

    if (url.pathname === '/api/stories') {
      return Response.json({ stories: STORIES });
    }

    if (url.pathname === '/health') {
      return Response.json({
        ok: true,
        workers: [...workers.values()].map(w => ({
          name: w.name,
          status: w.status,
          generation: w.generation,
          subscribers: w.subscribers.size,
        })),
      });
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(Bun.file(join(HERE, 'client.html')));
    }
    if (url.pathname === '/client.js') {
      return new Response(Bun.file(join(HERE, 'client.js')), {
        headers: { 'content-type': 'text/javascript; charset=utf-8' },
      });
    }
    if (TRANSPILED.has(url.pathname)) {
      // These two are TypeScript so that the probes can import the same code the
      // browser runs; the browser cannot read types, so it gets the transpiled
      // form. Transpiled once and cached: both are static for the server's
      // lifetime, and this is on the path to the first paint.
      const name = TRANSPILED.get(url.pathname)!;
      let code = transpiled.get(name);
      if (code === undefined) {
        code = await transpile(name);
        transpiled.set(name, code);
      }
      return new Response(code, {
        headers: { 'content-type': 'text/javascript; charset=utf-8' },
      });
    }

    return new Response('not found', { status: 404 });
  },

  websocket: {
    open(socket) {
      const name = socket.data.story;
      const handle = workers.get(name);
      if (!handle) {
        send(socket, { type: 'status', status: 'failed', message: 'worker vanished' });
        return;
      }
      handle.subscribers.add(socket);

      // The manifest size is only a default: the browser overrides it with the
      // width it actually has, so tell it what that default was and let it
      // decide. `generation` is sent up front so a client cannot mistake a
      // respawn for a continuation.
      const meta = findStory(name)!;
      send(socket, {
        type: 'hello',
        story: name,
        title: meta.title,
        generation: handle.generation,
        columns: meta.columns,
        rows: meta.rows,
        launcher: meta.launcher,
        description: meta.description,
        missingPath: meta.missingPath,
      });
      send(socket, { type: 'status', status: handle.status });
      if (handle.latestFrame) send(socket, { type: 'frame', payload: handle.latestFrame });
    },

    message(socket, raw) {
      const handle = workers.get(socket.data.story);
      if (!handle) return;

      let command: { type?: string; data?: string; columns?: number; rows?: number };
      try {
        command = JSON.parse(String(raw));
      } catch {
        send(socket, { type: 'log', level: 'warn', text: `bad client message ${String(raw)}` });
        return;
      }

      switch (command.type) {
        case 'key':
          sendToWorker(handle, { type: 'key', data: command.data ?? '' });
          break;
        case 'resize':
          sendToWorker(handle, { type: 'resize', columns: command.columns, rows: command.rows });
          break;
        case 'repaint':
          sendToWorker(handle, { type: 'repaint' });
          break;
        case 'restart': {
          // Explicit rather than automatic: a story that crashes on mount would
          // otherwise be respawned in a loop, which hides the crash instead of
          // showing it. The client offers a button.
          if (handle.status !== 'exited') {
            handle.proc.kill();
          }
          const next = spawnWorker(handle.name);
          // Hand the viewers over, then empty the old set so its own exit
          // broadcast cannot reach them and tell them the *new* worker died.
          const viewers = [...handle.subscribers];
          handle.subscribers.clear();
          for (const client of viewers) next.subscribers.add(client);

          const meta = findStory(next.name)!;
          broadcast(next, {
            type: 'status',
            status: 'starting',
            generation: next.generation,
            columns: meta.columns,
            rows: meta.rows,
          });
          break;
        }
        default:
          send(socket, { type: 'log', level: 'warn', text: `unknown command ${command.type}` });
      }
    },

    close(socket) {
      const handle = workers.get(socket.data.story);
      if (!handle) return;
      handle.subscribers.delete(socket);
      if (handle.subscribers.size > 0 || handle.status === 'exited') return;

      // Last viewer gone: stop the worker so the next view starts from the
      // story's initial state rather than this one's leftovers.
      //
      // Evicted from the map here, synchronously, rather than leaving it to the
      // supervisor. A kill takes a moment to be observed, and a handle left in
      // the map during that window is handed to the next connection: it still
      // reports `status: 'ready'` and still holds a `latestFrame`, so the new
      // viewer gets a plausible-looking screen and then has every keystroke
      // written to a dead process. Observed as a story that painted once and
      // then ignored Enter.
      workers.delete(handle.name);
      handle.proc.kill();
      // The supervisor still cleans up the temp dir; its own map eviction is a
      // no-op now because the entry is already gone.
    },
  },
});

console.log(`Ink gallery on http://${HOST}:${server.port}`);
console.log(`  stories: ${STORIES.map(s => s.name).join(', ')}`);
console.log('  one worker per story, spawned on first view');

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal}: stopping ${workers.size} worker(s)`);
  for (const handle of workers.values()) {
    if (handle.status !== 'exited') handle.proc.kill();
    await rm(handle.configDir, { recursive: true, force: true }).catch(() => {});
  }
  // `stop(true)` closes active connections too; without it a browser holding a
  // socket would keep the process alive.
  await server.stop(true);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
