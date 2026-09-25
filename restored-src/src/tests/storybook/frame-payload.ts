/**
 * Serialize an Ink Frame into something that crosses a process boundary and
 * lands in a browser.
 *
 * Ink stores the screen as two Int32 words per cell, indexing an interned char
 * pool and an interned style pool (src/ink/screen.ts:308-313). Neither pool is
 * portable: they live on the Ink instance. This module resolves both and emits
 * a self-contained, run-length-encoded, row-major picture plus a small style
 * table.
 *
 * Imports Ink only for types and the cell accessors, so it can be unit-tested
 * without mounting anything.
 */
import { CellWidth, cellAt, type Hyperlink, type StylePool } from '../../ink/screen.js';
import type { Frame } from '../../ink/frame.js';
import { ansiToCellStyle, cellStyleKey, type CellStyle } from './ansi-to-css.js';

/**
 * One run of visually identical cells: `[count, char, styleIndex, width, linkIndex]`.
 *
 * `width` is 1 for a normal character and 2 for a wide one (CJK, most emoji).
 * A run of `count` wide characters therefore covers `count * 2` columns.
 *
 * `linkIndex` is 1-based into `FramePayload.links`, where 0 means "not a link".
 * It has to be part of run identity, or a link would bleed across a run
 * boundary into cells that are not part of it.
 */
export type CellRun = [count: number, char: string, styleIndex: number, width: 1 | 2, linkIndex: number];

/**
 * A frame as sent to the browser.
 *
 * `grid` is one run list per screen row. Rows are explicit rather than implied
 * so that a run can never straddle a row boundary, which is what lets the
 * client rebuild the grid by walking each row left to right.
 *
 * Invariant, and the first thing to check if the browser renders something
 * skewed: for every row, `sum(count * width)` equals `columns`.
 *
 * There is deliberately no cursor field. `Frame.cursor` looks like a text caret
 * and is not one: it is the bottom-of-content anchor Ink uses to restore the
 * terminal cursor (`renderer.ts:165-171`, `y: screen.height`), its `x` is
 * hardcoded to 0, and its `visible` is `!isTTY || screen.height === 0`, which is
 * unconditionally true for this harness. Exporting it would invite the client to
 * draw a caret in the middle of a dialog's body.
 */
export type FramePayload = {
  /**
   * Monotonic within one worker's life. Lets the server drop a frame that
   * overtook a newer one and lets the client recognise a stale delivery.
   */
  seq: number;
  /**
   * Bumped whenever the server replaces the worker, which happens on a restart
   * request and whenever the last viewer leaves. A client compares it to tell
   * "the story was rebuilt, so `seq` legitimately went backwards" apart from "a
   * frame went missing from the stream I am already watching".
   *
   * Nothing asserts the bump. check-mount.tsx pins the default to 0
   * (check-mount.tsx:103), and probe-worker-lifetime.tsx reads the generation
   * from the `hello` message (probe-worker-lifetime.tsx:55) and includes it in
   * the string that comes back once per connection (:63), never comparing it to
   * a second value, so the restart path this field exists for is unchecked. The
   * field is carried because the client needs it, not because the suite proves
   * it moves.
   */
  generation: number;
  columns: number;
  rows: number;
  /** One run list per screen row, top to bottom. Length always equals `rows`. */
  grid: CellRun[][];
  styles: CellStyle[];
  /** OSC-8 targets, indexed by `CellRun`'s `linkIndex`. Index 0 is always `''`. */
  links: string[];
};

/** The style that a cell with no attributes decodes to. */
const DEFAULT_STYLE_KEY = cellStyleKey({});

/**
 * Encode one frame.
 *
 * Two things keep this cheap enough to run continuously, which matters because
 * `Spinner` in ResumeTask and TeleportResumeWrapper repaint nonstop:
 *
 * 1. An entirely blank row compresses to a single run, so a dialog floating in
 *    mostly-empty space costs roughly one run per row rather than one per
 *    column. This is why blank cells are *not* skipped: once runs exist,
 *    skipping them would buy nothing and would destroy the column alignment
 *    that lets the client place each run.
 * 2. Styles are interned twice over: by `styleId` for a fast path, and by
 *    decoded value so two ids that decode alike share one table entry.
 *
 * `seq` and `generation` are pass-throughs: they describe the frame's place in
 * a stream, not its pixels, so only a caller that owns such a stream can supply
 * them. Assertions that just want the picture leave them at the default.
 */
