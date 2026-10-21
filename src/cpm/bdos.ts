import type { Z80 } from '../z80';
import { Disk, CpmFile, DriveFormat, allocation, padName, padExt } from './disk';
import { ConsoleIO, WarmBoot } from '../console';
import { ALV_ADDR, ALV_BYTES, DPB_ADDR } from './layout';

/** One directory entry of a search: entry `entry` of `file`, whose first block is `firstBlock`. */
type SearchEntry = { file: CpmFile; entry: number; firstBlock: number; fmt: DriveFormat };
type OpenFile = { file: CpmFile; disk: Disk };

/**
 * CP/M 2.2 BDOS.
 *
 * Programs reach this layer with `CALL 5`; the host intercepts execution at
 * 0xFE00 and calls handle().  All the classic file, directory and console
 * functions are implemented on top of the in-memory disks.
 */
export class Bdos {
  dma = 0x0080;
  user = 0;
  drive = 0;
  /** When true, console reads are taken from the pending $$$.SUB file. */
  xsub = false;

  private open = new Map<number, OpenFile>();
  /** Buffers with spare room that grow() made, and the file each belongs to. */
  private growth = new WeakMap<ArrayBufferLike, CpmFile>();
  private searchEntries: SearchEntry[] = [];
  private searchIndex = 0;
  private xsubLine: number[] = [];
  private rtcStamp: number[] | null = null;

  /** Bytes written through BDOS 5 / BIOS LIST. */
  readonly printerLog: number[] = [];
  /** Bytes written through BDOS 4 / BIOS PUNCH. */
  readonly serialLog: number[] = [];

  constructor(
    private cpu: Z80,
    public readonly drives: Disk[],
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
    this.xsub = false;
    this.xsubLine = [];
    this.rtcStamp = null;
    this.printerLog.length = 0;
    this.serialLog.length = 0;
  }

  /** State the CCP resets before running each program. */
  startProgram(): void {
    this.dma = 0x0080;
    this.open.clear();
    this.searchEntries = [];
    this.searchIndex = 0;
  }

  /** CP/M 3 style 4-byte time stamp: day word, hour, minute. */
  clockStamp(): number[] {
    if (this.rtcStamp) return [...this.rtcStamp];
    const epoch = Date.UTC(1978, 0, 1);
    const now = new Date();
    const localDay = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    const days = Math.floor((localDay - epoch) / 86_400_000);
    return [days & 0xff, (days >> 8) & 0xff, now.getHours(), now.getMinutes()];
  }

  setClockStamp(stamp: number[]): void {
    if (stamp.length >= 4) this.rtcStamp = stamp.slice(0, 4);
  }

  /** Forgets open FCBs that belong to one drive (used by the UI reset). */
  resetDrive(index: number): void {
    const disk = this.drives[index];
    if (!disk) return;
    for (const [addr, open] of this.open) if (open.disk === disk) this.open.delete(addr);
    this.searchEntries = [];
    this.searchIndex = 0;
  }

  /** Drops any open FCB that referred to a deleted file. */
  forget(file: CpmFile): void {
    for (const [addr, open] of this.open) if (open.file === file) this.open.delete(addr);
    this.searchEntries = [];
    this.searchIndex = 0;
  }

  /** The disk addressed by an FCB (0 = default drive, 1 = A:, ...). */
  private target(fcb: number): Disk | undefined {
    const d = this.mem[fcb] & 0x7f;
    if (d === 0) return this.drives[this.drive];
    if (d <= this.drives.length) return this.drives[d - 1];
    return undefined;
  }

  private currentDisk(): Disk {
    return this.drives[this.drive];
  }

  // ---- console input, optionally from a SUBMIT file (XSUB) --------------

  /**
   * The pending SUBMIT queue. SUBMIT.COM writes $$$.SUB to the current drive
   * and user area; the real CCP only looks on A:. Search A:, then the current
   * drive, then the rest, so a batch keeps running after it changes drive or
   * user area.
   */
  submitFile(): { disk: Disk; file: CpmFile } | undefined {
    const order = [0, this.drive, ...this.drives.keys()];
    const users = this.user === 0 ? [0] : [this.user, 0];
    for (const index of order) {
      const disk = this.drives[index];
      if (!disk) continue;
      for (const user of users) {
        const file = disk.find(user, '$$$     ', 'SUB');
        if (file) return { disk, file };
      }
    }
    return undefined;
  }

