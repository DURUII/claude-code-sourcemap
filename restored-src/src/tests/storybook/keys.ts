/**
 * The browser-to-terminal keymap.
 *
 * Lives in its own file, and in TypeScript, so that `probe-keymap.tsx` can
 * import it and check every row against the real input parser. The alternative,
 * keeping this inside `client.js`, would leave the one piece of the client that
 * can be wrong *silently* untestable: a mistyped byte sequence does not throw,
 * it just means a key does nothing when you press it.
 *
 * The browser loads it as `/keys.js`, which `server.ts` transpiles from this
 * file. That is the only reason the extension is not `.js`: nothing here needs a
 * bundler, but it does benefit from being typed and importable.
 *
 * Every sequence below was read off `src/ink/parse-keypress.ts` and the
 * tokenizer that feeds it, which is what decides whether the app sees `return`
 * or `enter`, `up` or nothing.
 */

/** The subset of `KeyboardEvent` this module reads. */
export type KeyEventLike = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

/**
 * Translate a key event into the byte sequence a terminal sends, or `null` for
 * anything not forwarded.
 *
 * `null` matters as much as the sequences do: the caller leaves the event alone
 * in that case, so browser shortcuts (reload, devtools, find) keep working. This
 * is a viewer for a terminal application, not a terminal emulator, so it should
 * not try to swallow everything.
 *
 * Two of these are the kind of detail that only shows up as "the key silently
 * does nothing", and both are pinned by `probe-keymap.tsx`:
 *
 *   Enter is CR, not LF. `\n` parses to the name `enter`, which carries no Key
 *   flag, and the dialogs test `key.return`
 *   (src/ink/parse-keypress.ts:701-705, src/ink/events/input-event.ts:39).
 *
 *   One keystroke per call. The tokenizer coalesces adjacent printable text
 *   (src/ink/termio/tokenize.ts:117-125), so a two-character string arrives as
 *   one two-character keypress. Every branch returns exactly one key's worth.
 */
export function keyToBytes(event: KeyEventLike): string | null {
  // Cmd/Ctrl combos stay with the browser: Cmd+R has to still reload, and the
  // story rail is not a text field that needs Cmd+A.
  if (event.metaKey) return null;

  const key = event.key;

  if (event.ctrlKey) {
    if (key.length !== 1) return null;
    const lower = key.toLowerCase();
    const code = lower.charCodeAt(0);
    if (code >= 97 && code <= 122) {
      // Ctrl+A is 0x01, Ctrl+Z is 0x1a. parseKeypress maps the whole 0x00-0x1a
      // range back to ctrl+<letter>.
      return String.fromCharCode(code - 96);
    }
    // Ctrl+Space sends NUL, as it has since VT100 days.
    if (key === ' ') return '\x00';
    // Ctrl+[ is Escape, Ctrl+\\ is 0x1c, Ctrl+] is 0x1d. Of these only 0x1c and
    // 0x1d are arbitrary: the other two are what a terminal actually emits.
    if (key === '[') return '\x1b';
    if (key === '\\') return '\x1c';
    if (key === ']') return '\x1d';
    return null;
  }

  switch (key) {
    case 'ArrowUp':
      return '\x1b[A';
    case 'ArrowDown':
      return '\x1b[B';
    case 'ArrowRight':
      return '\x1b[C';
    case 'ArrowLeft':
      return '\x1b[D';
    case 'Enter':
      return '\r';
    case 'Escape':
      return '\x1b';
    case 'Tab':
      return event.shiftKey ? '\x1b[Z' : '\t';
    case 'Backspace':
      // DEL, not BS: this is what a terminal sends for the backspace key, and
      // what parseKeypress expects (src/ink/parse-keypress.ts:711-713).
      return '\x7f';
    case 'Delete':
      return '\x1b[3~';
    case 'PageUp':
      return '\x1b[5~';
    case 'PageDown':
      return '\x1b[6~';
    case 'Home':
      return '\x1b[H';
    case 'End':
      return '\x1b[F';
    default:
      break;
  }

  if (event.altKey && key.length === 1) return '\x1b' + key;
  // A single printable character, including space. Length is 1 for BMP
  // characters; anything longer (an emoji, 'Dead', 'Unidentified') is not
  // forwarded.
  if (key.length === 1) return key;
  return null;
}
