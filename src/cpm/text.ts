/**
 * Text files as CP/M wants them: CR LF line ends and a final ^Z (1Ah). DRI's
 * ASM ends a line at the CR, so text from a modern editor (LF only) reads
 * as one enormous line: a short source assembles to nothing, a long one
 * hangs ASM. SUBMIT and others stop at the ^Z. So imports and the built-in
 * sources go through `toCpmText` on the way onto a CP/M disk.
 */

/** Extensions that are text on CP/M (a .BAS is text only when saved with ,A). */
export const TEXT_EXTENSIONS = new Set(['ASM', 'MAC', 'LIB', 'Z80', 'SUB', 'TXT', 'DOC', 'PAS', 'BAS', 'C', 'H', 'FOR', 'PRN']);

const isTextByte = (b: number) => (b >= 0x20 && b < 0x7f) || b === 9 || b === 10 || b === 12 || b === 13 || b === 0x1a;

/**
 * `data` with CR LF line ends and a final ^Z, if it is plain ASCII text not
 * already in CP/M form; anything else (binary, or text with a ^Z already)
 * comes back unchanged.
 */
export function toCpmText(data: Uint8Array): Uint8Array {
  if (!data.length || data.includes(0x1a)) return data;
  for (const b of data) if (!isTextByte(b)) return data;
  let text = '';
  for (const b of data) text += String.fromCharCode(b);
  text = text.replace(/\r?\n/g, '\r\n');
  if (!text.endsWith('\r\n')) text += '\r\n';
  text += '\x1a';
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}