  /**
   * Removes the next queued command (the last 128-byte record) from $$$.SUB
   * and returns its text bytes, or null when no batch is pending.
   */
  popSubmitLine(): number[] | null {
    const found = this.submitFile();
    if (!found) return null;
    const { disk, file } = found;
    if (file.data.length < 128) {
      disk.remove(file);
      this.forget(file);
      return null;
    }
    const start = (Math.ceil(file.data.length / 128) - 1) * 128;
    const rec = file.data.subarray(start, start + 128);
    const len = Math.min(127, rec[0] ?? 0);
    const line: number[] = [];
    for (let i = 0; i < len; i++) {
      const ch = rec[1 + i];
      if (ch === 0) break;
      line.push(ch);
    }
    if (start === 0) disk.remove(file);
    else {
      file.data = file.data.slice(0, start);
      disk.markFilesDirty();
    }
    this.forget(file);
    return line;
  }

  private hasXsubInput(): boolean {
    if (this.xsubLine.length) return true;
    if (!this.xsub) return false;
    const found = this.submitFile();
    return !!found && found.file.data.length >= 128;
  }

  private hasConsoleInput(): boolean {
    return this.con.hasInput() || this.hasXsubInput();
  }

  /** Loads the next queued line from $$$.SUB into the XSUB buffer. */
  private loadXsubLine(): void {
    const line = this.popSubmitLine();
    if (line) this.xsubLine = [...line, 13];
  }

  private async readChar(): Promise<number> {
    if (this.xsub && !this.xsubLine.length) this.loadXsubLine();
    if (this.xsubLine.length) return this.xsubLine.shift()!;
    return this.con.readByte();
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
    return d === 0 || (d >= 1 && d <= this.drives.length);
  }
  private fileFor(fcb: number): OpenFile | undefined {
    const n = this.fcbName(fcb);
    const disk = this.target(fcb);
    if (!disk) return undefined;
    // The cache is keyed by FCB address; only trust it while that FCB still
    // names the same file (programs reuse FCBs for different files).
    const open = this.open.get(fcb);
    if (open && open.disk === disk && open.file.name === n.name && open.file.ext === n.ext &&
        open.file.user === this.user && disk.files.includes(open.file)) {
      return open;
    }
    this.open.delete(fcb);
    const found = disk.find(this.user, n.name, n.ext);
    if (!found) return undefined;
    const entry = { file: found, disk };
    this.open.set(fcb, entry);
    return entry;
  }

