/**
 * Can we drive a mounted dialog with the browser's keymap?
 *
 * Two layers are checked together here:
 *
 *   keys.ts        key event -> terminal bytes   (probe-keymap.tsx checks this
 *                                                 against the parser)
 *   this file      those bytes -> a real mounted component's callbacks
 *
 * The bytes are taken from `keyToBytes` rather than written as literals, so this
 * is the end-to-end half: if the table and the components ever disagree about a
 * key, one of the two probes fails. Hardcoding `\x1b[B` here would have tested
 * Ink and left the client's table unchecked.
 *
 * `Escape` is worth its own phase. It is the one key the tokenizer holds until
 * it gives up on a longer sequence (see probe-keymap.tsx), so it is the one key
 * whose delivery depends on a timer rather than on the bytes alone.
 *
 * Run: bun run src/tests/storybook/probe-keys.tsx
 */
import { Readable, Writable } from 'stream';
import React from 'react';
import { enableConfigs } from '../../utils/config.js';
import { render } from '../../ink.js';
import { AppStateProvider } from '../../state/AppState.js';
import { onChangeAppState } from '../../state/onChangeAppState.js';
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js';
import { InvalidSettingsDialog } from '../../components/InvalidSettingsDialog.js';
import { plain } from './harness.js';
import { keyToBytes, type KeyEventLike } from './keys.js';

enableConfigs();

class FakeStdin extends Readable {
  isTTY = true;
  _read(): void {}
  setRawMode(): this { return this; }
  ref(): this { return this; }
  unref(): this { return this; }
}

class FakeStdout extends Writable {
  columns = 96;
  rows = 40;
  isTTY = false; // full frames, so the newest chunk is always the whole screen
  buf = '';
  _write(c: Buffer, _e: string, cb: () => void): void { this.buf += c.toString(); cb(); }
}

/**
 * A key event for a bare key press. Only `key` is ever varied, because that is
 * all the components can observe: the modifiers a person is holding are already
 * baked into `event.key` by the browser for printable characters.
 */
function press(key: string): string {
  const event: KeyEventLike = { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
  const bytes = keyToBytes(event);
  if (bytes === null) throw new Error(`${key} is not forwarded, so this probe cannot use it`);
  return bytes;
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

/** The row the `❯` marker is on, which is how a Select shows its focus. */
async function focusLine(stdout: FakeStdout): Promise<string> {
  await wait(250);
  const last = stdout.buf.split('\x1b[?2026h').pop()!.split('\x1b[?2026l')[0]!;
  return plain(last).split('\n').find(l => l.includes('❯'))?.trim() ?? '(no focus marker)';
}

async function mountDialog() {
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  const picked: string[] = [];
  const root = await render(
    <AppStateProvider onChangeAppState={onChangeAppState}>
      <KeybindingSetup>
        <InvalidSettingsDialog
          settingsErrors={[{ file: 'a.json', path: 'x.y', message: 'boom' }] as never}
          onContinue={() => picked.push('continue')}
          onExit={() => picked.push('exit')}
        />
      </KeybindingSetup>
    </AppStateProvider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  return { stdout, stdin, picked, root };
}

const failures: string[] = [];

// ---------------------------------------------------------------------------
// Arrow + Enter, with the bytes coming from the client's table
// ---------------------------------------------------------------------------

const first = await mountDialog();

const atStart = await focusLine(first.stdout);
console.log(`initial            -> ${atStart}`);

first.stdin.push(press('ArrowDown'));
const afterDown = await focusLine(first.stdout);
console.log(`after ArrowDown    -> ${afterDown}`);
if (afterDown === atStart) failures.push('ArrowDown did not move the focus marker');

first.stdin.push(press('Enter'));
await wait(250);
console.log(`after Enter        -> callbacks ${JSON.stringify(first.picked)}`);
if (first.picked.join(',') !== 'continue') {
  failures.push(`ArrowDown then Enter should fire onContinue, got ${JSON.stringify(first.picked)}`);
}

await first.root.unmount();

// ---------------------------------------------------------------------------
// Escape, which the tokenizer holds until it is flushed
// ---------------------------------------------------------------------------

const second = await mountDialog();
second.stdin.push(press('Escape'));
await wait(400);
console.log(`fresh mount+Escape -> callbacks ${JSON.stringify(second.picked)}`);
// The dialog passes onExit as Dialog's onCancel, so Escape is the exit path.
if (second.picked.join(',') !== 'exit') {
  failures.push(`Escape should fire onExit, got ${JSON.stringify(second.picked)}`);
}
await second.root.unmount();

if (failures.length > 0) {
  console.error('\n' + failures.map(f => `FAIL: ${f}`).join('\n'));
  process.exit(1);
}
console.log('\nPASS: the browser keymap drives a real dialog.');
process.exit(0);
