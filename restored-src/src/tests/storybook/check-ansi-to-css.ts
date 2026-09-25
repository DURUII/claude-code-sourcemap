/**
 * Unit check for ansi-to-css.ts.
 *
 * The load-bearing case is the last section: it interns styles that real chalk
 * produced and decodes them back. That exercises the actual pipeline
 * (chalk -> StylePool -> StylePool.get -> ansiToCellStyle) rather than a
 * hand-written escape string that might not match what the app emits.
 *
 * Run: FORCE_COLOR=3 bun run src/tests/storybook/check-ansi-to-css.ts
 */
import chalk from 'chalk';
import { tokenize } from '@alcalzone/ansi-tokenize';
import { StylePool } from '../../ink/screen.js';
import { ansiToCellStyle, ansi256ToHex, cellStyleKey, ANSI_16 } from './ansi-to-css.js';

if (chalk.level === 0) {
  console.error('chalk.level is 0, so every colour assertion below would vacuously pass.');
  console.error('Re-run with FORCE_COLOR=3.');
  process.exit(1);
}

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}\n         expected ${e}\n         actual   ${a}`);
  }
};

/** Decode a single hand-written SGR sequence, for the table cases. */
const decode = (code: string) =>
  ansiToCellStyle([{ type: 'ansi', code, endCode: '' }]);

console.log('\n1. attributes');
check('bold', decode('\x1b[1m'), { bold: true });
check('dim', decode('\x1b[2m'), { dim: true });
check('italic', decode('\x1b[3m'), { italic: true });
check('underline', decode('\x1b[4m'), { underline: true });
check('inverse', decode('\x1b[7m'), { inverse: true });
check('strike', decode('\x1b[9m'), { strike: true });
check('multi-param 1;31', decode('\x1b[1;31m'), { bold: true, color: '#cd0000' });

console.log('\n2. resets');
check('bold then 22', ansiToCellStyle([
  { type: 'ansi', code: '\x1b[1m', endCode: '' },
  { type: 'ansi', code: '\x1b[22m', endCode: '' },
]), {});
check('empty code list', ansiToCellStyle([]), {});
check('bare reset', decode('\x1b[0m'), {});
check('fg then 39', ansiToCellStyle([
  { type: 'ansi', code: '\x1b[31m', endCode: '' },
  { type: 'ansi', code: '\x1b[39m', endCode: '' },
]), {});

console.log('\n3. the 16 basic colours, foreground and background');
const names = ['black','red','green','yellow','blue','magenta','cyan','white',
  'blackBright','redBright','greenBright','yellowBright','blueBright','magentaBright','cyanBright','whiteBright'];
const chalkFn = chalk as unknown as Record<string, (s: string) => string>;

/**
 * The palette written out here by hand rather than read off `ANSI_16`.
 *
 * It used to be `const expected = ANSI_16[idx]!`, and since `ansiToCellStyle`
 * derives its value from that same table (ansi-to-css.ts:112-116), all 32
 * assertions in the loop below were comparing `ANSI_16[i]` with itself. Replacing
 * the table's contents left every one of them passing and relabelled the output
 * to match, so the printed names went on claiming the colours had been verified.
 *
 * These are xterm's defaults, which is what the table's own comment claims it
 * holds. The order is load-bearing: black..white then the eight bright variants,
 * which is chalk's 30-37 then 90-97, and that is what the loop checks the names
 * against. The last assertion in this section then ties the module's table back
 * to this literal, so neither side can drift alone.
 */
const PALETTE = [
  '#000000', '#cd0000', '#00cd00', '#cdcd00',
  '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
  '#7f7f7f', '#ff0000', '#00ff00', '#ffff00',
  '#5c5cff', '#ff00ff', '#00ffff', '#ffffff',
];
check('the palette this file pins is 16 well-formed colours',
  PALETTE.filter(c => !/^#[0-9a-f]{6}$/.test(c)), []);
names.forEach((n, idx) => {
  const expected = PALETTE[idx]!;
  const bg = chalkFn['bg' + n[0]!.toUpperCase() + n.slice(1)]!('x');
  check(`${n} fg -> ${expected}`, decode(onlySgr(chalkFn[n]!('x'))).color, expected);
  check(`${n} bg -> ${expected}`, decode(onlySgr(bg)).backgroundColor, expected);
});
check('ANSI_16 matches the palette written out above', [...ANSI_16], PALETTE);

console.log('\n4. 256-colour palette');
check('0 -> black', ansi256ToHex(0), '#000000');
check('15 -> white', ansi256ToHex(15), '#ffffff');
check('16 -> cube origin', ansi256ToHex(16), '#000000');
check('196 -> pure red', ansi256ToHex(196), '#ff0000');
check('231 -> cube max', ansi256ToHex(231), '#ffffff');
check('232 -> grey ramp start', ansi256ToHex(232), '#080808');
check('255 -> grey ramp end', ansi256ToHex(255), '#eeeeee');
check('out of range falls back', ansi256ToHex(999), '#e5e5e5');
check('38;5;196 seq', decode('\x1b[38;5;196m'), { color: '#ff0000' });
check('48;5;232 seq', decode('\x1b[48;5;232m'), { backgroundColor: '#080808' });

console.log('\n5. truecolor');
check('38;2 fg', decode('\x1b[38;2;255;107;128m'), { color: '#ff6b80' });
check('48;2 bg', decode('\x1b[48;2;10;20;30m'), { backgroundColor: '#0a141e' });

console.log('\n6. style keys are stable and distinguishing');
check('same attrs collide',
  cellStyleKey(decode('\x1b[38;2;255;107;128m')) === cellStyleKey({ color: '#ff6b80' }), true);
check('different attrs differ',
  cellStyleKey({ color: '#ff6b80' }) === cellStyleKey({ color: '#ff6b80', bold: true }), false);
check('key order is fixed', cellStyleKey({ bold: true, color: '#ff6b80' }), '#ff6b80||b|||||');

console.log('\n7. the real pipeline: chalk -> StylePool -> decode');
{
  const pool = new StylePool();
  const subjects: [string, string, object][] = [
    ['hex colour', chalk.hex('#ff6b80')('x'), { color: '#ff6b80' }],
    ['bold red', chalk.bold.red('x'), { bold: true, color: '#cd0000' }],
    ['underline', chalk.underline('x'), { underline: true }],
    ['inverse', chalk.inverse('x'), { inverse: true }],
    ['256 colour', chalk.ansi256(196)('x'), { color: '#ff0000' }],
    ['dim', chalk.dim('x'), { dim: true }],
    ['bg hex', chalk.bgHex('#0a141e')('x'), { backgroundColor: '#0a141e' }],
  ];
  for (const [label, styled, expected] of subjects) {
    // Take only the codes that are active *at* the character, i.e. the opening
    // sequences before the first char token. Including the trailing resets
    // would decode to nothing, because the reset would immediately undo the
    // attribute under test.
    const id = pool.intern(activeCodes(styled) as never);
    const decoded = ansiToCellStyle(pool.get(id));
    check(label, decoded, expected);
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll checks passed.');

/** Reduce a styled string to just its opening SGR sequence. */
function onlySgr(styled: string): string {
  const m = styled.match(/\x1b\[[0-9;]*m/);
  if (!m) throw new Error(`no SGR in ${JSON.stringify(styled)}`);
  return m[0];
}

/** The ANSI codes in effect where the styled text begins. */
function activeCodes(styled: string): unknown[] {
  const tokens = tokenize(styled);
  const firstChar = tokens.findIndex(t => t.type === 'char');
  if (firstChar < 0) throw new Error(`no char token in ${JSON.stringify(styled)}`);
  return tokens.slice(0, firstChar).filter(t => t.type === 'ansi');
}