  private setOpenState(fcb: number, f: CpmFile, disk: Disk): void {
    this.open.set(fcb, { file: f, disk });
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

  /**
   * Returns `data` extended to `length` bytes. Spare room is kept after the
   * end so appending one record at a time does not copy the whole file each
   * time.
   */
  private grow(f: CpmFile, length: number): Uint8Array {
    const data = f.data;
    // Only reuse spare room in a buffer this BDOS allocated for this file.
    if (this.growth.get(data.buffer) === f && data.byteOffset === 0 && data.buffer.byteLength >= length) {
      const view = new Uint8Array(data.buffer, 0, length);
      view.fill(0, data.length);
      return view;
    }
    const buf = new Uint8Array(Math.max(length, data.length * 2, 16384));
    buf.set(data);
    this.growth.set(buf.buffer, f);
    return buf.subarray(0, length);
  }

  private writeRecord(f: CpmFile, record: number, disk: Disk): boolean {
    const off = record * 128;
    const end = off + 128;
    if (f.data.length < end) {
      const fmt = disk.format;
      const newBlock = allocation(fmt, end).blocks > allocation(fmt, f.data.length).blocks;
      if (newBlock && !disk.canStore(f, end)) return false; // disk or directory full
      f.data = this.grow(f, end);
    }
    f.data.set(this.mem.subarray(this.dma, this.dma + 128), off);
    disk.markFilesDirty();
    return true;
  }

  private seqRecord(fcb: number): number {
    return (this.mem[(fcb + 12) & 0xffff] * 128) + this.mem[(fcb + 32) & 0xffff];
  }

  private setSeqRecord(fcb: number, record: number): void {
    this.mem[(fcb + 12) & 0xffff] = (record >> 7) & 0xff;
    this.mem[(fcb + 32) & 0xffff] = record & 0x7f;
    const f = this.open.get(fcb)?.file;
    this.mem[(fcb + 15) & 0xffff] = f ? Math.min(128, Disk.extentRecords(f, record >> 7)) : 0;
  }

  private randomRecord(fcb: number): number {
    return this.mem[(fcb + 33) & 0xffff] |
      (this.mem[(fcb + 34) & 0xffff] << 8) |
      (this.mem[(fcb + 35) & 0xffff] << 16);
  }

  /**
   * Block numbers the drive's files would occupy if laid out one after the
   * other after the directory. Used for search results and the allocation
   * vector, so STAT and directory tools see consistent sizes.
   */
  private blockLayout(disk: Disk): { first: Map<CpmFile, number>; used: number } {
    const fmt = disk.format;
    const first = new Map<CpmFile, number>();
    let next = fmt.reservedBlocks;
    for (const f of disk.files) {
      first.set(f, next);
      next += allocation(fmt, f.data.length).blocks;
    }
    return { first, used: next };
  }

  /** Writes a CP/M directory entry for a search result at the DMA address. */
  private dirEntry(ent: SearchEntry): void {
    const { file: f, fmt } = ent;
    const m = this.mem;
    const base = this.dma;
    m.fill(0, base, base + 32);
    m[base] = f.user;
    for (let i = 0; i < 8; i++) m[base + 1 + i] = f.name.charCodeAt(i);
    for (let i = 0; i < 3; i++) m[base + 9 + i] = f.ext.charCodeAt(i);
    if (f.ro) m[base + 9] |= 0x80;
    if (f.sys) m[base + 10] |= 0x80;
    const per = fmt.extentsPerEntry;
    const entryBytes = per * 16384;
    const start = ent.entry * entryBytes;
    const length = Math.min(entryBytes, Math.max(0, f.data.length - start));
    const records = Math.ceil(length / 128);
    // EX/S2 name the last logical extent in the entry; RC counts its records.
    const last = records ? Math.floor((records - 1) / 128) : 0;
    const extent = ent.entry * per + last;
    m[base + 12] = extent & 0x1f;
    m[base + 14] = (extent >> 5) & 0x3f;
    m[base + 15] = records - last * 128;
    const blocks = Math.ceil(length / fmt.blockSize);
    const first = ent.firstBlock + (ent.entry * entryBytes) / fmt.blockSize;
    for (let i = 0; i < blocks; i++) {
      const b = Math.min(fmt.dsm, first + i);
      if (fmt.wide) {
        m[base + 16 + i * 2] = b & 0xff;
        m[base + 17 + i * 2] = b >> 8;
      } else {
        m[base + 16 + i] = b;
      }
    }
  }

  // ---- entry point ------------------------------------------------------

  async handle(): Promise<void> {
    const fn = this.cpu.c;
    const de = this.cpu.de;

    // Raw BIOS writes may have changed the directory; refresh the file view.
    const active = this.currentDisk();
    if (active.imageDirty) active.syncImage();

    switch (fn) {
      case 0: // P_TERMCPM
        this.onWarmBoot();
        return;

      case 1: { // C_READ
        const ch = await this.readChar();
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
        this.serialLog.push(this.cpu.e & 0xff);
        if (this.serialLog.length > 1_000_000) this.serialLog.splice(0, 500_000);
        break;

      case 5: // L_WRITE
        this.printerLog.push(this.cpu.e & 0xff);
        if (this.printerLog.length > 1_000_000) this.printerLog.splice(0, 500_000);
        break;

      case 6: { // C_RAWIO
        const e = this.cpu.e;
        if (e === 0xff) {
          // Non-blocking: returns 0 when no key is waiting.
          if (this.xsub && !this.xsubLine.length) this.loadXsubLine();
          const ch = this.xsubLine.length ? this.xsubLine.shift()! : this.con.pollByte();
          this.result(ch ?? 0);
        } else if (e === 0xfe) {
          this.result(this.hasConsoleInput() ? 0xff : 0);
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
          const ch = await this.readChar();
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
        this.result(this.hasConsoleInput() ? 0xff : 0);
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
        const d = this.cpu.e & 0xff;
        if (d >= this.drives.length) { this.result(0xff); break; }
        this.drive = d;
        this.result(0);
        break;
      }

      case 15: { // F_OPEN
        const n = this.fcbName(de);
        const disk = this.target(de);
        if (!disk) { this.result(0xff); break; }
        const f = disk.find(this.user, n.name, n.ext);
        if (!f) { this.result(0xff); break; }
        this.setOpenState(de, f, disk);
        this.result(0);
        break;
      }

      case 16: // F_CLOSE
        this.result(this.open.has(de) || this.fileFor(de) ? 0 : 0xff);
        break;

      case 17: { // F_SFIRST
        const n = this.fcbName(de);
        const disk = this.target(de);
        if (!disk) { this.result(0xff); break; }
        const files = disk.search(this.user, n.name, n.ext);
        const fmt = disk.format;
        const layout = this.blockLayout(disk);
        this.searchEntries = [];
        for (const f of files) {
          const { entries } = allocation(fmt, f.data.length);
          const firstBlock = layout.first.get(f) ?? fmt.reservedBlocks;
          for (let e = 0; e < entries; e++) this.searchEntries.push({ file: f, entry: e, firstBlock, fmt });
        }
        this.searchIndex = 0;
        if (!this.searchEntries.length) { this.result(0xff); break; }
        this.dirEntry(this.searchEntries[0]);
        this.searchIndex = 1;
        this.result(0);
        break;
      }

      case 18: { // F_SNEXT
        if (this.searchIndex >= this.searchEntries.length) { this.result(0xff); break; }
        this.dirEntry(this.searchEntries[this.searchIndex++]);
        this.result(0);
        break;
      }

      case 19: { // F_DELETE
        const n = this.fcbName(de);
        const disk = this.target(de);
        if (!disk) { this.result(0xff); break; }
        const files = disk.search(this.user, n.name, n.ext);
        let any = false;
        for (const f of files) {
          if (f.ro) continue;
          disk.remove(f);
          for (const [addr, open] of this.open) if (open.file === f) this.open.delete(addr);
          any = true;
        }
        this.result(any ? 0 : 0xff);
        break;
      }

      case 20: { // F_READ
        const entry = this.fileFor(de);
        if (!entry) { this.result(1); break; }
        const rec = this.seqRecord(de);
        if (!this.readRecord(entry.file, rec)) { this.result(1); break; }
        this.setSeqRecord(de, rec + 1);
        this.result(0);
        break;
      }

      case 21: { // F_WRITE
        const entry = this.fileFor(de);
        if (!entry) { this.result(1); break; }
        if (entry.file.ro) { this.result(2); break; }
        const rec = this.seqRecord(de);
        if (!this.writeRecord(entry.file, rec, entry.disk)) { this.result(2); break; }
        this.setSeqRecord(de, rec + 1);
        this.result(0);
        break;
      }

      case 22: { // F_MAKE
        const n = this.fcbName(de);
        const disk = this.target(de);
        if (!disk) { this.result(0xff); break; }
        // A new file needs a free directory entry.
        if (!disk.find(this.user, n.name, n.ext) && !disk.canStore(null, 0)) { this.result(0xff); break; }
        const f = disk.create(this.user, n.name, n.ext);
        if ('error' in f) { this.result(0xff); break; }
        this.setOpenState(de, f, disk);
        this.result(0);
        break;
      }

      case 23: { // F_RENAME
        const oldName = this.fcbName(de);
        const disk = this.target(de);
        if (!disk) { this.result(0xff); break; }
        let nn = '';
        let ne = '';
        for (let i = 0; i < 8; i++) nn += String.fromCharCode(this.mem[(de + 17 + i) & 0xffff] & 0x7f);
        for (let i = 0; i < 3; i++) ne += String.fromCharCode(this.mem[(de + 25 + i) & 0xffff] & 0x7f);
        const newName = padName(nn.trimEnd().toUpperCase());
        const newExt = padExt(ne.trimEnd().toUpperCase());
        const f = disk.find(this.user, oldName.name, oldName.ext);
        if (!f || disk.find(this.user, newName, newExt)) { this.result(0xff); break; }
        f.name = newName;
        f.ext = newExt;
        disk.markFilesDirty();
        this.result(0);
        break;
      }

      case 24: // DRV_LOGINVEC
        this.resultHL((1 << this.drives.length) - 1);
        break;

      case 25: // DRV_GET
        this.result(this.drive);
        break;

      case 26: // F_DMAOFF
        this.dma = de;
        this.result(0);
        break;

      case 27: { // DRV_ALLOCVEC: one bit per block, set when in use
        const disk = this.currentDisk();
        const blocks = disk.format.dsm + 1;
        const used = Math.min(blocks, this.blockLayout(disk).used);
        this.mem.fill(0, ALV_ADDR, ALV_ADDR + Math.min(ALV_BYTES, Math.ceil(blocks / 8)));
        for (let b = 0; b < used; b++) this.mem[ALV_ADDR + (b >> 3)] |= 0x80 >> (b & 7);
        this.resultHL(ALV_ADDR);
        break;
      }

      case 28: // DRV_SETRO
        this.result(0);
        break;

      case 29: // DRV_ROVEC
        this.resultHL(0);
        break;

      case 30: { // F_ATTRIB
        const n = this.fcbName(de);
        const disk = this.target(de);
        if (!disk) { this.result(0xff); break; }
        const f = disk.find(this.user, n.name, n.ext);
        if (!f) { this.result(0xff); break; }
        f.ro = n.ro;
        f.sys = n.sys;
        disk.markFilesDirty();
        this.result(0);
        break;
      }

      case 31: { // DRV_DPB
        this.mem.set(this.currentDisk().format.dpb(), DPB_ADDR);
        this.resultHL(DPB_ADDR);
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
        const entry = this.fileFor(de);
        if (!entry) { this.result(1); break; }
        const rec = this.randomRecord(de);
        if (rec > 0xffff) { this.result(6); break; }
        if (!this.readRecord(entry.file, rec)) { this.result(1); break; }
        // CP/M 2.2 leaves the FCB on this record: the next sequential read rereads it.
        this.setSeqRecord(de, rec);
        this.result(0);
        break;
      }

      case 34: { // F_WRITERAND
        const entry = this.fileFor(de);
        if (!entry) { this.result(1); break; }
        if (entry.file.ro) { this.result(2); break; }
        const rec = this.randomRecord(de);
        if (rec > 0xffff) { this.result(6); break; }
        if (!this.writeRecord(entry.file, rec, entry.disk)) { this.result(2); break; }
        this.setSeqRecord(de, rec);
        this.result(0);
        break;
      }

      case 35: { // F_SIZE
        const entry = this.fileFor(de);
        if (!entry) { this.result(0xff); break; }
        const records = Math.ceil(entry.file.data.length / 128) & 0xffffff;
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
        const entry = this.fileFor(de);
        if (!entry) { this.result(1); break; }
        if (entry.file.ro) { this.result(2); break; }
        const rec = this.randomRecord(de);
        if (rec > 0xffff) { this.result(6); break; }
        if (!this.writeRecord(entry.file, rec, entry.disk)) { this.result(2); break; }
        this.setSeqRecord(de, rec);
        this.result(0);
        break;
      }

      case 104: { // T_SET (CP/M 3 style extension)
        this.setClockStamp([
          this.mem[de], this.mem[(de + 1) & 0xffff],
          this.mem[(de + 2) & 0xffff], this.mem[(de + 3) & 0xffff],
        ]);
        this.result(0);
        break;
      }

      case 105: { // T_GET (CP/M 3 style extension)
        const stamp = this.clockStamp();
        for (let i = 0; i < 4; i++) this.mem[(de + i) & 0xffff] = stamp[i];
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
