import type { Z80 } from '../z80';
import { Disk, CpmFile, padName, padExt, MAX_BYTES } from './disk';
import { ConsoleIO, WarmBoot } from '../console';

type SearchEntry = { file: CpmFile; extent: number };

/**
 * CP/M 2.2 BDOS.
 *
 * Programs reach this layer with `CALL 5`; the host intercepts execution at
 * 0xFE00 and calls handle().  All the classic file, directory and console
 * functions are implemented on top of the in-memory disk.
 */
export class Bdos {
  dma = 0x0080;
  user = 0;
  drive = 0; // only A: exists

  private open = new Map<number, CpmFile>();
  private searchEntries: SearchEntry[] = [];
  private searchIndex = 0;

  constructor(
    private cpu: Z80,
    private disk: Disk,
    private con: ConsoleIO,
    private onWarmBoot: () => void,
  ) {}

  reset(): void {
    this.dma = 0x0080;
    this.user = 0;
    this.drive = 0;
    this.open.clear();
    this.searchEntries = [];
    this.searchIndex = 0;
  }

  /** Drops any open FCB that referred to a deleted file. */
  forget(file: CpmFile): void {
    for (const [addr, open] of this.open) if (open === file) this.open.delete(addr);
    this.searchEntries = [];
    this.searchIndex = 0;
  }

  // ---- helpers ----------------------------------------------------------

  private get mem(): Uint8Array { return this.cpu.mem; }

  private ret(): void {
    const sp = this.cpu.sp;
    const lo = this.mem[sp];
    const hi = this.mem[(sp + 1) & 0xffff];
    this.cpu.sp = (sp + 2) & 0xffff;
    this.cpu.pc = lo | (hi << 8);
  }

  private result(v: number): void {
    v &= 0xff;
    this.cpu.a = v;
    this.cpu.b = 0;
    this.cpu.h = 0;
    this.cpu.l = v;
  }

  private resultHL(v: number): void {
    this.cpu.h = (v >> 8) & 0xff;
    this.cpu.l = v & 0xff;
    this.cpu.a = this.cpu.l;
    this.cpu.b = this.cpu.h;
  }

  private fcbName(fcb: number): { name: string; ext: string; ro: boolean; sys: boolean; drive: number } {
    let name = '';
    let ext = '';
    for (let i = 0; i < 8; i++) {
      const ch = this.mem[(fcb + 1 + i) & 0xffff] & 0x7f;
      name += String.fromCharCode(ch || 0x20);
    }
    for (let i = 0; i < 3; i++) {
      const ch = this.mem[(fcb + 9 + i) & 0xffff] & 0x7f;
      ext += String.fromCharCode(ch || 0x20);
    }
    return {
      name: padName(name.trimEnd().toUpperCase()),
      ext: padExt(ext.trimEnd().toUpperCase()),
      ro: (this.mem[(fcb + 9) & 0xffff] & 0x80) !== 0,
      sys: (this.mem[(fcb + 10) & 0xffff] & 0x80) !== 0,
      drive: this.mem[fcb] & 0x7f,
    };
  }

  private validDrive(d: number): boolean {
    return d === 0 || d === 1; // FCB 0 = default, 1 = A:
  }

  private fileFor(fcb: number): CpmFile | undefined {
    const f = this.open.get(fcb);
    if (f) return f;
    const n = this.fcbName(fcb);
    if (!this.validDrive(n.drive)) return undefined;
    const found = this.disk.find(this.user, n.name, n.ext);
    if (found) this.open.set(fcb, found);
    return found;
  }

  private setOpenState(fcb: number, f: CpmFile): void {
    this.open.set(fcb, f);
    this.mem[(fcb + 12) & 0xffff] = 0; // EX
    this.mem[(fcb + 13) & 0xffff] = 0; // S1
    this.mem[(fcb + 14) & 0xffff] = 0; // S2
    this.mem[(fcb + 15) & 0xffff] = Math.min(128, Disk.extentRecords(f, 0));
    this.mem[(fcb + 32) & 0xffff] = 0; // CR
    for (let i = 0; i < 16; i++) this.mem[(fcb + 16 + i) & 0xffff] = 0;
    const blocks = Math.min(16, Math.ceil(f.data.length / 16384));
    for (let i = 0; i < blocks; i++) this.mem[(fcb + 16 + i) & 0xffff] = (1 + i) & 0xff;
  }

