/**
 * Turn the style attached to a Screen cell into something a browser can paint.
 *
 * Ink stores styles structurally, not as text. `StylePool.get(styleId)` returns
 * the `AnsiCode[]` that were interned for that cell, each carrying its full
 * escape sequence (e.g. "\x1b[38;2;255;107;128m"). This module decodes those
 * into semantic attributes. Nothing downstream of here sees an escape sequence.
 *
 * The settable surface is closed and was read off the real code paths rather
 * than assumed:
 *   - style.ts / colorize.ts produce attributes via chalk
 *     (src/ink/colorize.ts:78-110 maps `ansi:red` -> chalk.red)
 *   - colours come in three shapes: basic 30-37/90-97, 256 (38;5;n), truecolor
 *     (38;2;r;g;b), plus the same three for background
 */
import type { AnsiCode } from '@alcalzone/ansi-tokenize';

/**
 * Semantic style for one run of cells. Booleans are kept as attributes rather
 * than collapsed into CSS because two of them need context the server does not
 * have: `inverse` swaps against the *default* fg/bg, and `dim` interacts with a
 * background. The client resolves both.
 */
export type CellStyle = {
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  inverse?: boolean;
};

/**
 * The 16 standard ANSI colours at their xterm defaults.
 *
 * These are terminal-dependent by definition: a theme like `dark-ansi` writes
 * `ansi:magenta` precisely so the user's own palette applies. The gallery has
 * no terminal to inherit from, so it uses the xterm defaults. Overridable at
 * the call site if a story needs to match a specific palette.
 */
export const ANSI_16: readonly string[] = Object.freeze([
  '#000000', '#cd0000', '#00cd00', '#cdcd00',
  '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
  '#7f7f7f', '#ff0000', '#00ff00', '#ffff00',
  '#5c5cff', '#ff00ff', '#00ffff', '#ffffff',
]);

/** The six levels the 256-colour cube quantises each channel to. */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;

/**
 * xterm's 256-colour palette.
 *
 * 0-15 are the standard colours (same table as ANSI_16, so a theme mixing
 * `ansi:red` and `ansi256(1)` stays internally consistent), 16-231 are a 6x6x6
 * RGB cube, and 232-255 are a 24-step grey ramp.
 */
export function ansi256ToHex(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 255) return ANSI_16[7]!;
  if (n < 16) return ANSI_16[n]!;
  if (n < 232) {
    const i = n - 16;
    const r = CUBE_LEVELS[(i / 36) | 0]!;
    const g = CUBE_LEVELS[((i / 6) | 0) % 6]!;
    const b = CUBE_LEVELS[i % 6]!;
    return rgbToHex(r, g, b);
  }
  const level = 8 + (n - 232) * 10;
  return rgbToHex(level, level, level);
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

/**
 * Decode one interned style into semantic attributes.
 *
 * Handles multi-parameter sequences (`\x1b[1;31m`) as well as the one-attribute
 * form chalk emits, since StylePool interns whatever the producer handed it.
 * Reset codes (22, 23, ...) are honoured so a style that partially resets
 * itself decodes correctly rather than inheriting a stale attribute.
 */
export function ansiToCellStyle(codes: readonly AnsiCode[]): CellStyle {
  const style: CellStyle = {};

  for (const ansi of codes) {
    const params = parseSgr(ansi.code);
    for (let i = 0; i < params.length; i++) {
      const p = params[i]!;
      switch (true) {
        case p === 0:
          for (const k of Object.keys(style)) delete style[k as keyof CellStyle];
          break;
        case p === 1: style.bold = true; break;
        case p === 2: style.dim = true; break;
        case p === 3: style.italic = true; break;
        case p === 4: style.underline = true; break;
        case p === 7: style.inverse = true; break;
        case p === 9: style.strike = true; break;
        case p === 22: delete style.bold; delete style.dim; break;
        case p === 23: delete style.italic; break;
        case p === 24: delete style.underline; break;
        case p === 27: delete style.inverse; break;
        case p === 29: delete style.strike; break;
        case p === 39: delete style.color; break;
        case p === 49: delete style.backgroundColor; break;

        // Basic foreground 30-37 and bright foreground 90-97.
        case p >= 30 && p <= 37: style.color = ANSI_16[p - 30]!; break;
        case p >= 90 && p <= 97: style.color = ANSI_16[p - 90 + 8]!; break;
        // Basic background 40-47 and bright background 100-107.
        case p >= 40 && p <= 47: style.backgroundColor = ANSI_16[p - 40]!; break;
        case p >= 100 && p <= 107: style.backgroundColor = ANSI_16[p - 100 + 8]!; break;

        // Extended colour. `p` is the 38/48 introducer; the selector at i+1
        // picks 256-colour (5) or truecolor (2) and consumes the rest.
        case p === 38 || p === 48: {
          const selector = params[i + 1];
          const isFg = p === 38;
          if (selector === 5) {
            const hex = ansi256ToHex(params[i + 2] ?? -1);
            if (isFg) style.color = hex; else style.backgroundColor = hex;
            i += 2;
          } else if (selector === 2) {
            const hex = rgbToHex(params[i + 2] ?? 0, params[i + 3] ?? 0, params[i + 4] ?? 0);
            if (isFg) style.color = hex; else style.backgroundColor = hex;
            i += 4;
          } else {
            i += 1; // malformed; skip the selector rather than the whole run
          }
          break;
        }
        default: break; // anything else (blink, faint variants) is not themed
      }
    }
  }

  return style;
}

/** Extract the numeric parameters from an SGR sequence like "\x1b[38;2;1;2;3m". */
function parseSgr(code: string): number[] {
  // Tolerate both CSI form ("\x1b[....m") and a bare parameter list.
  const body = code.startsWith('\x1b[') ? code.slice(2, -1) : code;
  if (body === '') return [0];
  return body.split(';').map(p => (p === '' ? 0 : Number(p)));
}

/**
 * A stable identity for a decoded style, so the frame payload can send each
 * distinct style once and reference it by key from every cell.
 *
 * Key order is fixed because two objects with the same attributes must collide.
 */
export function cellStyleKey(style: CellStyle): string {
  return [
    style.color ?? '',
    style.backgroundColor ?? '',
    style.bold ? 'b' : '',
    style.dim ? 'd' : '',
    style.italic ? 'i' : '',
    style.underline ? 'u' : '',
    style.strike ? 's' : '',
    style.inverse ? 'n' : '',
  ].join('|');
}
