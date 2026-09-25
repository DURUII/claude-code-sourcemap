/**
 * Decides the gallery's rendering path.
 *  1. Does FORCE_COLOR make the theme emit real colour? (chalk.level is 0 in a pipe)
 *  2. Can we capture Ink's own Screen buffer instead of parsing ANSI?
 */
import { Readable, Writable } from 'stream';
import React from 'react';
import chalk from 'chalk';
import { enableConfigs } from '../../utils/config.js';
import { render, Box, Text } from '../../ink.js';
import { LogUpdate } from '../../ink/log-update.js';
import { cellAt, type StylePool } from '../../ink/screen.js';
import type { Frame } from '../../ink/frame.js';

enableConfigs();
console.log('chalk.level before =', chalk.level, '| FORCE_COLOR =', process.env.FORCE_COLOR ?? '(unset)');

// --- 1. capture Frames by wrapping LogUpdate.render ---
const captured: Frame[] = [];
const realRender = LogUpdate.prototype.render;
// `unknown[]`, not `never[]`: `render`'s extras are forwarded, and a `never[]`
// is not iterable, so spreading it needs a cast that hides the real shape.
LogUpdate.prototype.render = function (prev: Frame, next: Frame, ...rest: unknown[]) {
  captured.push(next);
  return realRender.call(this, prev, next, ...rest);
} as typeof realRender;

class FakeStdin extends Readable {
  isTTY = true;
  _read(): void {}
  setRawMode(): this { return this; }
  ref(): this { return this; }
  unref(): this { return this; }
}
class FakeStdout extends Writable {
  columns = 40;
  rows = 12;
  isTTY = false;
  buf = '';
  _write(c: Buffer, _e: string, cb: () => void): void { this.buf += c.toString(); cb(); }
}

const stdout = new FakeStdout();
const stdin = new FakeStdin();
const inst = await render(
  <Box flexDirection="column">
    <Text color="error" bold>bold red</Text>
    <Text color="success">green</Text>
    <Text dimColor>dimmed</Text>
  </Box>,
  {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false,
    patchConsole: false,
  },
);
await new Promise(r => setTimeout(r, 400));

const sgr = new Set([...stdout.buf.matchAll(/\x1b\[[0-9;]*m/g)].map(m => m[0]));
console.log('1. SGR sequences seen:', sgr.size ? [...sgr].map(s => JSON.stringify(s)).join(' ') : '(none)');

// --- 2. read the captured Screen buffer ---
const frame = captured.at(-1);
console.log('2. frames captured:', captured.length, '| latest screen:', frame?.screen.width + 'x' + frame?.screen.height);
if (frame) {
  const pool = (frame.screen as unknown as { stylePool: StylePool }).stylePool;
  console.log('   stylePool reachable:', pool ? 'yes' : 'no');
  for (let y = 0; y < frame.screen.height; y++) {
    const row: string[] = [];
    for (let x = 0; x < frame.screen.width; x++) {
      const cell = cellAt(frame.screen, x, y);
      if (!cell) continue;
      const style = pool?.get?.(cell.styleId);
      row.push(`${JSON.stringify(cell.char)}#${cell.styleId}${style ? '=' + JSON.stringify(style) : ''}`);
    }
    console.log(`   y=${y}:`, row.join(' '));
  }
}
inst.unmount();
process.exit(0);
