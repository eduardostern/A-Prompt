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
  onSpeed?: (mhz: number) => void;
  yieldFn: () => Promise<void> = () => new Promise((r) => requestAnimationFrame(() => r()));

  private warm = false;
  private stopped = false;
  private biosDisk = 0;
  private biosTrack = 0;
  private biosSector = 0;
  private biosDma = 0x0080;

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

  /** Flush raw image writes or rebuild images after BDOS file writes. */
  syncImages(): void {
    for (const drive of this.drives) drive.syncImage();
  }

  private buildDph(disk: Disk): number {
    const image = disk.image!;
    const m = this.mem;
    const dpb = 0xfd40;
    const dph = 0xfb00;
    const dirbuf = 0xfb10;
    const alv = 0xfd50;
    m.set(image.dpb(), dpb);
    const d = new Uint8Array(16);
    const put = (off: number, value: number) => {
      d[off] = value & 0xff;
      d[off + 1] = (value >> 8) & 0xff;
    };
    put(0, 0); // XLT
    put(2, 0); put(4, 0); put(6, 0); // scratch
    put(8, dirbuf);
    put(10, dpb);
    put(12, 0); // CSV
    put(14, alv);
    m.set(d, dph);
    m.fill(0, dirbuf, dirbuf + 128);
    m.fill(0, alv, alv + Math.ceil((image.geometry.dsm + 1) / 8));
    return dph;
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
    let sampleTime = started;
    let sampleSteps = 0;

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
        if (cpu.halted) {
          // A HALT with no interrupt source would otherwise spin here until
          // the execution limit. Treat it as the end of the program.
          break;
        }
        if ((steps & 0x1fff) === 0) {
          const now = performance.now();
          if (now - sampleTime >= 250) {
            const mhz = ((steps - sampleSteps) * 4) / ((now - sampleTime) / 1000) / 1_000_000;
            this.onSpeed?.(mhz);
            sampleTime = now;
            sampleSteps = steps;
          }
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
      this.syncImages();
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
        this.bdos.printerLog.push(cpu.c & 0xff);
        if (this.bdos.printerLog.length > 1_000_000) this.bdos.printerLog.splice(0, 500_000);
        break;
      case 6: // PUNCH
        this.bdos.serialLog.push(cpu.c & 0xff);
        if (this.bdos.serialLog.length > 1_000_000) this.bdos.serialLog.splice(0, 500_000);
        break;
      case 7: // READER
        cpu.a = 0x1a;
        break;
      case 8: // HOME
        this.biosTrack = 0;
        cpu.a = 0;
        break;
      case 9: { // SELDSK
        const index = cpu.e;
        const disk = this.drives[index];
        if (!disk?.image) {
          cpu.h = 0; cpu.l = 0; cpu.a = 0;
          break;
        }
        this.biosDisk = index;
        const dph = this.buildDph(disk);
        cpu.h = (dph >> 8) & 0xff;
        cpu.l = dph & 0xff;
        cpu.a = 0;
        break;
      }
      case 10: // SETTRK
        this.biosTrack = cpu.bc & 0xffff;
        cpu.a = 0;
        break;
      case 11: // SETSEC
        this.biosSector = cpu.bc & 0xffff;
        cpu.a = 0;
        break;
      case 12: // SETDMA
        this.biosDma = cpu.bc & 0xffff;
        cpu.a = 0;
        break;
      case 13: { // READ
        const disk = this.drives[this.biosDisk];
        const sector = disk?.image?.readSector(this.biosTrack, this.biosSector);
        if (!sector) { cpu.a = 1; break; }
        this.mem.set(sector, this.biosDma & 0xff80);
        cpu.a = 0;
        break;
      }
      case 14: { // WRITE
        const disk = this.drives[this.biosDisk];
        if (!disk?.image) { cpu.a = 1; break; }
        const dma = this.biosDma & 0xff80;
        const ok = disk.image.writeSector(this.biosTrack, this.biosSector, this.mem.subarray(dma, dma + 128));
        if (!ok) { cpu.a = 1; break; }
        disk.imageDirty = true;
        disk.filesDirty = false;
        cpu.a = 0;
        break;
      }
      case 15: // LISTST
        cpu.a = 0xff;
        break;
      case 16: // SECTRAN
        cpu.h = cpu.b;
        cpu.l = cpu.c;
        break;
    }
    cpu.pc = this.pop16();
    return false;
  }
}
