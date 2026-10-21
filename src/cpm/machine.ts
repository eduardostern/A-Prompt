import { Z80 } from '../z80';
import { Disk, CpmFile, parseName } from './disk';
import { Bdos } from './bdos';
import { Ccp } from './ccp';
import { ConsoleIO, WarmBoot } from '../console';

export const BDOS_ENTRY = 0xfe00;
const TRAP_BASE = 0xfd00;
const BIOS_BASE = 0xf000;
const BIOS_ENTRIES = 17;

const initialStack = 0xfc00;

/**
 * A CP/M 2.2 machine: Z80 + 64K + drive A: + BDOS + CCP.
 *
 * The guest sees the classic memory map: zero page with a JMP at 0005h, the
 * BIOS jump table at F000h, and the BDOS in the top page.  Calls into the BDOS
 * and the BIOS are intercepted by the host so they can be implemented in
 * TypeScript and, where needed, await keyboard input.
 */
export class CpmMachine {
  readonly cpu = new Z80();
  readonly drives: Disk[] = [new Disk('A'), new Disk('B'), new Disk('C'), new Disk('D')];
  readonly bdos: Bdos;
  readonly ccp: Ccp;
  readonly mem: Uint8Array;

  /** Drive A:, kept for callers that only care about the boot disk. */
  get disk(): Disk {
    return this.drives[0];
  }

  running = false;
  busy = false;

  onRefresh?: () => void;
  onBusy?: (busy: boolean) => void;
  yieldFn: () => Promise<void> = () => new Promise((r) => requestAnimationFrame(() => r()));

  private warm = false;
  private stopped = false;

  constructor(readonly console: ConsoleIO) {
    this.mem = this.cpu.mem;
    this.initMemory();
    this.bdos = new Bdos(this.cpu, this.drives, console, () => { this.warm = true; });
    this.ccp = new Ccp(this);
  }

  private initMemory(): void {
    const m = this.mem;
    m.fill(0);
    // 0000h: JMP BIOS WBOOT.  0005h: JMP BDOS entry.  0006h: BDOS base.
    m[0x0000] = 0xc3; m[0x0001] = 0x03; m[0x0002] = 0xf0;
    m[0x0005] = 0xc3; m[0x0006] = BDOS_ENTRY & 0xff; m[0x0007] = BDOS_ENTRY >> 8;
    m[0x0003] = 0; // IOBYTE
    m[0x0004] = 0; // current drive
    for (let i = 0; i < BIOS_ENTRIES; i++) {
      const src = BIOS_BASE + i * 3;
      const dst = TRAP_BASE + i * 3;
      m[src] = 0xc3;
      m[src + 1] = dst & 0xff;
      m[src + 2] = dst >> 8;
      m[dst] = 0xc9; // RET, replaced by the host trap
    }
    m[BDOS_ENTRY] = 0xc9;
  }

  private printBanner(): void {
    const c = this.console;
    c.write('\r\n');
    if (c.columns < 60) {
      c.write('  ==========================\r\n');
      c.write('   A-PROMPT · CP/M 2.2 · Z80\r\n');
      c.write('  ==========================\r\n');
      c.write('\r\n  Type HELP for commands.\r\n');
      c.write('  Try: DIR, HELLO, STAT, PIP.\r\n\r\n');
      return;
    }
    const line = '─'.repeat(44);
    c.write(`  ┌${line}┐\r\n`);
    c.write('  │  A-PROMPT  ·  CP/M 2.2  ·  Z80  ·  64K RAM │\r\n');
    c.write(`  └${line}┘\r\n`);
    c.write('\r\n  CP/M 2.2 in your browser. Type HELP for commands.\r\n');
    c.write('  Sample programs: PIP, STAT, DDT, ED, ASM, HELLO.\r\n\r\n');
  }

  async start(): Promise<void> {
    this.printBanner();
    this.running = true;
    this.stopped = false;
    while (this.running && !this.stopped) {
      try {
        const line = await this.ccp.prompt();
        await this.ccp.execute(line);
      } catch (e) {
        if (e instanceof WarmBoot) {
          this.warm = false;
          continue;
        }
        this.console.write(`\r\n* ERROR: ${(e as Error).message}\r\n`);
      }
      if (this.stopped) break;
      this.ensureNewline();
      this.refresh();
    }
    this.running = false;
  }

  stop(): void {
    this.stopped = true;
    this.running = false;
    this.warm = true;
  }

  refresh(): void {
    this.onRefresh?.();
  }

  forgetFile(file: CpmFile): void {
    this.bdos.forget(file);
  }

  private ensureNewline(): void {
    if (this.console.lastByte !== 10) this.console.write('\r\n');
  }

