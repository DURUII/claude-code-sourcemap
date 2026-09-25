/**
 * Does the browser's keymap produce keys the components actually see?
 *
 * `keys.ts` is the one part of the client that can be wrong without anyone
 * noticing: a mistyped byte sequence does not throw, it just means a key does
 * nothing when you press it. So every row is checked here against the real
 * parser, through the same two stages the running app uses:
 *
 *   bytes  ->  parseMultipleKeypresses  ->  InputEvent  ->  { input, key flags }
 *
 * The middle step matters. `parseKeypress` names a key `'return'` for CR and
 * `'enter'` for LF, but the flags a component reads are computed one layer up
 * in `InputEvent` (src/ink/events/input-event.ts:27-190), and that layer also
 * decides the text input a key contributes. Asserting on the parse name alone
 * would have missed both.
 *
 * Each case lists the flags that must be *true*; every flag not listed must be
 * false, so the table is a full description rather than a lower bound. That is
 * how the two surprises in here were caught: `Escape` also sets `meta`
 * (input-event.ts:51), and `Ctrl+Space` arrives as NUL, which the parser reads
 * back as ctrl+'`' (parse-keypress.ts:723-725). Both are the app's real
 * behaviour with a real terminal, so the gallery keeps them.
 *
 * Run: bun run src/tests/storybook/probe-keymap.tsx
 */
import { keyToBytes, type KeyEventLike } from './keys.js';
import {
  INITIAL_STATE,
  parseMultipleKeypresses,
  type ParsedKey,
} from '../../ink/parse-keypress.js';
import { InputEvent, type Key } from '../../ink/events/input-event.js';

/** Every flag `Key` carries, in the order they are declared. */
const KEY_FLAGS: Array<keyof Key> = [
  'upArrow',
  'downArrow',
  'leftArrow',
  'rightArrow',
  'pageUp',
  'pageDown',
  'wheelUp',
  'wheelDown',
  'home',
  'end',
  'return',
  'escape',
  'ctrl',
  'shift',
  'fn',
  'tab',
  'backspace',
  'delete',
  'meta',
  'super',
];

type Case = {
  label: string;
  event: KeyEventLike;
  /** The bytes to send, or `null` when the key must be left to the browser. */
  bytes: string | null;
  /** Flags that must be true. Everything else must be false. */
  flags?: Array<keyof Key>;
  /** The text the component must receive. */
  input?: string;
  /**
   * Set when the tokenizer holds the sequence until it is flushed. The app
   * flushes on a timer (see App.tsx's NORMAL_TIMEOUT), so this describes a real
   * delay rather than a loss.
   */
  needsFlush?: boolean;
};

