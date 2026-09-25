/**
 * Do hyperlinks survive into the frame payload, and does that depend on the
 * ambient terminal?
 *
 * This is the one part of a frame whose *content* is decided by the environment
 * rather than by the component. `Link` renders an `ink-link` element only when
 * `supportsHyperlinks()` says yes (src/ink/components/Link.tsx:19), and that
 * function delegates to the npm `supports-hyperlinks` library before doing any
 * of its own terminal detection (src/ink/supports-hyperlinks.ts:29-33).
 *
 * Two consequences, both measured here rather than reasoned about:
 *
 *   1. The library initialises itself at module load, from the real
 *      `process.stdout` (`const supportsHyperlinks = { stdout:
 *      createSupportsHyperlinks(process.stdout), ... }`), and a piped stdout
 *      fails its `!stream.isTTY` test. So this worker's gateway to links is
 *      `FORCE_HYPERLINK`, which that library checks *first* and returns on.
 *   2. Being import-time, `FORCE_HYPERLINK` cannot be set from inside the
 *      process that uses it: assigning it at the top of a module is too late,
 *      because ESM imports are hoisted above the module body. That is why the
 *      worker asserts it instead of defaulting it, and why this probe has to
 *      spawn child processes to see both modes at all.
 *
 * Run: bun run src/tests/storybook/probe-hyperlink.tsx
 *   (the parent supplies for its children what it cannot set for itself)
 */
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { findDanglingLinks, payloadToText } from './frame-payload.js';

const TEST_URL = 'https://example.com/settings#model';
const LABEL = 'settings docs';
const FALLBACK = 'see the settings docs';

/** One child run: report the gate, then mount a real `Link` and serialize it. */
async function child(): Promise<void> {
  const { enableConfigs } = await import('../../utils/config.js');
  const React = (await import('react')).default;
  const { Link } = await import('../../ink.js');
  const { mountStory } = await import('./harness.js');
  const { serializeFrame } = await import('./frame-payload.js');

  enableConfigs();

  const story = await mountStory(
    React.createElement(Link, { url: TEST_URL, fallback: FALLBACK }, LABEL),
    { columns: 60, rows: 10 },
  );
  await new Promise(r => setTimeout(r, 200));

  const payload = serializeFrame(story.latest()!, story.stylePool());
  const linked = payload.grid
    .flatMap((runs, y) => {
      let x = 0;
      return runs.map(run => {
        const at = x;
        x += run[0] * run[3];
        return { y, x: at, linkIndex: run[4] };
      });
    })
    .filter(r => r.linkIndex > 0);

  const report = {
    forceHyperlink: process.env.FORCE_HYPERLINK ?? null,
    termProgram: process.env.TERM_PROGRAM ?? null,
    libraryStdout: (await import('supports-hyperlinks')).default.stdout,
    links: payload.links,
    linkedRunCount: linked.length,
    firstLinkedColumn: linked[0]?.x ?? null,
    danglingLinks: findDanglingLinks(payload).length,
    text: payloadToText(payload),
  };
  await story.unmount();
  process.stdout.write(JSON.stringify(report) + '\n');
}

/**
 * Re-run this file with a different `FORCE_HYPERLINK`, which is the only way to
 * observe the gate from the other side: the library caches its answer at import
 * time, so one process can only ever see one mode.
 */