  private pop16(): number {
    const m = this.mem;
    const lo = m[this.cpu.sp];
    this.cpu.sp = (this.cpu.sp + 1) & 0xffff;
    const hi = m[this.cpu.sp];
    this.cpu.sp = (this.cpu.sp + 1) & 0xffff;
    return lo | (hi << 8);
  }

  private writeFcb(addr: number, token: string | undefined): void {
    const m = this.mem;
    m.fill(0x20, addr + 1, addr + 9);
    m.fill(0x20, addr + 9, addr + 12);
    m[addr] = 0;
    if (!token) return;
    const p = parseName(token);
    if (!p) return;
    m[addr] = p.drive !== null ? (p.drive + 1) & 0x1f : 0;
    for (let i = 0; i < 8; i++) m[addr + 1 + i] = p.name.charCodeAt(i);
    for (let i = 0; i < 3; i++) m[addr + 9 + i] = p.ext.charCodeAt(i);
  }

  async runCom(file: CpmFile, line: string): Promise<void> {
    const m = this.mem;
    const command = line.split(' ')[0];
    const tail = line.slice(command.length).slice(0, 127);

    m.fill(0, 0x005c, 0x0080);
    m[0x0080] = tail.length;
    for (let i = 0; i < tail.length; i++) m[0x0081 + i] = tail.charCodeAt(i);
    m[0x0081 + tail.length] = 0;

    const tokens = tail.trim().split(/\s+/).filter(Boolean);
    this.writeFcb(0x005c, tokens[0]);
    this.writeFcb(0x006c, tokens[1]);

    m.set(file.data, 0x0100);
    m[0x0004] = this.bdos.drive & 0x0f;

    const cpu = this.cpu;
    cpu.sp = initialStack;
    cpu.pc = 0x0000;
    // Push a return address of 0000h: RET from the program warm boots via WBOOT.
    cpu.sp = (cpu.sp - 1) & 0xffff; m[cpu.sp] = 0x00;
    cpu.sp = (cpu.sp - 1) & 0xffff; m[cpu.sp] = 0x00;
    cpu.pc = 0x0100;
    cpu.a = cpu.f = 0;
    cpu.b = cpu.c = cpu.d = cpu.e = cpu.h = cpu.l = 0;
    cpu.ix = cpu.iy = 0;
    cpu.halted = false;
    cpu.iff1 = cpu.iff2 = 0;

    this.warm = false;
    this.busy = true;
    this.onBusy?.(true);

    const started = performance.now();
    let slice = started;
    let steps = 0;

    try {
      while (!this.warm && !this.stopped) {
        const pc = cpu.pc;
        if (pc === BDOS_ENTRY) {
          await this.bdos.handle();
          continue;
        }
        if (pc >= TRAP_BASE && pc < TRAP_BASE + BIOS_ENTRIES * 3) {
          if (await this.biosTrap(pc)) break;
          continue;
        }
        cpu.step();
        steps++;
        if ((steps & 0x1fff) === 0) {
          const now = performance.now();
          if (now - slice > 10) {
            await this.yieldFn();
            slice = performance.now();
          }
        }
        if (steps > 1_000_000_000) {
          this.console.write('\r\n* program interrupted (execution limit)\r\n');
          break;
        }
      }
    } catch (e) {
      if (!(e instanceof WarmBoot)) {
        this.console.write(`\r\n* ${(e as Error).message}\r\n`);
      }
    } finally {
      this.busy = false;
      this.onBusy?.(false);
      this.warm = false;
    }
  }

  /** Returns true when the machine should return to the CCP. */
  private async biosTrap(pc: number): Promise<boolean> {
    const idx = (pc - TRAP_BASE) / 3;
    const cpu = this.cpu;
    switch (idx) {
      case 0: // BOOT
      case 1: // WBOOT
        this.warm = true;
        return true;
      case 2: // CONST
        cpu.a = this.console.pollByte() !== undefined ? 0xff : 0x00;
        break;
      case 3: // CONIN
        cpu.a = await this.console.readByte();
        break;
      case 4: // CONOUT
        this.console.writeByte(cpu.c);
        break;
      case 5: // LIST
      case 6: // PUNCH
        break;
      case 7: // READER
        cpu.a = 0x1a;
        break;
      case 8: // HOME
        cpu.a = 0;
        break;
      case 9: // SELDSK
        cpu.h = 0; cpu.l = 0; cpu.a = 0;
        break;
      case 10: // SETTRK
      case 11: // SETSEC
      case 12: // SETDMA
        cpu.a = 0;
        break;
      case 13: // READ
      case 14: // WRITE
        cpu.a = 1; // sector I/O is not implemented
        break;
      case 15: // LISTST
        cpu.a = 0xff;
        break;
      case 16: // SECTRAN
        cpu.h = cpu.b; cpu.l = cpu.c;
        break;
    }
    cpu.pc = this.pop16();
    return false;
  }
}