const down: KeyEventLike = { key: 'ArrowDown', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
const plain = (key: string, extra: Partial<KeyEventLike> = {}): KeyEventLike => ({ ...down, key, ...extra });

const CASES: Case[] = [
  { label: 'ArrowUp', event: plain('ArrowUp'), bytes: '\x1b[A', flags: ['upArrow'], input: '' },
  { label: 'ArrowDown', event: plain('ArrowDown'), bytes: '\x1b[B', flags: ['downArrow'], input: '' },
  { label: 'ArrowLeft', event: plain('ArrowLeft'), bytes: '\x1b[D', flags: ['leftArrow'], input: '' },
  { label: 'ArrowRight', event: plain('ArrowRight'), bytes: '\x1b[C', flags: ['rightArrow'], input: '' },
  // CR, not LF: LF parses to a name with no Key flag (parse-keypress.ts:701-705).
  { label: 'Enter', event: plain('Enter'), bytes: '\r', flags: ['return'], input: '' },
  // Held by the tokenizer as a possible sequence start until it is flushed.
  { label: 'Escape', event: plain('Escape'), bytes: '\x1b', flags: ['escape', 'meta'], input: '', needsFlush: true },
  { label: 'Tab', event: plain('Tab'), bytes: '\t', flags: ['tab'], input: '' },
  { label: 'Shift+Tab', event: plain('Tab', { shiftKey: true }), bytes: '\x1b[Z', flags: ['tab', 'shift'], input: '' },
  { label: 'Backspace', event: plain('Backspace'), bytes: '\x7f', flags: ['backspace'], input: '' },
  { label: 'Delete', event: plain('Delete'), bytes: '\x1b[3~', flags: ['delete'], input: '' },
  { label: 'PageUp', event: plain('PageUp'), bytes: '\x1b[5~', flags: ['pageUp'], input: '' },
  { label: 'PageDown', event: plain('PageDown'), bytes: '\x1b[6~', flags: ['pageDown'], input: '' },
  { label: 'Home', event: plain('Home'), bytes: '\x1b[H', flags: ['home'], input: '' },
  { label: 'End', event: plain('End'), bytes: '\x1b[F', flags: ['end'], input: '' },
  // Ctrl+letter is 0x01-0x1a, and the parser reads the letter back as input.
  { label: 'Ctrl+c', event: plain('c', { ctrlKey: true }), bytes: '\x03', flags: ['ctrl'], input: 'c' },
  { label: 'Ctrl+a', event: plain('a', { ctrlKey: true }), bytes: '\x01', flags: ['ctrl'], input: 'a' },
  { label: 'Ctrl+Space', event: plain(' ', { ctrlKey: true }), bytes: '\x00', flags: ['ctrl'], input: '`' },
  { label: 'a', event: plain('a'), bytes: 'a', flags: [], input: 'a' },
  { label: 'A (Shift)', event: plain('A', { shiftKey: true }), bytes: 'A', flags: ['shift'], input: 'A' },
  { label: '5', event: plain('5'), bytes: '5', flags: [], input: '5' },
  { label: 'Space', event: plain(' '), bytes: ' ', flags: [], input: ' ' },
  { label: '?', event: plain('?'), bytes: '?', flags: [], input: '?' },
  // Alt sends ESC first: meta for letters and digits (parse-keypress.ts:733).
  { label: 'Alt+a', event: plain('a', { altKey: true }), bytes: '\x1ba', flags: ['meta'], input: 'a' },

  // Not forwarded. The event is left alone so the browser keeps its shortcuts.
  { label: 'Cmd+R', event: plain('r', { metaKey: true }), bytes: null },
  { label: 'Cmd+ArrowDown', event: plain('ArrowDown', { metaKey: true }), bytes: null },
  { label: 'Ctrl+ArrowUp', event: plain('ArrowUp', { ctrlKey: true }), bytes: null },
  { label: 'F5', event: plain('F5'), bytes: null },
  { label: 'Unidentified', event: plain('Unidentified'), bytes: null },
];

/**
 * Send `bytes` the way the worker does, and return what a component would see.
 *
 * One push per call, because the tokenizer coalesces adjacent printable
 * characters (src/ink/termio/tokenize.ts:117-125): batching would turn "abc"
 * into one three-character keypress.
 */
function press(bytes: string): { events: InputEvent[]; neededFlush: boolean } {
  let [parsed, next] = parseMultipleKeypresses(INITIAL_STATE, bytes);
  let neededFlush = false;
  if (parsed.length === 0 && next.incomplete) {
    neededFlush = true;
    [parsed, next] = parseMultipleKeypresses(next, null);
  }
  return {
    events: parsed.filter((p): p is ParsedKey => p.kind === 'key').map(k => new InputEvent(k)),
    neededFlush,
  };
}

const failures: string[] = [];

for (const testCase of CASES) {
  const bytes = keyToBytes(testCase.event);
  if (bytes !== testCase.bytes) {
    failures.push(
      `${testCase.label}: keyToBytes gave ${JSON.stringify(bytes)}, expected ${JSON.stringify(testCase.bytes)}`,
    );
    continue;
  }
  // A key we deliberately do not forward is fully checked by the comparison
  // above: `null` is the expectation, so there is nothing left to parse.
  if (bytes === null) continue;

  const { events, neededFlush } = press(bytes);
  if (events.length !== 1) {
    failures.push(
      `${testCase.label}: ${JSON.stringify(bytes)} produced ${events.length} keystrokes, expected 1`,
    );
    continue;
  }
  const event = events[0]!;
  const actualFlags = KEY_FLAGS.filter(f => event.key[f]).sort();
  const expectedFlags = [...(testCase.flags ?? [])].sort();
  if (actualFlags.join(',') !== expectedFlags.join(',')) {
    failures.push(
      `${testCase.label}: flag set is [${actualFlags.join(', ')}], expected [${expectedFlags.join(', ')}]`,
    );
  }
  if (event.input !== (testCase.input ?? '')) {
    failures.push(
      `${testCase.label}: input is ${JSON.stringify(event.input)}, expected ${JSON.stringify(testCase.input ?? '')}`,
    );
  }
  if (neededFlush !== !!testCase.needsFlush) {
    failures.push(
      `${testCase.label}: ${neededFlush ? 'needs' : 'does not need'} a flush, ` +
        `expected ${testCase.needsFlush ? 'it to need one' : 'no flush'}`,
    );
  }
}

// Printed rather than asserted, because it describes the map instead of
// checking it. Escape is the interesting row: the app only sees it once the
// tokenizer gives up on a longer sequence, which is what a real terminal does
// too.
const flushed = CASES.filter(c => c.needsFlush).map(c => c.label);
console.log(`${CASES.length} cases, ${CASES.filter(c => c.bytes === null).length} deliberately not forwarded`);
console.log(`held until flush: ${flushed.length > 0 ? flushed.join(', ') : '(none)'}`);

if (failures.length > 0) {
  console.error('\n' + failures.map(f => `FAIL: ${f}`).join('\n'));
  process.exit(1);
}
console.log('\nPASS: every key maps to bytes the components read as intended.');
