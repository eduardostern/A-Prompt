import type { CpmMachine } from './machine';
import type { Disk } from './disk';
import { displayName, parseName, padName, padExt } from './disk';
import { readConsoleLine } from '../console';

const BUILTINS = ['DIR', 'ERA', 'TYPE', 'REN', 'USER', 'SAVE', 'CLS', 'HELP', 'EXIT', 'XSUB', 'DATE'];

/**
 * Console Command Processor.  The real CCP is a CP/M program living at the top
 * of the TPA; here it is a host-side shell that exposes the same commands and
 * sets up the zero page exactly like the original before running a .COM file.
 */
export class Ccp {
  constructor(private machine: CpmMachine) {}

  private get console() { return this.machine.console; }
  private get disk() { return this.machine.drives[this.bdos.drive]; }
  private get bdos() { return this.machine.bdos; }

  private get driveLetter(): string {
    return this.driveLetterAt(this.bdos.drive);
  }

  private driveLetterAt(index: number): string {
    return String.fromCharCode(65 + index);
  }

  private resolveDrive(drive: number | null): { disk: Disk; index: number } | null {
    const index = drive ?? this.bdos.drive;
    const disk = this.machine.drives[index];
    return disk ? { disk, index } : null;
  }

  async prompt(): Promise<string> {
    const submitted = this.nextSubmitCommand();
    if (submitted !== null) {
      this.console.write(`${this.driveLetter}>${submitted}\r\n`);
      return submitted;
    }
    this.console.write(`${this.driveLetter}>`);
    const line = await readConsoleLine(this.console, 127, true);
    return line;
  }

  /**
   * SUBMIT.COM queues commands in $$$.SUB, one 128-byte record each, written in
   * reverse order.  The CCP consumes the last record and truncates the file.
   */
  private nextSubmitCommand(): string | null {
    const file = this.disk.find(0, '$$$     ', 'SUB');
    if (!file) return null;
    if (file.data.length < 128) {
      this.disk.remove(file);
      this.machine.forgetFile(file);
      return null;
    }
    const records = Math.ceil(file.data.length / 128);
    const start = (records - 1) * 128;
    const rec = file.data.subarray(start, start + 128);
    const len = Math.min(127, rec[0] ?? 0);
    let text = '';
    for (let i = 0; i < len; i++) {
      const ch = rec[1 + i];
      if (ch === 0 || ch === 0x0d || ch === 0x0a) break;
      text += String.fromCharCode(ch);
    }
    const remaining = start;
    if (remaining === 0) {
      this.disk.remove(file);
      this.machine.forgetFile(file);
    } else {
      file.data = file.data.slice(0, remaining);
    }
    return text;
  }

  async execute(raw: string): Promise<void> {
    const line = raw.toUpperCase().replace(/\s+$/, '');
    if (!line.trim()) return;

    const space = line.indexOf(' ');
    const cmd = (space < 0 ? line : line.slice(0, space)).trim();
    const arg = space < 0 ? '' : line.slice(space + 1).trim();

    // Drive selection: "A:".
    const driveSwitch = cmd.match(/^([A-P]):$/);
    if (driveSwitch) {
      const index = driveSwitch[1].charCodeAt(0) - 65;
      if (index < this.machine.drives.length) {
        this.bdos.drive = index;
      } else {
        this.console.write(`${driveSwitch[1]}: NO DISK\r\n`);
      }
      return;
    }

    switch (cmd) {
      case 'DIR': return this.dir(arg);
      case 'ERA': return this.era(arg);
      case 'TYPE': return this.type(arg);
      case 'REN': return this.ren(arg);
      case 'USER': return this.user(arg);
      case 'SAVE': return this.save(arg);
      case 'XSUB': return this.xsub(arg);
      case 'DATE': return this.date();
      case 'CLS': this.console.write('\x1b[2J\x1b[H'); return;
      case 'HELP': return this.help();
      case 'EXIT':
        this.console.write('Session ended. Reload the page to boot again.\r\n');
        this.machine.stop();
        return;
    }

    if (BUILTINS.includes(cmd)) return;

    const parsed = parseName(cmd);
    if (!parsed) {
      this.console.write(`${cmd}?\r\n`);
      return;
    }
    const target = this.resolveDrive(parsed.drive);
    if (!target) {
      this.console.write('NO DISK\r\n');
      return;
    }
    const file = target.disk.find(this.bdos.user, parsed.name, padExt('COM'));
    if (!file) {
      this.console.write(`${cmd}?\r\n`);
      return;
    }
    if (file.data.length > 0xfa00) {
      this.console.write('PROGRAM TOO LARGE\r\n');
      return;
    }
    await this.machine.runCom(file, line);
    this.machine.refresh();
  }