  private readRecord(f: CpmFile, record: number): boolean {
    const off = record * 128;
    if (off >= f.data.length) return false;
    const n = Math.min(128, f.data.length - off);
    this.mem.fill(0, this.dma, this.dma + 128);
    this.mem.set(f.data.subarray(off, off + n), this.dma);
    return true;
  }

  private writeRecord(f: CpmFile, record: number): boolean {
    const off = record * 128;
    const end = off + 128;
    if (f.data.length < end) {
      const grown = new Uint8Array(end);
      grown.set(f.data);
      if (this.disk.usedBytes() - f.data.length + grown.length > MAX_BYTES) return false;
      f.data = grown;
    }
    f.data.set(this.mem.subarray(this.dma, this.dma + 128), off);
    return true;
  }

  private seqRecord(fcb: number): number {
    return (this.mem[(fcb + 12) & 0xffff] * 128) + this.mem[(fcb + 32) & 0xffff];
  }

  private setSeqRecord(fcb: number, record: number): void {
    this.mem[(fcb + 12) & 0xffff] = (record >> 7) & 0xff;
    this.mem[(fcb + 32) & 0xffff] = record & 0x7f;
    const f = this.open.get(fcb);
    this.mem[(fcb + 15) & 0xffff] = f ? Math.min(128, Disk.extentRecords(f, record >> 7)) : 0;
  }

  private randomRecord(fcb: number): number {
    return this.mem[(fcb + 33) & 0xffff] |
      (this.mem[(fcb + 34) & 0xffff] << 8) |
      (this.mem[(fcb + 35) & 0xffff] << 16);
  }

  private dirEntry(fcb: number, f: CpmFile, extent: number): void {
    const base = this.dma;
    this.mem.fill(0, base, base + 32);
    this.mem[base] = f.user;
    for (let i = 0; i < 8; i++) this.mem[base + 1 + i] = f.name.charCodeAt(i);
    for (let i = 0; i < 3; i++) this.mem[base + 9 + i] = f.ext.charCodeAt(i);
    if (f.ro) this.mem[base + 9] |= 0x80;
    if (f.sys) this.mem[base + 10] |= 0x80;
    this.mem[base + 12] = extent;
    this.mem[base + 15] = Math.min(128, Disk.extentRecords(f, extent));
    const blocks = Math.min(16, Math.ceil(Math.max(0, f.data.length - extent * 16384) / 16384));
    for (let i = 0; i < blocks; i++) this.mem[base + 16 + i] = (1 + extent * 8 + i) & 0xff;
  }

  // ---- entry point ------------------------------------------------------

