import { Z80 } from '../z80';
import { Disk, CpmFile } from './disk';
import { Bdos } from './bdos';
import { Ccp } from './ccp';
import { ConsoleIO, WarmBoot } from '../console';
import { Modem } from './modem';

import {
  BDOS_ENTRY, BIOS_BASE, BIOS_ENTRIES, CCP_STACK,
  DIRBUF_ADDR, DPB_ADDR, DPH_ADDR, MODEM_DATA_PORT, MODEM_STATUS_PORT, TRAP_BASE,
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
/** What the machine calls itself at power-on. */
const MACHINE_NAME = 'A-PROMPT 64';
const BIOS_VERSION = 'v1.0';
const CONTACT = 'eduardostern@icloud.com';

export class CpmMachine {
  readonly cpu = new Z80();
  readonly drives: Disk[] = [new Disk('A'), new Disk('B'), new Disk('C'), new Disk('D')];
  readonly bdos: Bdos;
  readonly ccp: Ccp;
  readonly mem: Uint8Array;
  /** Telnet modem on ports 04h/05h, also the READER/PUNCH device. */
  readonly modem = new Modem();

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
  /** Drive time (ms) the program still has to wait, when drives run at the era's speed. */
  private diskDebt = 0;

  /** Adds drive time to wait for. */
  owe(ms: number): void {
    this.diskDebt += ms;
  }

  /** Waits out the drive time owed. */
  async payDisk(): Promise<void> {
    while (this.diskDebt >= 1) {
      const ms = Math.min(this.diskDebt, 100);
      this.diskDebt -= ms;
      await this.sleepFn(ms);
    }
  }

  /** Wall-clock milliseconds since the epoch for the BDOS clock; tests substitute a fake. */
  now: () => number = () => Date.now();

  private warm = false;
  private stopped = false;
  private biosDisk = 0;
  private biosTrack = 0;
  private biosSector = 0;
  private biosDma = 0x0080;

  constructor(readonly console: ConsoleIO) {
    this.mem = this.cpu.mem;
    this.initMemory();
    this.bdos = new Bdos(this.cpu, this.drives, console, () => { this.warm = true; }, () => this.now());
    this.bdos.aux = this.modem;
    this.cpu.portIn = (port) => {
      switch (port & 0xff) {
        case MODEM_STATUS_PORT: return this.modem.status();
        case MODEM_DATA_PORT: return this.modem.read();
        default: return 0xff;
      }
    };
    this.cpu.portOut = (port, value) => {
      switch (port & 0xff) {
        case MODEM_STATUS_PORT: this.modem.control(value); break;
        case MODEM_DATA_PORT: this.modem.write(value); break;
      }
    };
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

  /** Size of a drive as the banner shows it: 243K, 4M. */
  private driveSize(d: Disk): string {
    const kb = Math.round(((d.format.dsm + 1) * d.format.blockSize) / 1024);
    return kb < 1024 ? `${kb}K` : `${Math.round(kb / 1024)}M`;
  }

  /** The power-on screen: the machine's sign-on, then a bell. */
  private printBanner(): void {
    const c = this.console;
    const mhz = this.clockHz ? `${+(this.clockHz / 1e6).toFixed(2)} MHz` : 'full speed';
    const drives = this.drives.map((d) => `${d.label}:${this.driveSize(d)}`).join(' ');
    c.write('\r\n');
    if (c.columns < 60) {
      c.write(`  ${MACHINE_NAME}\r\n`);
      c.write(`  Z80 computer, BIOS ${BIOS_VERSION}\r\n`);
      c.write(`  ${CONTACT}\r\n\r\n`);
      c.write(`  CPU   Z80 @ ${mhz}\r\n`);
      c.write('  RAM   64K OK\r\n');
      c.write(`  Disk  ${drives}\r\n`);
      c.write('  Modem Hayes, ports 04h/05h\r\n\r\n');
      c.write('  CP/M 2.2 (c) 1979 Digital Research\r\n\r\n');
      c.write('  HELP for commands, DIR for files.\r\n');
      c.write('  Games: TETRIS, JOSHUA.\r\n');
      c.write('  Modem: TERM, then ATDT AI for the\r\n');
      c.write('  AI board, ATI for real BBSes.\r\n\r\n');
      c.write('\x07');
      return;
    }
    const w = 54;
    const row = (text: string) => c.write(`  │ ${text.padEnd(w - 2)} │\r\n`);
    c.write(`  ┌${'─'.repeat(w)}┐\r\n`);
    row(`${MACHINE_NAME}  ·  Z80 Personal Computer`);
    row(`ROM BIOS ${BIOS_VERSION}  ·  ${CONTACT}`);
    c.write(`  └${'─'.repeat(w)}┘\r\n\r\n`);
    c.write(`  CPU ....... Zilog Z80 @ ${mhz}\r\n`);
    c.write('  Memory .... 64K RAM OK, 63K TPA (0100h-FBFFh)\r\n');
    c.write(`  Drives .... ${drives}\r\n`);
    c.write('  Modem ..... Hayes AT, telnet line on ports 04h/05h\r\n\r\n');
    c.write('  CP/M 2.2  -  Copyright (c) 1979 Digital Research\r\n\r\n');
    c.write('  Type HELP for commands, DIR for the programs on A:.\r\n');
    c.write('  Games: TETRIS, and JOSHUA (shall we play a game?).\r\n\r\n');
    c.write('  The modem: type TERM, then\r\n');
    c.write('    ATDT AI   call the AI board: chat with DeepSeek, meet the BOFH,\r\n');
    c.write('              or have it write and fix programs for you\r\n');
    c.write('    ATI       list the real BBSes still online; ATDT 1 calls one\r\n');
    c.write('  Ctrl-] leaves TERM with the call up; ZMODEM R fetches files.\r\n\r\n');
    c.write('\x07');
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
    // The CCP reads the directory, then the program a track at a time.
    this.bdos.touch(null, 0, false);
    for (let r = 0; r * 128 < file.data.length; r += 26) {
      this.bdos.touch(file, r, false, Math.min(26, Math.ceil(file.data.length / 128) - r));
    }
    await this.payDisk();
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
          // A drive of the era holds the program until the access is done.
          if (this.diskDebt >= 4) await this.payDisk();
          // A slow serial line holds the program until its output is sent.
          const lineWait = this.console.outputDelay?.() ?? 0;
          if (lineWait > 1) await this.sleepFn(Math.min(lineWait, 100));
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
        this.bdos.punch(cpu.c);
        break;
      case 7: // READER
        cpu.a = await this.bdos.reader();
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
        this.bdos.onDisk?.(this.biosDisk, this.biosTrack, false, 1);
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
        this.bdos.onDisk?.(this.biosDisk, this.biosTrack, true, 1);
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