export function serializeFrame(
  frame: Frame,
  stylePool: StylePool,
  stream: { seq?: number; generation?: number } = {},
): FramePayload {
  const { screen } = frame;
  const styles: CellStyle[] = [];
  const styleIndexByKey = new Map<string, number>();
  /** styleId -> index into `styles`, so decoding happens once per distinct id. */
  const styleIndexById = new Map<number, number>();
  const grid: CellRun[][] = [];

  // Mirrors `HyperlinkPool` (src/ink/screen.ts:56-67), where an id of 0 means
  // "no hyperlink". Keeping the same convention means the sentinel is one entry
  // rather than a parallel `undefined`-or-index scheme the client has to special
  // case per cell.
  const links: string[] = [''];
  const linkIndexByUrl = new Map<string, number>();
  const internLink = (url: Hyperlink): number => {
    if (!url) return 0;
    let index = linkIndexByUrl.get(url);
    if (index === undefined) {
      index = links.length;
      links.push(url);
      linkIndexByUrl.set(url, index);
    }
    return index;
  };

  const internStyle = (styleId: number): number => {
    const cached = styleIndexById.get(styleId);
    if (cached !== undefined) return cached;

    const style = ansiToCellStyle(stylePool.get(styleId));
    const key = cellStyleKey(style);
    let index = styleIndexByKey.get(key);
    if (index === undefined) {
      index = styles.length;
      styles.push(style);
      styleIndexByKey.set(key, index);
    }
    styleIndexById.set(styleId, index);
    return index;
  };

  for (let y = 0; y < screen.height; y++) {
    const runs: CellRun[] = [];
    for (let x = 0; x < screen.width; x++) {
      const cell = cellAt(screen, x, y);
      if (!cell) continue;
      // The second column of a wide character. The wide cell already covers it,
      // so walking past it is what keeps `sum(count * width)` equal to the width.
      if (cell.width === CellWidth.SpacerTail) continue;

      const width: 1 | 2 = cell.width === CellWidth.Wide ? 2 : 1;
      const index = internStyle(cell.styleId);
      const linkIndex = internLink(cell.hyperlink);

      const last = runs[runs.length - 1];
      if (
        last &&
        last[1] === cell.char &&
        last[2] === index &&
        last[3] === width &&
        last[4] === linkIndex
      ) {
        last[0] += 1;
      } else {
        runs.push([1, cell.char, index, width, linkIndex]);
      }
    }
    grid.push(runs);
  }

  return {
    seq: stream.seq ?? 0,
    generation: stream.generation ?? 0,
    columns: screen.width,
    rows: screen.height,
    grid,
    styles,
    links,
  };
}

/**
 * Check the column-coverage invariant for every row.
 *
 * Returns the offending row indexes, empty when the payload is well formed.
 * Exposed because a mis-serialized frame shows up in the browser as skewed
 * text, which is much harder to diagnose than a named failing row.
 */
export function findRaggedRows(payload: FramePayload): number[] {
  const ragged: number[] = [];
  payload.grid.forEach((runs, y) => {
    const covered = runs.reduce((sum, [count, , , width]) => sum + count * width, 0);
    if (covered !== payload.columns) ragged.push(y);
  });
  return ragged;
}

/**
 * Check that every run's `linkIndex` resolves, returning the `[row, column]` of
 * the runs that do not.
 *
 * A link index is the one field in a run that fails *silently*: a client that
 * reads `links[run[4]]` past the end gets `undefined`, which makes the cell
 * render as ordinary text. That looks like a styling bug rather than a
 * serialization one, so the check is explicit.
 */
export function findDanglingLinks(payload: FramePayload): Array<[row: number, column: number]> {
  const dangling: Array<[row: number, column: number]> = [];
  payload.grid.forEach((runs, y) => {
    let x = 0;
    for (const run of runs) {
      if (run[4] < 0 || run[4] >= payload.links.length) dangling.push([y, x]);
      x += run[0] * run[3];
    }
  });
  return dangling;
}

/** Whether a run paints nothing at all, used by tests and the diff logger. */
export function isBlankRun(run: CellRun, styles: CellStyle[]): boolean {
  const [, char, styleIndex] = run;
  return char === ' ' && cellStyleKey(styles[styleIndex] ?? {}) === DEFAULT_STYLE_KEY;
}

/**
 * Rebuild a payload's text, the way a client would.
 *
 * Runs are expanded in order and trailing whitespace is trimmed per row. This
 * exists for assertions and probes rather than for the browser, which keeps the
 * runs and styles it already has.
 */
export function payloadToText(payload: FramePayload): string {
  return payload.grid
    .map(runs =>
      runs
        // A run of `count` wide characters is `count` glyphs covering 2*count
        // columns, so repeating the glyph yields the correct visual width.
        .map(([count, char]) => char.repeat(count))
        .join('')
        .replace(/\s+$/, ''),
    )
    .join('\n');
}
