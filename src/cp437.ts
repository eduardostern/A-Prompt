/** CP437 (the character set CP/M software was written for), bytes 80h-FFh, as Unicode. */
export const CP437 =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»' +
  '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
  'αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

const FOLD: Record<string, string> = {
  '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-',
  '…': '...', '•': '*', ' ': ' ', '→': '->', '←': '<-', '×': 'x',
};

/** Unicode text to CP437 bytes: ASCII as is, CP437 characters mapped, the rest folded or '?'. */
export function toCp437(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x80) { out.push(code); continue; }
    const fold = FOLD[ch];
    if (fold) { for (const c of fold) out.push(c.charCodeAt(0)); continue; }
    const i = CP437.indexOf(ch);
    if (i >= 0) { out.push(0x80 + i); continue; }
    const plain = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    out.push(plain.length === 1 && plain.charCodeAt(0) < 0x80 ? plain.charCodeAt(0) : 0x3f);
  }
  return out;
}
