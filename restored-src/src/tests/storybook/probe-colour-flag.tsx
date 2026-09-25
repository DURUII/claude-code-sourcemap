/**
 * Is `FORCE_COLOR=3` what makes the gallery coloured?
 *
 *   bun run src/tests/storybook/probe-colour-flag.tsx
 *
 * The plan claims colours come from that flag. Until this probe existed the
 * claim rested on a reading of chalk's environment handling, and a plausible
 * reading is exactly the kind of thing that turns out to be off by one. So it is
 * measured: the same component is rendered twice, in two processes, and the SGR
 * each one emits is compared.
 *
 * This cannot be checked in-process. Chalk inspects `FORCE_COLOR` when it is
 * imported (`supports-color`), so an assignment inside the script is always too
 * late, and so is deleting one. The flag has to be decided by the parent before
 * the child starts, which is why this file spawns itself.
 *
 * Nor can it go through the worker: `worker.tsx:84` refuses to start unless
 * `FORCE_COLOR` is exactly `'3'`, deliberately, so the gallery can never be
 * launched into a colourless state by accident. That guard is why the mechanism
 * is measured on the `snapshot()` path instead, which renders the same component
 * through the same wrapper with colour left to the environment.
 */

import { join } from 'path';

const CHILD_MARKER = 'SB_COLOUR_CHILD';

type Finding = {
  /** SGR sequences of any kind. */
  sgr: number;
  /** 24-bit foreground and background sequences, the ones the theme needs. */
  truecolor: number;
  /** Distinct SGR sequences, so two runs can be compared without shelling out. */
  distinct: string[];
  /** First 60 characters of visible text, to prove a screen really rendered. */
  preview: string;
};

/** Render one dialog and report the colour it wrote. Runs in the child. */
async function measure(): Promise<Finding> {
  const { enableConfigs } = await import('../../utils/config.js');
  const { snapshot, plain } = await import('./harness.js');
  const { InvalidSettingsDialog } = await import(
    '../../components/InvalidSettingsDialog.js'
  );

  enableConfigs();
  const frame = await snapshot(
    <InvalidSettingsDialog
      settingsErrors={
        [
          {
            file: '~/.claude/settings.json',
            path: 'permissions.defaultMode',
            message: 'Invalid enum value',
            expected: "'default' | 'acceptEdits' | 'plan'",
            invalidValue: 'yolo',
            suggestion: "Did you mean 'acceptEdits'?",
          },
        ] as never
      }
      onContinue={() => {}}
      onExit={() => {}}
    />,
    { columns: 96, settleMs: 300, tty: false },
  );

  // Annotated: without it the `?? []` literal infers as `never[]` under this
  // repo's tsconfig (`strict: false`), which makes the element type `never`.
  const sgr: string[] = frame.match(/\x1b\[[0-9;]*m/g) ?? [];
  return {
    sgr: sgr.length,
    truecolor: sgr.filter(s => s.includes('38;2;') || s.includes('48;2;')).length,
    distinct: [...new Set(sgr)].sort(),
    preview: plain(frame).split('\n').find(l => l.trim())?.trim().slice(0, 60) ?? '',
  };
}

if (process.env[CHILD_MARKER] === '1') {
  // Child: the environment is already decided; just measure and report.
  process.stdout.write(JSON.stringify(await measure()));
  process.exit(0);
}

const HERE = import.meta.path;
const ROOT = join(import.meta.dir, '..', '..', '..');

/** Spawn this file with `FORCE_COLOR` either set to 3 or absent. */
async function render(forceColor: boolean): Promise<Finding> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    [CHILD_MARKER]: '1',
  };
  if (forceColor) env.FORCE_COLOR = '3';
  else delete env.FORCE_COLOR;

  const proc = Bun.spawn([process.execPath, 'run', HERE], {
    cwd: ROOT,
    env: env as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`child exited ${code}: ${err.trim().split('\n').slice(-3).join(' / ')}`);
  }
  return JSON.parse(out) as Finding;
}

let failures = 0;

const withFlag = await render(true);
console.log('with FORCE_COLOR=3');
console.log(`  ${withFlag.sgr} SGR sequences, ${withFlag.truecolor} of them 24-bit`);
console.log(`  ${withFlag.distinct.length} distinct: ${withFlag.distinct.slice(0, 6).join(' ')}`);
console.log(`  screen starts: ${JSON.stringify(withFlag.preview)}`);
console.log();
if (withFlag.truecolor === 0) {
  failures++;
  console.log('FAIL the flag did not produce 24-bit colour, so it proves nothing about the theme');
}

const withoutFlag = await render(false);
console.log('without FORCE_COLOR (a pipe, so chalk reads level 0)');
console.log(`  ${withoutFlag.sgr} SGR sequences, ${withoutFlag.truecolor} of them 24-bit`);
console.log(`  ${withoutFlag.distinct.length} distinct: ${withoutFlag.distinct.slice(0, 6).join(' ')}`);
console.log(`  screen starts: ${JSON.stringify(withoutFlag.preview)}`);
console.log();
if (withoutFlag.sgr !== 0) {
  failures++;
  console.log(`FAIL colour survived without the flag: ${withoutFlag.distinct.join(' ')}`);
}

// Both runs must be the same screen; a colour difference that also changed the
// text would mean this probe is comparing two different renders and says nothing.
if (withFlag.preview !== withoutFlag.preview || withFlag.preview === '') {
  failures++;
  console.log(
    `FAIL the two runs did not render the same text (${JSON.stringify(withFlag.preview)} vs ${JSON.stringify(withoutFlag.preview)})`,
  );
}

if (failures > 0) {
  console.log(`\n${failures} colour problem(s).`);
  process.exit(1);
}
console.log(
  'The flag is the whole difference: same screen, colour only with FORCE_COLOR=3.',
);
process.exit(0);
