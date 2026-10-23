/**
 * Display-width helpers.
 *
 * Only needed because `list` renders mixed CJK/Latin text. Kept hand-rolled
 * instead of pulling in `string-width`: the whole point of this project is a
 * dependency-free binary, and the range table below covers what we render.
 */

/** Ranges that occupy two terminal cells. */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols
  [0x3041, 0x33ff], // Hiragana, Katakana, Bopomofo, Hangul compat, CJK compat
  [0x3400, 0x4dbf], // CJK Ext A
  [0x4e00, 0x9fff], // CJK Unified
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compat ideographs
  [0xfe30, 0xfe4f], // CJK compat forms
  [0xff00, 0xff60], // Fullwidth forms
  [0xffe0, 0xffe6], // Fullwidth signs
  [0x1f300, 0x1f64f], // Emoji pictographs
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd], // CJK Ext B+
];

function isWide(codePoint: number): boolean {
  for (const [start, end] of WIDE_RANGES) {
    if (codePoint >= start && codePoint <= end) return true;
  }
  return false;
}

/** Terminal cells occupied by a string. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const codePoint = ch.codePointAt(0);
    if (codePoint === undefined) continue;
    width += isWide(codePoint) ? 2 : 1;
  }
  return width;
}

/** Pad to a target display width. Never truncates. */
export function padDisplay(text: string, width: number): string {
  const gap = width - displayWidth(text);
  return gap > 0 ? text + ' '.repeat(gap) : text;
}

/** Truncate to a display width, appending an ellipsis when cut. */
export function truncateDisplay(text: string, maxWidth: number, ellipsis = '…'): string {
  if (displayWidth(text) <= maxWidth) return text;

  const budget = maxWidth - displayWidth(ellipsis);
  if (budget <= 0) return ellipsis;

  let out = '';
  let used = 0;
  for (const ch of text) {
    const codePoint = ch.codePointAt(0) ?? 0;
    const w = isWide(codePoint) ? 2 : 1;
    if (used + w > budget) break;
    out += ch;
    used += w;
  }
  return out + ellipsis;
}