function runChild(forceHyperlink: string | undefined): string {
  const result = spawnSync(
    process.execPath,
    ['run', import.meta.path, '--child'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        FORCE_COLOR: '3',
        // Without this the child would read the real ~/.claude.
        CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'sb-hyperlink-')),
        ...(forceHyperlink === undefined
          ? { FORCE_HYPERLINK: '' }
          : { FORCE_HYPERLINK: forceHyperlink }),
      },
    },
  );
  const line = result.stdout.split('\n').find(l => l.startsWith('{'));
  if (!line) {
    throw new Error(
      `child with FORCE_HYPERLINK=${forceHyperlink ?? '<empty>'} produced no report.\n` +
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  return line;
}

if (process.argv.includes('--child')) {
  await child();
} else {
  type Report = {
    forceHyperlink: string | null;
    termProgram: string | null;
    libraryStdout: boolean;
    links: string[];
    linkedRunCount: number;
    firstLinkedColumn: number | null;
    danglingLinks: number;
    text: string;
  };

  // The labels are load-bearing and the first one used to lie. It read "unset",
  // but `runChild` has to write FORCE_HYPERLINK explicitly to keep a value
  // inherited from this shell out of the child, so `undefined` becomes `''`, and
  // the child reports that back. Empty is not unset, and the difference is not
  // cosmetic: the library's gate is `if (process.env.FORCE_HYPERLINK)`
  // (supports-hyperlinks/index.js:38), so `''` is falsy and falls through to the
  // terminal detection below it, while `'0'` is truthy and takes the explicit-off
  // branch at index.js:39. Both end at "no links" by different routes, which is
  // why both are worth measuring. The first assertion after the table pins the
  // row to what it claims to be, so this cannot silently regress.
  const cases: Array<{ label: string; value: string | undefined }> = [
    { label: 'empty (not unset)', value: undefined },
    { label: '0 (explicit off)', value: '0' },
    { label: '1 (forced on)', value: '1' },
  ];

  const reports: Array<{ label: string; report: Report }> = [];
  for (const c of cases) {
    reports.push({ label: c.label, report: JSON.parse(runChild(c.value)) as Report });
  }

  console.log(`TERM_PROGRAM in this environment: ${reports[0]!.report.termProgram ?? '(unset)'}`);
  console.log('The library answers off the real process.stdout, which is a pipe here,');
  console.log('so it says false unless FORCE_HYPERLINK is set.\n');

  console.log('FORCE_HYPERLINK      library.stdout  links in payload  first linked col  text');
  for (const { label, report } of reports) {
    const linkState = report.linkedRunCount > 0 ? report.links.slice(1).join(',') : '(none)';
    console.log(
      `${label.padEnd(20)} ${String(report.libraryStdout).padEnd(15)} ` +
        `${linkState.padEnd(17)} ${String(report.firstLinkedColumn).padEnd(17)} ${report.text}`,
    );
  }

  // Each mode is asserted, not just printed, so this fails loudly if the gate's
  // behaviour ever changes under us.
  const failures: string[] = [];
  const [unset, off, on] = reports.map(r => r.report);

  // The row labelled empty must really be empty, or the row above and the one
  // below it are the same experiment wearing different names.
  if (unset!.forceHyperlink !== '') {
    failures.push(
      `the first case is labelled "empty" but the child saw ` +
        `${JSON.stringify(unset!.forceHyperlink)}`,
    );
  }
  if (unset!.linkedRunCount !== 0) {
    failures.push(
      'an empty FORCE_HYPERLINK produced a link; the library is no longer treating it ' +
        'as falsy, so the fall-through to terminal detection is gone',
    );
  }
  if (off!.linkedRunCount !== 0) {
    failures.push('FORCE_HYPERLINK=0 produced a link; the explicit-off branch is not being honoured');
  }
  if (on!.linkedRunCount === 0) {
    failures.push('FORCE_HYPERLINK=1 produced no link; the payload cannot carry hyperlinks');
  }
  if (on!.links[0] !== '') {
    failures.push('links[0] is not the empty no-link sentinel, so indices are shifted');
  }
  if (!on!.links.includes(TEST_URL)) {
    failures.push(`the payload's link table does not contain the url ${TEST_URL}`);
  }
  for (const { label, report } of reports) {
    if (report.danglingLinks !== 0) {
      failures.push(`${label}: ${report.danglingLinks} run(s) point outside the link table`);
    }
  }
  // With and without links the visible label is identical. Only the fallback
  // mode differs, and only when the caller supplied a fallback.
  if (on!.text.trim() !== LABEL) {
    failures.push(`forced-on text should be the label, got ${JSON.stringify(on!.text.trim())}`);
  }
  if (off!.text.trim() !== FALLBACK) {
    failures.push(`forced-off text should be the fallback, got ${JSON.stringify(off!.text.trim())}`);
  }

  console.log(
    `\nlinked runs: ${on!.linkedRunCount} at column ${on!.firstLinkedColumn}, ` +
      `covering ${on!.links.slice(1).join(', ')}`,
  );
  console.log(`link-off text falls back to: ${JSON.stringify(off!.text.trim())}`);

  if (failures.length > 0) {
    console.error('\n' + failures.map(f => `FAIL: ${f}`).join('\n'));
    process.exit(1);
  }
  console.log('\nPASS: the link channel carries a url only when FORCE_HYPERLINK=1.');
}
