import { describe, it } from 'vitest';
import { readFileSync, existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { Z80 } from '../src/z80';

/**
 * Minimal CP/M shim used only to run the Z80 instruction exercisers.
 * zexdoc/zexall execute at 0100h and communicate through BDOS at 0005h.
 */
function runZex(file: string, maxSteps = Number(process.env.ZEX_MAX ?? 100_000_000_000), timeLimitMs = Number(process.env.ZEX_TIME ?? 1_800_000)): string {
  const path = new URL(`./fixtures/${file}`, import.meta.url);
  if (!existsSync(path)) throw new Error(`missing fixture ${file}`);
  const image = readFileSync(path);

  const cpu = new Z80();
  const mem = cpu.mem;
  mem.fill(0);
  mem.set(image, 0x0100);

  const BDOS = 0xff00;
  mem[0x0000] = 0xc3; mem[0x0001] = 0x03; mem[0x0002] = 0x00;
  mem[0x0005] = 0xc3; mem[0x0006] = BDOS & 0xff; mem[0x0007] = BDOS >> 8;

  let out = '';
  let steps = 0;
  let done = false;
  const started = Date.now();
  let lastReport = started;
  let written = 0;
  const logFile = process.env.ZEX_LOG;
  if (logFile) writeFileSync(logFile, '');

  const pop = () => {
    const lo = mem[cpu.sp];
    cpu.sp = (cpu.sp + 1) & 0xffff;
    const hi = mem[cpu.sp];
    cpu.sp = (cpu.sp + 1) & 0xffff;
    return lo | (hi << 8);
  };
  const push = (v: number) => {
    cpu.sp = (cpu.sp - 1) & 0xffff; mem[cpu.sp] = (v >> 8) & 0xff;
    cpu.sp = (cpu.sp - 1) & 0xffff; mem[cpu.sp] = v & 0xff;
  };

  cpu.pc = 0x0100;
  cpu.sp = 0xfe00;
  push(0x0000);

  while (!done) {
    if (cpu.pc === 0x0000) { done = true; break; }
    if (cpu.pc === BDOS) {
      const fn = cpu.c;
      if (fn === 0) { done = true; break; }
      if (fn === 2) out += String.fromCharCode(cpu.e);
      else if (fn === 9) {
        let a = cpu.de;
        while (mem[a] !== 0x24) { out += String.fromCharCode(mem[a]); a = (a + 1) & 0xffff; }
      } else if (fn === 6) {
        if (cpu.e === 0xff) cpu.a = 0x1a; else if (cpu.e !== 0xfe) out += String.fromCharCode(cpu.e);
      } else if (fn === 11) cpu.a = 0;
      cpu.pc = pop();
      continue;
    }
    cpu.step();
    steps++;
    if ((steps & 0xffffff) === 0) {
      const now = Date.now();
      if (now - started > timeLimitMs) {
        out += `\n[timeout after ${steps} steps]\n`;
        break;
      }
      if (now - lastReport > 15000) {
        lastReport = now;
        console.log(`... ${file}: ${(steps / 1e6).toFixed(0)}M instructions, ${((steps / 1e6) / ((now - started) / 1000)).toFixed(1)} MIPS`);
        if (logFile) {
          appendFileSync(logFile, out.slice(written));
          written = out.length;
        }
        if (out.includes('Tests complete')) { done = true; break; }
      }
    }
    if (steps > maxSteps) { out += '\n[step limit]\n'; break; }
  }

  out += `\n[${steps} instructions, ${((Date.now() - started) / 1000).toFixed(1)}s]`;
  if (logFile) appendFileSync(logFile, out.slice(written));
  return out;
}

describe.skipIf(!process.env.ZEX)('Z80 instruction exerciser', () => {
  for (const file of ['zexdoc.com', 'zexall.com']) {
    it(file, () => {
      const out = runZex(file);
      console.log(out);
      const failures = out.split('\n').filter((l) => l.includes('ERROR'));
      if (failures.length) throw new Error(`${failures.length} failing tests:\n${failures.join('\n')}`);
    }, 3_600_000);
  }
});
