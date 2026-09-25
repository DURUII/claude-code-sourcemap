/**
 * Where each run of a frame goes and what it looks like, as plain data.
 *
 * Split out of `client.js` so it can be tested. The parts of the client that can
 * be wrong *silently* are all here: which index of a `CellRun` is the width and
 * which is the link, whether a wide character advances one column or two, and
 * which `CellStyle` field becomes which CSS property. A mistake in any of those
 * renders a plausible-looking screen with the wrong colours or a growing column
 * drift, which is much harder to spot than a crash.
 *
 * `probe-frame-layout.tsx` runs this over frames from real mounted components
 * and asserts the geometry, so this file is checked against actual payloads
 * rather than against hand-written ones.
 *
 * The browser loads it as `/frame-layout.js`, transpiled by `server.ts`. Its
 * imports are type-only, so the transpiled output has no dependencies at all.
 */
import type { CellStyle } from './ansi-to-css.js';
import type { CellRun, FramePayload } from './frame-payload.js';

/**
 * The colours an uncoloured cell renders in.
 *
 * `inverse` needs both, because it swaps them: a cell with `inverse` and no
 * explicit background paints the terminal's *foreground* behind itself. The
 * browser reads these from its own stylesheet, which is where the app's dark
 * theme values live.
 */
export type TerminalColors = {
  foreground: string;
  background: string;
};

/** CSS properties this renderer ever sets. A run that needs none gets `{}`. */
export type CssProps = {
  color?: string;
  background?: string;
  fontWeight?: string;
  opacity?: string;
  fontStyle?: string;
  textDecoration?: string;
};

/** One run, positioned. `left` is in pixels from the row's left edge. */
export type PlacedRun = {
  left: number;
  text: string;
  css: CssProps;
  /** Set only for an OSC-8 link, so a plain run stays a plain span. */
  href?: string;
};

/** One screen row. `width` is how many pixels the runs actually cover. */
export type LayoutRow = {
  runs: PlacedRun[];
  width: number;
};

/** Two decimals is below a screen pixel and keeps the JSON readable. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * A resolved cell style as CSS properties.
 *
 * `inverse` is resolved by swapping the two colours rather than by inverting
 * anything, because the frame has already made the swap meaningful: the style
 * says "inverse" and the colour that ends up behind the glyph is the terminal's
 * foreground. Swapping here keeps that true whether or not the theme supplied a
 * background.
 */
export function styleToCss(style: CellStyle | undefined, terminal: TerminalColors): CssProps {
  if (!style) return {};
  let color = style.color;
  let background = style.backgroundColor;
  if (style.inverse) {
    const fg = color || terminal.foreground;
    const bg = background || terminal.background;
    color = bg;
    background = fg;
  }

  const css: CssProps = {};
  if (color) css.color = color;
  if (background) css.background = background;
  if (style.bold) css.fontWeight = '700';
  // No colour for dim: matching a terminal means matching what it does with a
  // colour it already has, and every terminal renders "faint" differently. A
  // whole-run opacity is the closest honest approximation, and it is visible.
  if (style.dim) css.opacity = '0.6';
  if (style.italic) css.fontStyle = 'italic';
  const decorations: string[] = [];
  if (style.underline) decorations.push('underline');
  if (style.strike) decorations.push('line-through');
  if (decorations.length > 0) css.textDecoration = decorations.join(' ');
  return css;
}

/**
 * Lay out every row of a frame.
 *
 * Runs are positioned by column rather than flowed, so a run that starts at
 * column 40 lands there whatever the font does with the glyphs before it. The
 * cursor carries the column forward: a normal run advances `count` columns and a
 * wide one (CJK, most emoji) advances `2 * count`, which is the whole reason
 * `CellRun` carries a width.
 *
 * Invariant, and what the probe asserts row by row: `width` equals
 * `payload.columns * cellWidth`, because `serializeFrame` guarantees the runs on
 * a row cover exactly `columns` columns.
 */
export function layoutRows(
  payload: FramePayload,
  cellWidth: number,
  terminal: TerminalColors,
): LayoutRow[] {
  return payload.grid.map((runs: CellRun[]) => {
    const placed: PlacedRun[] = [];
    let column = 0;
    for (const run of runs) {
      const [count, char, styleIndex, width, linkIndex] = run;
      const href = payload.links[linkIndex];
      placed.push({
        left: round2(column * cellWidth),
        // A run of `count` wide characters is `count` glyphs covering twice as
        // many columns, so repeating the glyph is what makes the text as wide as
        // the space reserved for it.
        text: char.repeat(count),
        css: styleToCss(payload.styles[styleIndex], terminal),
        ...(href ? { href } : {}),
      });
      column += count * width;
    }
    return { runs: placed, width: round2(column * cellWidth) };
  });
}