  private dir(arg: string): void {
    const patternArg = arg && /^[A-P]:$/.test(arg) ? `${arg}*.*` : arg;
    const pattern = patternArg ? parseName(patternArg) : parseName('*.*');
    if (!pattern) { this.console.write('DIR?\r\n'); return; }
    const target = this.resolveDrive(pattern.drive);
    if (!target) { this.console.write('NO DISK\r\n'); return; }
    const files = target.disk.search(this.bdos.user, pattern.name, pattern.ext).filter((f) => !f.sys);
    if (!files.length) { this.console.write('NO FILE\r\n'); return; }
    const letter = this.driveLetterAt(target.index);
    const cells = files.map((f) => `${letter}: ${f.name} ${f.ext}`);
    for (let i = 0; i < cells.length; i += 4) {
      this.console.write(cells.slice(i, i + 4).join(' : ') + '\r\n');
    }
    this.console.write(`\r\n${files.length} file${files.length === 1 ? '' : 's'}\r\n`);
  }

  private era(arg: string): void {
    if (!arg) { this.console.write('ERA?\r\n'); return; }
    const patternArg = /^[A-P]:$/.test(arg) ? `${arg}*.*` : arg;
    const pattern = parseName(patternArg);
    if (!pattern) { this.console.write('ERA?\r\n'); return; }
    const target = this.resolveDrive(pattern.drive);
    if (!target) { this.console.write('NO DISK\r\n'); return; }
    const files = target.disk.search(this.bdos.user, pattern.name, pattern.ext);
    let deleted = 0;
    for (const f of files) {
      if (f.ro) { this.console.write(`${displayName(f)} R/O\r\n`); continue; }
      target.disk.remove(f);
      this.machine.forgetFile(f);
      deleted++;
    }
    if (!deleted) this.console.write('NO FILE\r\n');
  }

  private type(arg: string): void {
    if (!arg) { this.console.write('TYPE?\r\n'); return; }
    const parsed = parseName(arg);
    if (!parsed || parsed.name.includes('?')) { this.console.write('TYPE?\r\n'); return; }
    const target = this.resolveDrive(parsed.drive);
    if (!target) { this.console.write('NO DISK\r\n'); return; }
    const file = target.disk.find(this.bdos.user, parsed.name, parsed.ext);
    if (!file) { this.console.write('NO FILE\r\n'); return; }
    let last = 10;
    for (const b of file.data) {
      if (b === 0x1a) break;
      if (b === 13) this.console.write('\r\n');
      else if (b === 10) {
        if (last !== 13) this.console.write('\r\n');
      } else this.console.writeByte(b);
      last = b;
    }
    if (last !== 10) this.console.write('\r\n');
  }

