/**
 * Two questions at once:
 *  A. Can one bun process host several Ink instances concurrently?
 *     (instances.ts keys its registry by stdout stream, so it should)
 *  B. What SGR sequences does the theme actually emit? That sets the scope of
 *     the ANSI -> HTML conversion the gallery needs.
 *
 *   FORCE_COLOR=3 bun run src/tests/storybook/probe-multi.tsx
 *
 * A and B are asserted. Section C, the non-SGR control sequences, is a
 * measurement and deliberately not a verdict: those sequences never reach the
 * browser, because the gallery ships a structural cell grid over the socket
 * rather than raw ANSI, so `plain()` in harness.tsx is the only consumer. C is
 * printed so the list is on record if the frame protocol is ever revisited.
 */
import { Readable, Writable } from 'stream';
import React from 'react';
import chalk from 'chalk';
import { enableConfigs } from '../../utils/config.js';
import { render, Box, Text } from '../../ink.js';
import { AppStateProvider } from '../../state/AppState.js';
import { onChangeAppState } from '../../state/onChangeAppState.js';
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js';
import { InvalidSettingsDialog } from '../../components/InvalidSettingsDialog.js';
import { TeleportRepoMismatchDialog } from '../../components/TeleportRepoMismatchDialog.js';
import { plain } from './harness.js';

enableConfigs();

// Without the flag chalk sits at level 0 in a pipe and the theme emits no SGR at
// all, which does not make the colour checks below fail so much as make them
// unreachable: the theme would still be correct and the non-vacuity check would
// blame it. Same guard, same reason, as check-mount.tsx and check-ansi-to-css.ts.
if (chalk.level === 0) {
  console.error('chalk.level is 0, so the theme emits no SGR and section B cannot be checked.');
  console.error('Re-run with FORCE_COLOR=3.');
  process.exit(1);
}

const DOWN = '\x1b[B';

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
  isTTY = false;
  buf = '';
  _write(c: Buffer, _e: string, cb: () => void): void { this.buf += c.toString(); cb(); }
}