  async handle(): Promise<void> {
    const fn = this.cpu.c;
    const de = this.cpu.de;

    switch (fn) {
      case 0: // P_TERMCPM
        this.onWarmBoot();
        return;

      case 1: { // C_READ
        const ch = await this.con.readByte();
        this.con.writeByte(ch);
        this.result(ch);
        break;
      }

      case 2: // C_WRITE
        this.con.writeByte(this.cpu.e);
        break;

      case 3: // A_READ
        this.result(0x1a);
        break;

      case 4: // A_WRITE
        break;

      case 5: // L_WRITE
        break;

      case 6: { // C_RAWIO
        const e = this.cpu.e;
        if (e === 0xff) {
          const ch = await this.con.readByte();
          this.result(ch);
        } else if (e === 0xfe) {
          this.result(this.con.pollByte() !== undefined ? 0xff : 0);
        } else {
          this.con.writeByte(e);
        }
        break;
      }

      case 7: // A_GETIOB
        this.result(this.mem[3] ?? 0);
        break;

      case 8: // A_SETIOB
        this.mem[3] = this.cpu.e;
        this.result(0);
        break;

      case 9: { // C_WRITESTR
        let a = de;
        for (let n = 0; n < 65536; n++) {
          const c = this.mem[a];
          if (c === 0x24) break;
          this.con.writeByte(c);
          a = (a + 1) & 0xffff;
        }
        break;
      }

      case 10: { // C_READSTR
        const max = this.mem[de];
        let count = 0;
        this.cpu.a = 0;
        for (;;) {
          const ch = await this.con.readByte();
          if (ch === 13) {
            this.con.writeByte(13);
            this.con.writeByte(10);
            break;
          }
          if (ch === 10) continue;
          if (ch === 3) {
            this.con.write('\r\n^C\r\n');
            throw new WarmBoot();
          }
          if (ch === 8 || ch === 127) {
            if (count > 0) {
              count--;
              this.con.write('\b \b');
            }
            continue;
          }
          if (ch === 21 || ch === 24) { // ^U / ^X
            while (count > 0) {
              count--;
              this.con.write('\b \b');
            }
            continue;
          }
          if (ch === 5) { this.con.write('\r\n'); continue; }
          if (ch === 18) { this.con.write('\r\n'); continue; }
          if (ch === 19) continue; // ^S
          if (ch >= 32 && ch < 127) {
            if (count < max) {
              this.mem[(de + 2 + count) & 0xffff] = ch;
              count++;
              this.con.writeByte(ch);
            }
          }
        }
        this.mem[(de + 1) & 0xffff] = count;
        this.result(0);
        break;
      }

      case 11: // C_STAT
        this.result(this.con.pollByte() !== undefined ? 0xff : 0);
        break;

      case 12: // S_BDOSVER: CP/M 2.2
        this.cpu.h = 0x00;
        this.cpu.l = 0x22;
        this.cpu.a = 0x22;
        this.cpu.b = 0x00;
        break;

      case 13: { // DRV_ALLRESET
        this.drive = 0;
        this.open.clear();
        this.result(0);
        break;
      }

      case 14: { // DRV_SET
        const d = this.cpu.e & 0x0f;
        if (d !== 0) { this.result(0xff); break; }
        this.drive = 0;
        this.result(0);
        break;
      }

      case 15: { // F_OPEN
        const n = this.fcbName(de);
        if (!this.validDrive(n.drive)) { this.result(0xff); break; }
        const f = this.disk.find(this.user, n.name, n.ext);
        if (!f) { this.result(0xff); break; }
        this.setOpenState(de, f);
        this.result(0);
        break;
      }

      case 16: // F_CLOSE
        this.result(this.open.has(de) || this.fileFor(de) ? 0 : 0xff);
        break;

      case 17: { // F_SFIRST
        const n = this.fcbName(de);
        if (!this.validDrive(n.drive)) { this.result(0xff); break; }
        const files = this.disk.search(this.user, n.name, n.ext);
        this.searchEntries = [];
        for (const f of files) {
          const extents = Disk.extents(f);
          for (let e = 0; e < extents; e++) this.searchEntries.push({ file: f, extent: e });
        }
        this.searchIndex = 0;
        if (!this.searchEntries.length) { this.result(0xff); break; }
        {
          const ent = this.searchEntries[0];
          this.dirEntry(de, ent.file, ent.extent);
          this.searchIndex = 1;
          this.result(0);
        }
        break;
      }

      case 18: { // F_SNEXT
        if (this.searchIndex >= this.searchEntries.length) { this.result(0xff); break; }
        const ent = this.searchEntries[this.searchIndex++];
        this.dirEntry(de, ent.file, ent.extent);
        this.result(0);
        break;
      }

      case 19: { // F_DELETE
        const n = this.fcbName(de);
        if (!this.validDrive(n.drive)) { this.result(0xff); break; }
        const files = this.disk.search(this.user, n.name, n.ext);
        let any = false;
        for (const f of files) {
          if (f.ro) continue;
          this.disk.remove(f);
          for (const [addr, open] of this.open) if (open === f) this.open.delete(addr);
          any = true;
        }
        this.result(any ? 0 : 0xff);
        break;
      }

      case 20: { // F_READ
        const f = this.fileFor(de);
        if (!f) { this.result(1); break; }
        const rec = this.seqRecord(de);
        if (!this.readRecord(f, rec)) { this.result(1); break; }
        this.setSeqRecord(de, rec + 1);
        this.result(0);
        break;
      }

      case 21: { // F_WRITE
        const f = this.fileFor(de);
        if (!f) { this.result(1); break; }
        if (f.ro) { this.result(2); break; }
        const rec = this.seqRecord(de);
        if (!this.writeRecord(f, rec)) { this.result(2); break; }
        this.setSeqRecord(de, rec + 1);
        this.result(0);
        break;
      }

      case 22: { // F_MAKE
        const n = this.fcbName(de);
        if (!this.validDrive(n.drive)) { this.result(0xff); break; }
        const f = this.disk.create(this.user, n.name, n.ext);
        if ('error' in f) { this.result(0xff); break; }
        this.setOpenState(de, f);
        this.result(0);
        break;
      }

      case 23: { // F_RENAME
        const oldName = this.fcbName(de);
        let nn = '';
        let ne = '';
        for (let i = 0; i < 8; i++) nn += String.fromCharCode(this.mem[(de + 17 + i) & 0xffff] & 0x7f);
        for (let i = 0; i < 3; i++) ne += String.fromCharCode(this.mem[(de + 25 + i) & 0xffff] & 0x7f);
        const newName = padName(nn.trimEnd().toUpperCase());
        const newExt = padExt(ne.trimEnd().toUpperCase());
        const f = this.disk.find(this.user, oldName.name, oldName.ext);
        if (!f || this.disk.find(this.user, newName, newExt)) { this.result(0xff); break; }
        f.name = newName;
        f.ext = newExt;
        this.result(0);
        break;
      }

      case 24: // DRV_LOGINVEC
        this.resultHL(1);
        break;

      case 25: // DRV_GET
        this.result(this.drive);
        break;

      case 26: // F_DMAOFF
        this.dma = de;
        this.result(0);
        break;

      case 27: // DRV_ALLOCVEC
        this.resultHL(0xfd50);
        this.mem.fill(0, 0xfd50, 0xfe00);
        break;

      case 28: // DRV_SETRO
        this.result(0);
        break;

      case 29: // DRV_ROVEC
        this.resultHL(0);
        break;

      case 30: { // F_ATTRIB
        const n = this.fcbName(de);
        const f = this.disk.find(this.user, n.name, n.ext);
        if (!f) { this.result(0xff); break; }
        f.ro = n.ro;
        f.sys = n.sys;
        this.result(0);
        break;
      }

      case 31: { // DRV_DPB
        const dpb = 0xfd40;
        const bytes = [
          0x40, 0x00, // SPT = 64
          0x07, // BSH = 7 (16K blocks)
          0x7f, // BLM = 127
          0x00, // EXM = 0
          0xff, 0x00, // DSM = 255 (4 MB drive)
          0xff, 0x01, // DRM = 511
          0xf0, 0x00, // AL0/AL1
          0x00, 0x00, // CKS
          0x02, 0x00, // OFF
        ];
        this.mem.set(bytes, dpb);
        this.resultHL(dpb);
        break;
      }

      case 32: { // F_USERNUM
        if (this.cpu.e === 0xff) this.result(this.user);
        else {
          this.user = this.cpu.e & 0x0f;
          this.result(this.user);
        }
        break;
      }

      case 33: { // F_READRAND
        const f = this.fileFor(de);
        if (!f) { this.result(1); break; }
        const rec = this.randomRecord(de);
        if (!this.readRecord(f, rec)) { this.result(1); break; }
        this.setSeqRecord(de, rec + 1);
        this.result(0);
        break;
      }

      case 34: { // F_WRITERAND
        const f = this.fileFor(de);
        if (!f) { this.result(1); break; }
        if (f.ro) { this.result(2); break; }
        const rec = this.randomRecord(de);
        if (!this.writeRecord(f, rec)) { this.result(2); break; }
        this.setSeqRecord(de, rec + 1);
        this.result(0);
        break;
      }

      case 35: { // F_SIZE
        const f = this.fileFor(de);
        if (!f) { this.result(0xff); break; }
        const records = Math.ceil(f.data.length / 128) & 0xffffff;
        this.mem[(de + 33) & 0xffff] = records & 0xff;
        this.mem[(de + 34) & 0xffff] = (records >> 8) & 0xff;
        this.mem[(de + 35) & 0xffff] = (records >> 16) & 0xff;
        this.result(0);
        break;
      }

      case 36: { // F_RANDREC
        const rec = this.seqRecord(de) & 0xffffff;
        this.mem[(de + 33) & 0xffff] = rec & 0xff;
        this.mem[(de + 34) & 0xffff] = (rec >> 8) & 0xff;
        this.mem[(de + 35) & 0xffff] = (rec >> 16) & 0xff;
        this.result(0);
        break;
      }

      case 37: // DRV_RESET
        this.result(0);
        break;

      case 38: case 39: // unused in CP/M 2.2
        this.result(0);
        break;

      case 40: { // F_WRITEZF
        const f = this.fileFor(de);
        if (!f) { this.result(1); break; }
        if (f.ro) { this.result(2); break; }
        const rec = this.randomRecord(de);
        if (!this.writeRecord(f, rec)) { this.result(2); break; }
        this.setSeqRecord(de, rec + 1);
        this.result(0);
        break;
      }

      default:
        this.result(0);
        break;
    }

    this.ret();
  }
}