  private ren(arg: string): void {
    const m = arg.match(/^(\S+)\s*=\s*(\S+)$/);
    if (!m) { this.console.write('REN?\r\n'); return; }
    const to = parseName(m[1]);
    const from = parseName(m[2]);
    if (!to || !from) { this.console.write('REN?\r\n'); return; }
    const fromIndex = from.drive ?? this.bdos.drive;
    const toIndex = to.drive ?? this.bdos.drive;
    if (fromIndex !== toIndex) { this.console.write('REN?\r\n'); return; }
    const target = this.resolveDrive(fromIndex);
    if (!target) { this.console.write('NO DISK\r\n'); return; }
    const file = target.disk.find(this.bdos.user, from.name, from.ext);
    if (!file) { this.console.write('NO FILE\r\n'); return; }
    if (target.disk.find(this.bdos.user, to.name, to.ext)) { this.console.write('FILE EXISTS\r\n'); return; }
    file.name = padName(to.name);
    file.ext = padExt(to.ext);
    this.machine.refresh();
  }

  private user(arg: string): void {
    const n = parseInt(arg, 10);
    if (Number.isNaN(n) || n < 0 || n > 15) { this.console.write('USER?\r\n'); return; }
    this.bdos.user = n;
    this.machine.refresh();
  }

  private xsub(arg: string): void {
    if (arg === 'OFF') {
      this.bdos.xsub = false;
      this.console.write('XSUB disabled\r\n');
    } else {
      this.bdos.xsub = true;
      this.console.write('XSUB enabled\r\n');
    }
  }

  private date(): void {
    const [lo, hi, hours, minutes] = this.bdos.clockStamp();
    const days = lo | (hi << 8);
    const d = new Date(Date.UTC(1978, 0, 1) + days * 86_400_000 + hours * 3_600_000 + minutes * 60_000);
    const iso = d.toISOString();
    this.console.write(`${iso.slice(0, 10)} ${iso.slice(11, 16)}\r\n`);
  }

  private save(arg: string): void {
    const m = arg.match(/^(\d{1,3})\s+(\S+)$/);
    if (!m) { this.console.write('SAVE?\r\n'); return; }
    const pages = parseInt(m[1], 10);
    if (pages < 1 || pages > 255) { this.console.write('SAVE?\r\n'); return; }
    const parsed = parseName(m[2]);
    if (!parsed) { this.console.write('SAVE?\r\n'); return; }
    const size = pages * 256;
    const data = this.machine.mem.slice(0x0100, 0x0100 + size);
    const target = this.resolveDrive(parsed.drive);
    if (!target) { this.console.write('NO DISK\r\n'); return; }
    const f = target.disk.put(parsed.name, parsed.ext, data, this.bdos.user);
    if (!f) { this.console.write('DISK FULL\r\n'); return; }
    this.machine.refresh();
  }

  private help(): void {
    const lines = [
      '',
      'INTERNAL COMMANDS',
      '  DIR [afn]       list files (e.g. DIR *.COM)',
      '  ERA afn         erase files',
      '  TYPE file       display a text file',
      '  REN new=old     rename a file',
      '  USER n          user area (0-15)',
      '  SAVE n file     save n 256-byte pages starting at 0100h',
      '  DATE            show the virtual clock',
      '  CLS             clear the screen',
      '  HELP            this help',
      '',
      'INCLUDED PROGRAMS',
      '  PIP   copy files            STAT  disk statistics',
      '  DDT   debugger              ED    text editor',
      '  ASM   8080 assembler        LOAD  convert .HEX to .COM',
      '  SUBMIT batch files          Try: SUBMIT DEMO',
      '  XSUB console input from SUBMIT files (XSUB / XSUB OFF)',
      '  HELLO demo                  Try: TYPE HELLO.ASM',
      '',
      'KEYS',
      '  Ctrl+C interrupt   Ctrl+H erase   Ctrl+U clear line',
      '',
      'TERMINAL',
      '  Choose ANSI/VT100, ADM-3A or VT52 in the console toolbar.',
      '',
      'Drives A: to D: are available. Use B: to switch, or',
      'prefix commands: DIR B:, TYPE C:FILE.TXT, PIP B:=A:FILE.',
      'Drag .COM/.TXT files onto the drive panel to import.',
      '',
    ];
    this.console.write(lines.join('\r\n'));
  }
}
