// Assembles programs/<NAME>.ASM with the bundled DRI ASM and LOAD, running
// inside the emulator, and writes programs/<NAME>.COM.
// Usage: npx vite-node scripts/assemble.ts COLOR TETRIS   (then npm run embed)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CpmMachine } from '../src/cpm/machine';
import { BUILTIN_FILES } from '../src/assets/builtin-programs';
import type { ConsoleIO } from '../src/console';

class Con implements ConsoleIO {
  output = ''; queue: number[] = []; lastByte = 10; readonly columns = 80;
  write(t: string) { this.output += t; }
  writeByte(c: number) { this.output += String.fromCharCode(c); }
  async readByte() { return this.queue.shift() ?? 0x1a; }
  pollByte() { return this.queue.shift(); }
  peekByte() { return this.queue[0]; }
  hasInput() { return this.queue.length > 0; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

for (const name of process.argv.slice(2)) {
  const con = new Con();
  const m = new CpmMachine(con);
  m.yieldFn = () => Promise.resolve();
  for (const f of BUILTIN_FILES) {
    if (f.name !== 'ASM' && f.name !== 'LOAD') continue;
    m.disk.put(f.name, f.ext, Uint8Array.from(Buffer.from(f.data, 'base64')));
  }
  const src = readFileSync(`${root}/programs/${name}.ASM`);
  // CP/M text: CR LF line ends and a ^Z terminator.
  const text = src.toString('latin1').replace(/\r?\n/g, '\r\n') + '\x1a';
  m.disk.put(name, 'ASM', Uint8Array.from(Buffer.from(text, 'latin1')));
  await m.runCom(m.disk.find(0, 'ASM     ', 'COM')!, `ASM ${name}`);
  const asmOut = con.output;
  con.output = '';
  await m.runCom(m.disk.find(0, 'LOAD    ', 'COM')!, `LOAD ${name}`);
  const com = m.disk.find(0, (name + '        ').slice(0, 8), 'COM');
  console.log(asmOut.trim());
  console.log(con.output.trim());
  if (!com || /^[A-Z](?:[0-9A-F]{4} |\s{15})/m.test(asmOut) || !/END OF ASSEMBLY/.test(asmOut)) { console.error(`${name}: assembly failed`); process.exit(1); }
  writeFileSync(`${root}/programs/${name}.COM`, com.data);
  console.log(`${name}.COM: ${com.data.length} bytes`);
}
