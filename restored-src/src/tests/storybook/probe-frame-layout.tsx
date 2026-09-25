/**
 * Does the client lay a real frame out correctly?
 *
 * `frame-layout.ts` holds every decision the browser makes that can be wrong
 * *silently*: which index of a `CellRun` is the width and which is the link,
 * whether a wide glyph advances one column or two, and which `CellStyle` field
 * becomes which CSS property. A mistake there does not throw, it draws a
 * plausible screen with drifting columns or the wrong colours.
 *
 * So the geometry is checked here against frames painted by real mounted
 * components, not against hand-written payloads. Only the cases a dialog cannot
 * produce on demand (inverse video, a wide glyph, an OSC-8 link) use a synthetic
 * payload, and each of those says so.
 *
 * Run: FORCE_COLOR=3 bun run src/tests/storybook/probe-frame-layout.tsx
 */
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Must precede any config-reading import, or reads fall through to the real
// ~/.claude (src/utils/envUtils.ts:7-13).
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'sb-config-'));

import React from 'react';
import { enableConfigs } from '../../utils/config.js';
import { getTheme } from '../../utils/theme.js';
import { InvalidSettingsDialog } from '../../components/InvalidSettingsDialog.js';
import { mountStory } from './harness.js';
import { payloadToText, serializeFrame } from './frame-payload.js';
import { ANSI_16, cellStyleKey } from './ansi-to-css.js';
import { layoutRows, styleToCss, type TerminalColors } from './frame-layout.js';

enableConfigs();

/** The same values client.html declares for `--term-fg` and `--term-bg`. */
const TERMINAL: TerminalColors = { foreground: 'rgb(255, 255, 255)', background: '#0c0c0c' };

/**
 * One cell's width. Any positive value works: every assertion below is about
 * the *ratio* between columns and pixels, which is what a wrong cell width would
 * not change. Using a round number keeps the expected numbers readable.
 */
const CELL = 8;

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}\n         expected ${e}\n         actual   ${a}`);
  }
};

console.log('\n1. a real dialog frames lands on the grid');

const story = await mountStory(
  <InvalidSettingsDialog
    settingsErrors={[{ file: 'settings.json', path: 'model', message: 'must be a string' }] as never}
    onContinue={() => {}}
    onExit={() => {}}
  />,
  { columns: 80, rows: 20 },
);

const payload = serializeFrame(story.latest()!, story.stylePool());
const rows = layoutRows(payload, CELL, TERMINAL);

check('one layout row per screen row', rows.length, payload.rows);
check(
  'every row covers exactly `columns` cells',
  rows.map(r => r.width),
  rows.map(() => payload.columns * CELL),
);
check(
  'the first run of every row starts at column 0',
  rows.map(r => r.runs[0]?.left),
  rows.map(() => 0),
);

// Overlap is the failure mode a wrong width index produces: runs would be placed
// on top of each other, and the damage would be invisible in a text comparison
// because the text would still concatenate correctly.
//
// `PlacedRun` carries no `count` and no `width`, so the expected positions have
// to be accumulated from the payload's own run tuples. That is what makes this a
// check rather than a restatement of `layoutRows`: the expectation below
// accumulates `count * width` read from `payload.grid`, while `layoutRows`
// accumulates its own reading of the same tuple. Read the wrong index for the
// width, say `count` where `width` belongs, and the two diverge on any run of
// more than one cell.
//
// The previous version of this check compared each `left` against the previous
// `left` and counted the times it decreased. `layoutRows` advances its column by
// `count * width` with both factors at least 1, so the sequence is monotonically
// increasing by construction and the counter could never reach 1. It printed
// "no run is placed before the one on its left" and tested nothing.
let misplaced = 0;
let countMismatch = 0;
let textMismatch = 0;
const expectedRows = payloadToText(payload).split('\n');
rows.forEach((row, y) => {
  const cellRuns = payload.grid[y]!;
  let column = 0;
  for (let i = 0; i < row.runs.length; i++) {
    const placed = row.runs[i]!;
    const [count, , , width] = cellRuns[i]!;
    // One glyph per cell, so a run's text length is its cell count. This is the
    // assertion that fails when the tuple is read from the wrong index.
    if (placed.text.length !== count) countMismatch++;
    // The rounding is repeated from frame-layout.ts rather than imported: it is
    // not what is under test, and CELL is integral today, so copying it costs
    // nothing and keeps the expectation correct if CELL ever stops being so.
    if (placed.left !== Math.round(column * CELL * 100) / 100) misplaced++;
    column += count * width;
  }
  // The geometry must agree with the independent text reconstruction in
  // frame-payload.ts, which walks the runs without any of this arithmetic.
  const text = row.runs.map(r => r.text).join('').replace(/\s+$/, '');
  if (text !== expectedRows[y]) textMismatch++;
});
check('each run starts exactly where the previous one ends', misplaced, 0);
check('each run holds one glyph per cell', countMismatch, 0);
check('the laid-out text matches the payload text', textMismatch, 0);

console.log('\n2. styles survive into CSS');

/**
 * Normalise a colour so the two notations compare equal.
 *
 * This is not tidiness. The theme source writes `rgb(255,193,7)` and the style
 * pool hands the browser `#ffc107`, which is the same colour: the pool converts
 * on the way in. Comparing raw strings would report every colour as unknown, and
 * "fixing" that by accepting any string would hide a real theme mismatch.
 */
