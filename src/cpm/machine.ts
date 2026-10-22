import { Z80 } from '../z80';
import { Disk, CpmFile } from './disk';
import { Bdos } from './bdos';
import { Ccp } from './ccp';
import { ConsoleIO, WarmBoot } from '../console';

import {
  BDOS_ENTRY, BIOS_BASE, BIOS_ENTRIES, CCP_STACK,
  DIRBUF_ADDR, DPB_ADDR, DPH_ADDR, TRAP_BASE,
} from './layout';

export { BDOS_ENTRY };

/**
 * A CP/M 2.2 machine: Z80 + 64K + drive A: + BDOS + CCP.
 *
 * The guest sees the classic memory map: zero page with a JMP at 0005h, the
 * BDOS entry at FC06h and the BIOS above it (see layout.ts).  Calls into the BDOS
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
  sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));
  /** Target Z80 clock in Hz; 0 runs as fast as the host allows. */
  clockHz = 0;

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
    const wboot = BIOS_BASE + 3;
    m[0x0000] = 0xc3; m[0x0001] = wboot & 0xff; m[0x0002] = wboot >> 8;
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
    const m = this.mem;
    const dpb = DPB_ADDR;
    const dph = DPH_ADDR;
    const dirbuf = DIRBUF_ADDR;
    // Every drive has a DPH, so BIOS-level tools can read its format and
    // allocation; sector READ/WRITE still need a mounted image.
    m.set(disk.format.dpb(), dpb);
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
    put(14, this.bdos.writeAllocationVector(disk));
    m.set(d, dph);
    m.fill(0, dirbuf, dirbuf + 128);
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

  /**
   * Fills a default FCB from the command tail like the CP/M 2.2 CCP's
   * fillfcb: a name runs until a delimiter (space = _ . : ; < >), so options
   * such as STAT's "$R/O" arrive intact; '*' pads with '?'. Returns where
   * parsing stopped, which is where the next FCB starts.
   */
  private fillFcb(addr: number, text: string, pos: number): number {
    const m = this.mem;
    m[addr] = 0;
    m.fill(0x20, addr + 1, addr + 12);
    const delimiter = (c: string | undefined) => c === undefined || ' =_.:;<>'.includes(c);
    while (text[pos] === ' ') pos++;
    if (/[A-P]/.test(text[pos] ?? '') && text[pos + 1] === ':') {
      m[addr] = text.charCodeAt(pos) - 64; // 1 = A:
      pos += 2;
    }
    const field = (offset: number, length: number) => {
      let i = 0;
      while (!delimiter(text[pos])) {
        if (text[pos] === '*') {
          while (i < length) m[addr + offset + i++] = 0x3f;
        } else if (i < length) {
          m[addr + offset + i++] = text.charCodeAt(pos) & 0x7f;
        }
        pos++;
      }
    };
    field(1, 8);
    if (text[pos] === '.') {
      pos++;
      field(9, 3);
    }
    return pos;
  }

  async runCom(file: CpmFile, line: string): Promise<void> {
    const m = this.mem;
    const command = line.split(' ')[0];
    const tail = line.slice(command.length).slice(0, 127);

    m.fill(0, 0x005c, 0x0080);
    m[0x0080] = tail.length;
    for (let i = 0; i < tail.length; i++) m[0x0081 + i] = tail.charCodeAt(i);
    m[0x0081 + tail.length] = 0;

    this.fillFcb(0x006c, tail, this.fillFcb(0x005c, tail, 0));

    m.set(file.data, 0x0100);
    // 0004h: current user (high nibble) and drive, restored on warm boot.
    m[0x0004] = ((this.bdos.user & 0x0f) << 4) | (this.bdos.drive & 0x0f);
    // Like the real CCP: every program starts with DMA at 0080h and no open files.
    this.bdos.startProgram();

    const cpu = this.cpu;
    cpu.sp = CCP_STACK;
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
    let sampleCycles = cpu.cycles;
    // Clock limit: the cycles run since paceCycles should take this long.
    let paceTime = started;
    let paceCycles = cpu.cycles;
    let paceHz = this.clockHz;
    const repace = () => { paceTime = performance.now(); paceCycles = cpu.cycles; };

    try {
      while (!this.warm && !this.stopped) {
        const pc = cpu.pc;
        if (pc === BDOS_ENTRY || (pc >= TRAP_BASE && pc < TRAP_BASE + BIOS_ENTRIES * 3)) {
          const before = performance.now();
          if (pc === BDOS_ENTRY) await this.bdos.handle();
          else if (await this.biosTrap(pc)) break;
          // Time spent waiting for a key is not owed back as a burst of speed.
          if (performance.now() - before > 1) repace();
          continue;
        }
        cpu.step();
        steps++;
        if (cpu.halted) {
          // A HALT with no interrupt source would otherwise spin here
          // forever. Treat it as the end of the program.
          break;
        }
        if ((steps & 0x7ff) === 0) {
          let now = performance.now();
          if (now - sampleTime >= 250) {
            const mhz = (cpu.cycles - sampleCycles) / ((now - sampleTime) / 1000) / 1_000_000;
            this.onSpeed?.(mhz);
            sampleTime = now;
            sampleCycles = cpu.cycles;
          }
          if (this.clockHz !== paceHz) { paceHz = this.clockHz; repace(); }
          if (this.clockHz > 0) {
            const ahead = paceTime + ((cpu.cycles - paceCycles) * 1000) / this.clockHz - now;
            if (ahead > 2) {
              await this.sleepFn(Math.min(ahead, 100));
              now = slice = performance.now();
            } else if (ahead < -50) {
              repace(); // the host fell behind (busy or background tab)
            }
          }
          if (now - slice > 10) {
            await this.yieldFn();
            slice = performance.now();
          }
        }
        // No instruction cap: games poll the keyboard forever. A runaway
        // program is stopped with the Reset button (drives are preserved).
      }
    } catch (e) {
      if (!(e instanceof WarmBoot)) {
        this.console.write(`\r\n* ${(e as Error).message}\r\n`);
      }
    } finally {
      // Like the real CCP after a warm boot: programs that reset the disk
      // system (BDOS 13 selects A:) or change user do not move the prompt.
      const cdisk = m[0x0004];
      if ((cdisk & 0x0f) < this.drives.length) this.bdos.drive = cdisk & 0x0f;
      this.bdos.user = cdisk >> 4;
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
        cpu.a = this.console.hasInput() ? 0xff : 0x00;
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
        if (!disk) {
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
        // The DMA address may be any byte address; the transfer wraps at FFFFh.
        for (let i = 0; i < 128; i++) this.mem[(this.biosDma + i) & 0xffff] = sector[i];
        cpu.a = 0;
        break;
      }
      case 14: { // WRITE
        const disk = this.drives[this.biosDisk];
        if (!disk?.image) { cpu.a = 1; break; }
        const bytes = new Uint8Array(128);
        for (let i = 0; i < 128; i++) bytes[i] = this.mem[(this.biosDma + i) & 0xffff];
        const ok = disk.image.writeSector(this.biosTrack, this.biosSector, bytes);
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
