// Assembles 8080 source with the bundled DRI ASM and LOAD, running inside a
// headless CP/M machine. Used by scripts/assemble.ts and the AI board.
import { CpmMachine } from './machine';
import { BUILTIN_FILES } from '../assets/builtin-programs';
import type { ConsoleIO } from '../console';

class Capture implements ConsoleIO {
  output = '';
  lastByte = 10;
  readonly columns = 80;
  write(t: string) { this.output += t; }
  writeByte(c: number) { this.output += String.fromCharCode(c); }
  async readByte() { return 0x1a; }
  pollByte() { return undefined; }
  peekByte() { return undefined; }
  hasInput() { return false; }
}

export interface AssemblyResult {
  ok: boolean;
  /** ASM's and LOAD's console output. */
  listing: string;
  /** ASM error lines: an error letter, the address, the source line. */
  errors: string[];
  com?: Uint8Array;
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A line starting with an error letter, then an address or blanks. */
const ERROR_LINE = /^[A-Z](?:[0-9A-F]{4} |\s{15}).*$/gm;

/**
 * Runs `ASM name` and `LOAD name`. `name` is up to 8 letters and digits;
 * `source` is plain text (line ends and the ^Z terminator are added here).
 */
export async function assemble(
  name: string,
  source: string,
  yieldFn: () => Promise<void> = () => Promise.resolve(),
): Promise<AssemblyResult> {
  if (!/^[A-Z][A-Z0-9]{0,7}$/.test(name)) throw new Error(`bad program name: ${name}`);
  const con = new Capture();
  const m = new CpmMachine(con);
  m.yieldFn = yieldFn;
  for (const f of BUILTIN_FILES) {
    if (f.name === 'ASM' || f.name === 'LOAD') m.disk.put(f.name, f.ext, fromBase64(f.data));
  }
  const text = source.replace(/\r?\n/g, '\r\n').replace(/\x1a/g, '') + '\r\n\x1a';
  m.disk.put(name, 'ASM', Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff));
  await m.runCom(m.disk.find(0, 'ASM     ', 'COM')!, `ASM ${name}`);
  const asmOut = con.output;
  const errors = asmOut.match(ERROR_LINE) ?? [];
  if (errors.length || !/END OF ASSEMBLY/.test(asmOut)) {
    return { ok: false, listing: asmOut, errors: errors.length ? errors : ['assembly did not finish'] };
  }
  con.output = '';
  await m.runCom(m.disk.find(0, 'LOAD    ', 'COM')!, `LOAD ${name}`);
  const com = m.disk.find(0, name.padEnd(8), 'COM');
  const listing = `${asmOut}${con.output}`;
  if (!com) return { ok: false, listing, errors: ['LOAD made no .COM file'] };
  return { ok: true, listing, errors: [], com: com.data.slice() };
}