const failures: string[] = [];

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)}` +
      (ok ? '' : ` (expected ${JSON.stringify(expected)})`),
  );
  if (!ok) {
    failures.push(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}

const mount = (node: React.ReactNode) => {
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  return { stdout, stdin, p: render(
    <AppStateProvider onChangeAppState={onChangeAppState}>
      <KeybindingSetup>{node}</KeybindingSetup>
    </AppStateProvider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  ) };
};

/** The first line of the most recent full frame. */
const tailOf = (s: FakeStdout) =>
  plain(s.buf.split('\x1b[?2026h').pop()!.split('\x1b[?2026l')[0]!).trim().split('\n')[0];

/** The whole of the most recent full frame, which is what a state change moves. */
const lastFrame = (s: FakeStdout) =>
  plain(s.buf.split('\x1b[?2026h').pop()!.split('\x1b[?2026l')[0]!);

// --- A: mount three at once, then unmount one and confirm the others survive ---
const a = mount(<InvalidSettingsDialog
  settingsErrors={[{ file: 'a.json', path: 'x.y', message: 'boom' }] as never}
  onContinue={() => {}} onExit={() => {}} />);
const b = mount(<TeleportRepoMismatchDialog targetRepo="anthropics/claude-code"
  initialPaths={['/tmp/one']} onSelectPath={() => {}} onCancel={() => {}} />);
const c = mount(<Box flexDirection="column"><Text color="error">error</Text><Text color="success">success</Text></Box>);

await new Promise(r => setTimeout(r, 400));

console.log('A. three concurrent instances');
console.log('   story1:', tailOf(a.stdout));
console.log('   story2:', tailOf(b.stdout));
console.log('   story3:', tailOf(c.stdout));
const frames = { story1: lastFrame(a.stdout), story2: lastFrame(b.stdout), story3: lastFrame(c.stdout) };
check('all three instances painted', Object.values(frames).map(f => f.trim().length > 0), [true, true, true]);
// Identity, not resemblance: each buffer must hold the content of the component
// mounted on that buffer, and story2 must hold the prop it alone was given.
// Comparing the three buffers to each other would have been a weak proxy, since
// the first line of both dialogs is the same full-width border, so two different
// screens can agree line by line at the top.
check('story1 holds its own component text', frames.story1.includes('Settings Error'), true);
check(
  'story2 holds its own component text, including the targetRepo it was given',
  frames.story2.includes('anthropics/claude-code'),
  true,
);
check(
  'story3 holds its own component text',
  frames.story3.includes('error') && frames.story3.includes('success'),
  true,
);

(await a.p).unmount();
await new Promise(r => setTimeout(r, 150));

// The claim is that unmounting one instance does not disturb another. Reading
// the buffer here would prove nothing: the last full frame in it was written
// before the unmount, so it reads the same whether story2 kept painting or froze
// at that instant. An earlier version of this probe did exactly that and printed
// it as evidence. The test has to provoke a repaint and watch for it.
const beforeKey = lastFrame(b.stdout);
b.stdin.push(DOWN);
await new Promise(r => setTimeout(r, 300));
const afterKey = lastFrame(b.stdout);
check('story2 still repaints on a keystroke after story1 is unmounted', beforeKey !== afterKey, true);
console.log(`   story2 after a keystroke: ${afterKey.trim().split('\n')[0]?.slice(0, 60)}`);

// --- B: which SGR sequences appear in a full-themed frame ---
const all = a.stdout.buf + b.stdout.buf + c.stdout.buf;
const codes = new Set<string>();
for (const m of all.matchAll(/\x1b\[([0-9;]*)m/g)) codes.add(m[0]);
console.log('\nB. distinct SGR sequences emitted:', codes.size);
console.log('   ', [...codes].sort().map(s => JSON.stringify(s)).join(' '));

/**
 * The SGR surface the gallery's ANSI -> CSS conversion claims to cover, written
 * out by hand rather than imported from ansi-to-css.ts. An expectation derived
 * from the code under test cannot fail, and what this section is for is saying
 * what the theme actually emits, independently of what the converter handles.
 */
const SIMPLE_SGR = new Set([
  '1', '2', '3', '4', '7', '9', // bold, dim, italic, underline, inverse, strike
  '22', '23', '24', '27', '29', // the matching off codes
  '39', '49', // default foreground and background
]);

const unexpected: string[] = [];
let extendedFg = 0;
let paletteFg = 0;
for (const code of codes) {
  const params = code.slice(2, -1).split(';');
  if (params[0] === '38' || params[0] === '48') {
    const mode = params[1];
    if (mode === '2') extendedFg++;
    else if (mode === '5') paletteFg++;
    else unexpected.push(code);
    continue;
  }
  if (params.length !== 1 || !SIMPLE_SGR.has(params[0]!)) unexpected.push(code);
}
check('every emitted SGR is inside the documented closed set', unexpected, []);
check('the theme uses 24-bit colour and never the 16 or 256 colour palette', paletteFg, 0);
check('it emitted 24-bit colour at all, so the line above is not vacuous', extendedFg > 0, true);

// --- C: measured, not asserted. See the header. ---
const other = new Set<string>();
for (const m of all.matchAll(/\x1b\[[0-9;?>=]*[A-Za-z]/g)) if (!/m$/.test(m[0])) other.add(m[0]);
console.log('\nC. distinct non-SGR CSI sequences (measurement, not a verdict):', other.size);
console.log('   ', [...other].sort().map(s => JSON.stringify(s.replace('\x1b', 'ESC'))).join(' '));

(await b.p).unmount(); (await c.p).unmount();

console.log();
if (failures.length > 0) {
  for (const reason of failures) console.error(`FAIL ${reason}`);
  process.exit(1);
}
console.log('Concurrent instances are independent, and the theme stays inside the conversion scope.');
process.exit(0);