const canonical = (colour: string): string => {
  const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(colour);
  if (!rgb) return colour.toLowerCase();
  return (
    '#' +
    [rgb[1]!, rgb[2]!, rgb[3]!]
      .map(n => Number(n).toString(16).padStart(2, '0'))
      .join('')
  );
};

const coloured = rows.flatMap(r => r.runs).filter(r => r.css.color !== undefined);
const colours = [...new Set(coloured.map(r => r.css.color!))];
check('the dialog has coloured runs', coloured.length > 0, true);
// The product claim being pinned: what the browser paints is a colour the theme
// defines, not something this gallery invented. ANSI_16 is allowed because a
// story themed with `dark-ansi` writes `ansi:<name>` and inherits the palette.
const knownColours = new Set(
  [...Object.values(getTheme('dark')), ...ANSI_16].map(canonical),
);
check(
  'every colour comes from the theme or the ANSI palette',
  colours.filter(c => !knownColours.has(canonical(c))),
  [],
);
const bold = rows.flatMap(r => r.runs).filter(r => r.css.fontWeight === '700');
console.log(`     ${coloured.length} coloured runs, ${bold.length} bold, ` +
  `${colours.length} distinct colours: ${colours.join(' ')}`);
check('the dialog title is bold', bold.length > 0, true);

// The other half of the same claim: a cell the theme does *not* colour must come
// through with no CSS at all, or every blank cell would be painted with whatever
// the default style happens to be.
const defaultStyleIndex = payload.styles.findIndex(s => cellStyleKey(s) === cellStyleKey({}));
let defaultRuns = 0;
let styledDefaults = 0;
payload.grid.forEach((runs, y) => {
  runs.forEach((run, i) => {
    if (run[2] !== defaultStyleIndex) return;
    defaultRuns++;
    if (Object.keys(rows[y]!.runs[i]!.css).length > 0) styledDefaults++;
  });
});
check('the frame has default-styled runs', defaultRuns > 0, true);
check('and none of them is given CSS', styledDefaults, 0);

await story.unmount();

console.log('\n3. the cases a dialog cannot produce on demand');

// Synthetic from here: these payloads are data, and building them by hand is what
// lets one frame contain a wide glyph, an inverted cell and a link at once.
const synthetic = {
  seq: 1,
  generation: 1,
  columns: 6,
  rows: 2,
  // Row 0: "ab" (2 cells), one CJK glyph (2 cells), "cd" (2 cells).
  // Row 1: a 6-cell run, inverted, which is what a selected row looks like.
  grid: [
    [
      [2, 'a', 0, 1, 0],
      [1, '中', 1, 2, 0],
      [2, 'b', 0, 1, 0],
    ],
    [[6, ' ', 2, 1, 1]],
  ],
  styles: [
    {},
    { color: 'rgb(255, 107, 128)', bold: true },
    { inverse: true },
  ],
  links: ['', 'https://example.com/settings#model'],
} as unknown as import('./frame-payload.js').FramePayload;

const syntheticRows = layoutRows(synthetic, CELL, TERMINAL);

check('a wide glyph advances two columns', syntheticRows[0]!.runs[1]!.left, 2 * CELL);
check('the run after a wide glyph keeps its column', syntheticRows[0]!.runs[2]!.left, 4 * CELL);
check('a wide run still covers its columns', syntheticRows[0]!.width, 6 * CELL);
check(
  'an inverted cell swaps the terminal colours',
  syntheticRows[1]!.runs[0]!.css,
  { color: TERMINAL.background, background: TERMINAL.foreground },
);
check('a linked run carries its href', syntheticRows[1]!.runs[0]!.href, 'https://example.com/settings#model');
check('only linked runs carry an href', syntheticRows[0]!.runs.every(r => r.href === undefined), true);

// `inverse` combined with an explicit colour: the swap has to use the colour the
// style actually supplies, or a highlighted cell in a coloured list loses its
// background.
check(
  'inverse with an explicit background uses it',
  styleToCss({ inverse: true, backgroundColor: 'rgb(0, 0, 255)' }, TERMINAL),
  { color: 'rgb(0, 0, 255)', background: TERMINAL.foreground },
);
check(
  'underline and strike compose',
  styleToCss({ underline: true, strike: true }, TERMINAL),
  { textDecoration: 'underline line-through' },
);
check('an undefined style is an empty object', styleToCss(undefined, TERMINAL), {});

console.log('\n4. the client page references what the script looks up');
// A typo in a getElementById argument is a null dereference on the first frame,
// which in a browser is a blank page with one console error. Cheaper to catch
// here: every id the script asks for must exist in the HTML it is served with.
{
  const html = await Bun.file(join(import.meta.dir, 'client.html')).text();
  const js = await Bun.file(join(import.meta.dir, 'client.js')).text();
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]!));
  const wanted = [...js.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]!);
  const missing = wanted.filter(id => !htmlIds.has(id));
  check(`all ${wanted.length} looked-up ids exist in client.html`, missing, []);
  // The reverse is not an error, but an id nothing looks up is usually a leftover.
  const unused = [...htmlIds].filter(id => !wanted.includes(id));
  console.log(`     ids in html: ${htmlIds.size}, looked up: ${wanted.length}, looked up by nothing: ${unused.length}`);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll checks passed.');
process.exit(0);
