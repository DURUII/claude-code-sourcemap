/**
 * Minimal "Ink storybook" harness.
 *
 * There is no Storybook in this repo, and none is possible: every one of these
 * dialogs is a React Ink terminal component, not DOM. This stands in for it —
 * it mounts the same <AppStateProvider><KeybindingSetup> wrapper that
 * showSetupDialog uses in the real app, captures the frames Ink writes, and
 * returns the last painted one as text.
 */
import { Readable, Writable } from 'stream';
import React from 'react';
import { render } from '../../ink.js';
import { AppStateProvider } from '../../state/AppState.js';
import { onChangeAppState } from '../../state/onChangeAppState.js';
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js';
import { LogUpdate } from '../../ink/log-update.js';
import instances from '../../ink/instances.js';
import type { Frame } from '../../ink/frame.js';
import type { StylePool } from '../../ink/screen.js';

/**
 * The app probes the terminal before its first paint (src/ink/terminal-querier.ts)
 * and blocks until DA1 (`ESC [ c`) is answered. A silent fake terminal means no
 * frame is ever drawn, so we answer the sentinel and let other queries resolve
 * as "unsupported".
 */
const DA1 = '\x1b[c';

class FakeStdin extends Readable {
  isTTY = true;
  _read(): void {}
  setRawMode(): this { return this; }
  ref(): this { return this; }
  unref(): this { return this; }
  feed(data: string): void {
    this.push(data);
  }
}

class FakeStdout extends Writable {
  columns: number;
  rows = 40;
  isTTY = true;
  chunks: string[] = [];
  onQuery: (chunk: string) => void = () => {};
  constructor(columns = 100) {
    super();
    this.columns = columns;
  }
  _write(chunk: Buffer, _enc: string, cb: () => void): void {
    const text = chunk.toString();
    this.chunks.push(text);
    if (text.includes(DA1)) this.onQuery(DA1);
    cb();
  }
  get raw(): string {
    return this.chunks.join('');
  }
}

/** Render `node`, let effects settle, and return every frame Ink painted. */
export async function snapshotFrames(
  node: React.ReactNode,
  opts: { columns?: number; settleMs?: number; tty?: boolean } = {},
): Promise<string[]> {
  const stdout = new FakeStdout(opts.columns ?? 100);
  // isTTY=false makes Ink's LogUpdate repaint the whole frame instead of a
  // cell diff, so the last frame is the complete screen rather than a patch.
  stdout.isTTY = opts.tty ?? true;
  const stdin = new FakeStdin();
  stdout.onQuery = req => {
    if (req === DA1) stdin.feed('\x1b[?1;2c');
  };
  const instance = await render(
    <AppStateProvider onChangeAppState={onChangeAppState}>
      <KeybindingSetup>{node}</KeybindingSetup>
    </AppStateProvider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  await new Promise(r => setTimeout(r, opts.settleMs ?? 200));
  instance.unmount();
  await new Promise(r => setTimeout(r, 50));
  instance.cleanup();
  // Ink brackets each frame in DEC 2026 (BSU/ESU) when the terminal supports it.
  return stdout.raw
    .split('\x1b[?2026h')
    .slice(1)
    .map(s => s.split('\x1b[?2026l')[0] ?? '');
}

/** The last frame that actually painted something (unmount paints an empty one). */
export async function snapshot(
  node: React.ReactNode,
  opts: { columns?: number; settleMs?: number; tty?: boolean } = {},
): Promise<string> {
  const frames = await snapshotFrames(node, opts);
  for (let i = frames.length - 1; i >= 0; i--) {
    if (plain(frames[i]).trim()) return frames[i];
  }
  return '';
}

// ---------------------------------------------------------------------------
// Live mounting, for the interactive gallery
// ---------------------------------------------------------------------------

type FrameSink = (frame: Frame, stylePool: StylePool) => void;

/**
 * The parts of the live `Ink` instance this harness needs.
 *
 * `stylePool` and `handleResize` are both private in TypeScript but present at
 * runtime (src/ink/ink.tsx:89,309), and `render()` returns a `Root` rather than
 * the instance, so they are reached through the registry Ink keys by stdout
 * (src/ink/instances.ts).
 */
type InkHandle = {
  stylePool?: StylePool;
  handleResize?: () => void;
  options?: { stdout: { columns: number; rows: number } };
};

/**
 * Frames are routed by the Ink instance's own `StylePool`, which is created per
 * instance (src/ink/ink.tsx:193) and therefore uniquely identifies one mounted
 * story. `LogUpdate`'s options carry it as `stylePool`, which is the only
 * per-instance handle reachable from a prototype patch.
 *
 * Both maps are weak so an unmounted story's frames are collectable.
 */
const latestFrameByPool = new WeakMap<StylePool, Frame>();
const frameSinkByPool = new WeakMap<StylePool, FrameSink>();

let logUpdatePatched = false;

/**
 * Wrap `LogUpdate.prototype.render` once per process so every painted frame
 * becomes observable.
 *
 * The recording is unconditional and happens before any sink exists. That
 * ordering is the point: `StylePool` is not reachable until after `render()`
 * has returned the Ink instance, so a story whose only paint is the very first
 * frame (every static dialog) would otherwise show up blank. A late-arriving
 * sink replays the recorded frame instead of waiting for a repaint that may
 * never come.
 */
function ensureLogUpdatePatched(): void {
  if (logUpdatePatched) return;
  const real = LogUpdate.prototype.render;
  LogUpdate.prototype.render = function (
    this: { options: { stylePool: StylePool } },
    prev: Frame,
    next: Frame,
    ...rest: unknown[]
  ) {
    const pool = this.options.stylePool;
    latestFrameByPool.set(pool, next);
    frameSinkByPool.get(pool)?.(next, pool);
    return real.call(this as never, prev, next, ...rest);
  } as typeof real;
  logUpdatePatched = true;
}

/** A mounted story that stays alive, so the browser can keep driving it. */
export type MountedStory = {
  readonly columns: number;
  readonly rows: number;
  /** Feed exactly one keystroke. See the one-key-per-push rule below. */
  push(data: string): void;
  /** The most recent frame, or undefined if nothing has painted yet. */
  latest(): Frame | undefined;
  /** The style pool, for serializing frames with `serializeFrame`. */
  stylePool(): StylePool;
  /**
   * Resize in place, preserving component state.
   *
   * Ink only subscribes to the stream's `'resize'` event when stdout is a TTY
   * (src/ink/ink.tsx:226), so a non-TTY story has to call `handleResize`
   * directly. Doing that rather than remounting is not an optimisation: a
   * remount discards exactly the state the gallery exists to let you drive
   * (`Select` focus, typed query, scroll offset), so resizing a browser window
   * would silently reset the story. Measured in
   * src/tests/storybook/probe-resize.tsx, where focus survives the resize.
   *
   * The repaint is asynchronous, so callers that need the new frame should wait
   * for the next `onFrame` rather than assuming this call produced one.
   */
  resize(columns: number, rows: number): void;
  unmount(): Promise<void>;
};

/**
 * Mount `node` and keep it mounted, reporting every frame it paints.
 *
 * Unlike `snapshot()`, which mounts, settles, and tears down, this returns a
 * live handle. The story runs in the same wrapper `showSetupDialog` uses
 * (src/interactiveHelpers.tsx:86), so what the gallery shows is what the app
 * renders.
 *
 * The stdout stream is deliberately NOT a TTY. `LogUpdate.render` short-circuits
 * to `renderFullFrame` in that case (src/ink/log-update.ts:129), so every paint
 * is a complete screen and the browser can replace its grid wholesale instead of
 * replaying a cell diff it has no way to reconstruct. The stdin stream must
 * still report `isTTY`, because `App.handleSetRawMode` throws otherwise
 * (src/ink/components/App.tsx:213-216).
 */
export async function mountStory(
  node: React.ReactNode,
  opts: {
    columns?: number;
    rows?: number;
    onFrame?: (frame: Frame, stylePool: StylePool) => void;
  } = {},
): Promise<MountedStory> {
  ensureLogUpdatePatched();

  let columns = opts.columns ?? 100;
  let rows = opts.rows ?? 40;
  let instance: Awaited<ReturnType<typeof render>> | undefined;
  let stdout: FakeStdout | undefined;
  let stdin: FakeStdin | undefined;
  let pool: StylePool | undefined;
  let ink: InkHandle | undefined;

  const start = async (): Promise<void> => {
    const out = new FakeStdout(columns);
    out.rows = rows;
    out.isTTY = false; // full frames; see the note above
    const input = new FakeStdin();
    // Even in full-frame mode the app may still probe the terminal before its
    // first paint, so keep answering DA1.
    out.onQuery = req => {
      if (req === DA1) input.feed('\x1b[?1;2c');
    };

    const mounted = await render(
      <AppStateProvider onChangeAppState={onChangeAppState}>
        <KeybindingSetup>{node}</KeybindingSetup>
      </AppStateProvider>,
      {
        stdout: out as unknown as NodeJS.WriteStream,
        stdin: input as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );

    // `render()` hands back a Root (rerender/unmount/waitUntilExit/cleanup), not
    // the Ink instance, so the style pool is not on the return value. It is
    // reachable through the registry Ink keeps keyed by stdout
    // (src/ink/instances.ts), which is a handle we own because we built the
    // stream. `stylePool` is private in TS but present at runtime
    // (src/ink/ink.tsx:89,193).
    const mountedInk = instances.get(out as unknown as NodeJS.WriteStream) as unknown as
      | InkHandle
      | undefined;
    const mountedPool = mountedInk?.stylePool;
    if (!mountedPool) {
      throw new Error(
        'Ink instance did not expose stylePool, so frames cannot be routed. ' +
          'Check src/ink/instances.ts and src/ink/ink.tsx:193.',
      );
    }

    stdout = out;
    stdin = input;
    instance = mounted;
    pool = mountedPool;
    ink = mountedInk;

    if (opts.onFrame) {
      const sink: FrameSink = (frame, stylePool) => opts.onFrame!(frame, stylePool);
      frameSinkByPool.set(mountedPool, sink);
      // Replay whatever was recorded before the sink existed, so a story that
      // painted exactly once is still shown.
      const recorded = latestFrameByPool.get(mountedPool);
      if (recorded) sink(recorded, mountedPool);
    }
  };

  const stop = async (): Promise<void> => {
    if (pool) frameSinkByPool.delete(pool);
    const current = instance;
    if (current) {
      current.unmount();
      await new Promise(r => setTimeout(r, 50));
      current.cleanup();
    }
    instance = undefined;
    stdout = undefined;
    stdin = undefined;
    pool = undefined;
    ink = undefined;
  };

  await start();

  return {
    get columns() {
      return columns;
    },
    get rows() {
      return rows;
    },
    push(data: string) {
      stdin?.feed(data);
    },
    latest() {
      return pool ? latestFrameByPool.get(pool) : undefined;
    },
    stylePool() {
      if (!pool) throw new Error('story is not mounted');
      return pool;
    },
    resize(nextColumns: number, nextRows: number) {
      columns = nextColumns;
      rows = nextRows;
      const out = stdout;
      const live = ink;
      if (!out || !live) throw new Error('cannot resize a story that is not mounted');

      // `handleResize` reads the dimensions back off the stream, so the stream
      // is the source of truth and must be updated first (src/ink/ink.tsx:310).
      out.columns = nextColumns;
      out.rows = nextRows;
      if (typeof live.handleResize === 'function') live.handleResize();
    },
    unmount: stop,
  };
}

/**
 * Turn an Ink frame into readable text: absolute cursor-forward moves become
 * spaces, everything else terminal-control is dropped.
 *
 * Pass `{ keepColor: true }` to retain SGR sequences so the frame prints in
 * colour in a real terminal, which is how you actually see the theme.
 */
export function plain(frame: string, opts: { keepColor?: boolean } = {}): string {
  return (
    frame
      // Cursor-forward moves are how Ink writes runs of spaces.
      .replace(/\x1b\[(\d*)C/g, (_, n: string) => ' '.repeat(Number(n || 1)))
      // OSC (hyperlinks, cursor colour) carries no visible layout.
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      // SGR first, so keepColor can preserve it before the generic CSI sweep.
      .replace(/\x1b\[[0-9;]*m/g, m => (opts.keepColor ? m : ''))
      .replace(/\x1b\[[0-9;?>=]*[A-Za-z]/g, '')
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+$/gm, '')
  );
}
