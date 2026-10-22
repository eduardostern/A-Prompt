import { CpmFile, DriveFormat, padExt, padName, trimName } from './disk';

export interface Geometry {
  spt: number;
  tracks: number;
  blockSize: number;
  bsh: number;
  blm: number;
  exm: number;
  dsm: number;
  drm: number;
  off: number;
  al0: number;
  al1: number;
}

export interface DiskImageInfo {
  geometry: Geometry;
  bytes: Uint8Array;
}

const DIR_ENTRY = 32;
const RECORD = 128;
/** A logical extent: the 128 records one EX value counts. */
const LOGICAL_EXTENT = 16 * 1024;

/** IBM 3740 8" SSSD skew (factor 6): logical sector -> physical, 0-based. */
const SKEW_3740: readonly number[] = [
  1, 7, 13, 19, 25, 5, 11, 17, 23, 3, 9, 15, 21, 2, 8, 14, 20, 26, 6, 12, 18, 24, 4, 10, 16, 22,
].map((s) => s - 1);

// EXM follows the DRI table for DSM < 256: 1K blocks -> 0, 2K -> 1, 16K -> 15.
const G8: Geometry = {
  spt: 26, tracks: 77, blockSize: 1024, bsh: 3, blm: 7, exm: 0,
  dsm: 242, drm: 63, off: 2, al0: 0xc0, al1: 0,
};

const G512: Geometry = {
  spt: 64, tracks: 64, blockSize: 2048, bsh: 4, blm: 15, exm: 1,
  dsm: 239, drm: 511, off: 2, al0: 0xff, al1: 0,
};

const G4M: Geometry = {
  spt: 64, tracks: 512, blockSize: 16384, bsh: 7, blm: 127, exm: 15,
  dsm: 255, drm: 511, off: 2, al0: 0x80, al1: 0,
};

/**
 * z80pack's 4MB hard disk (cpmsim drives I: and J:, e.g. hd-tools.dsk):
 * 255 tracks of 128 sectors, 2K blocks, no system tracks, no skew. DSM > 255
 * means 16-bit block pointers, eight per directory entry. DPB as in
 * z80pack's cpmsim/srccpm2/bios.asm (HDBLK).
 */
const GZ80PACK_HD: Geometry = {
  spt: 128, tracks: 255, blockSize: 2048, bsh: 4, blm: 15, exm: 0,
  dsm: 2039, drm: 1023, off: 0, al0: 0xff, al1: 0xff,
};

export function geometryForSize(size: number): Geometry | null {
  if (size === G8.tracks * G8.spt * 128) return { ...G8 };
  if (size === G512.tracks * G512.spt * 128) return { ...G512 };
  if (size === G4M.tracks * G4M.spt * 128) return { ...G4M };
  if (size === GZ80PACK_HD.tracks * GZ80PACK_HD.spt * 128) return { ...GZ80PACK_HD };
  // Generic 8" image: 128-byte sectors, 26 per track.
  if (size % (26 * 128) !== 0) return null;
  const tracks = size / (26 * 128);
  if (tracks < 35 || tracks > 85) return null;
  // 1K blocks need DSM < 256 (8-bit pointers); longer disks leave the tail unused.
  const dsm = Math.min(255, Math.floor(((tracks - G8.off) * 26 * 128) / G8.blockSize) - 1);
  return {
    ...G8,
    tracks,
    dsm,
  };
}

/**
 * A raw CP/M 2.2 disk image.  The directory and allocation blocks are decoded
 * into CpmFile objects for the BDOS, and re-encoded after writes.
 *
 * Sector numbers seen by the BIOS are logical (0-based); on 8" images the
 * data tracks are stored in physical order with the standard skew, like
 * cpmtools' ibm-3740 format and z80pack.
 */
export class DiskImage implements DriveFormat {
  readonly data: Uint8Array;
  readonly geometry: Geometry;
  /** Logical -> physical sector map for the data tracks, or null for none. */
  readonly xlt: readonly number[] | null;

  private constructor(data: Uint8Array, geometry: Geometry, xlt: readonly number[] | null) {
    this.data = data;
    this.geometry = geometry;
    this.xlt = xlt;
  }

  static fromBytes(input: Uint8Array): DiskImage | null {
    const geometry = geometryForSize(input.length);
    if (!geometry) return null;
    const data = input.slice();
    if (geometry.spt !== 26) return new DiskImage(data, geometry, null);
    // Standard 8" images are skewed, but older A-Prompt exports were not.
    // Use the reading whose directory looks valid; on a tie, the standard.
    const skewed = new DiskImage(data, geometry, SKEW_3740);
    const plain = new DiskImage(data, geometry, null);
    return skewed.directoryErrors() <= plain.directoryErrors() ? skewed : plain;
  }

  static blank(geometry: Geometry = { ...G8 }): DiskImage {
    const data = new Uint8Array(geometry.tracks * geometry.spt * 128);
    const img = new DiskImage(data, geometry, geometry.spt === 26 ? SKEW_3740 : null);
    img.format();
    return img;
  }

  // ---- DriveFormat ------------------------------------------------------

  get blockSize(): number {
    return this.geometry.blockSize;
  }

  /** Logical extents (16K each) held by one directory entry: EXM + 1. */
  get extentsPerEntry(): number {
    return Math.max(1, (this.pointers * this.geometry.blockSize) / LOGICAL_EXTENT);
  }

  /** DSM > 255: block pointers are 16-bit. */
  get wide(): boolean {
    return this.geometry.dsm > 255;
  }

  /** Block pointers per directory entry: sixteen 8-bit or eight 16-bit. */
  get pointers(): number {
    return this.wide ? 8 : 16;
  }

  private readPointer(buf: Uint8Array, entry: number, j: number): number {
    return this.wide ? buf[entry + 16 + j * 2] | (buf[entry + 17 + j * 2] << 8) : buf[entry + 16 + j];
  }

  private writePointer(buf: Uint8Array, entry: number, j: number, block: number): void {
    if (this.wide) {
      buf[entry + 16 + j * 2] = block & 0xff;
      buf[entry + 17 + j * 2] = block >> 8;
    } else {
      buf[entry + 16 + j] = block;
    }
  }

  get dsm(): number {
    return this.geometry.dsm;
  }

  /** Blocks reserved for the directory by AL0/AL1 (or its size, if larger). */
  get reservedBlocks(): number {
    let n = 0;
    while (n < 16 && ((n < 8 ? this.geometry.al0 : this.geometry.al1) & (0x80 >> (n & 7)))) n++;
    return Math.max(n, this.dirBlocks);
  }

  get dirEntries(): number {
    return this.geometry.drm + 1;
  }

  /** DPB bytes in CP/M order for this geometry. */
  dpb(): number[] {
    const g = this.geometry;
    return [
      g.spt & 0xff, (g.spt >> 8) & 0xff,
      g.bsh, g.blm, g.exm,
      g.dsm & 0xff, (g.dsm >> 8) & 0xff,
      g.drm & 0xff, (g.drm >> 8) & 0xff,
      g.al0, g.al1,
      0, 0, // CKS
      g.off & 0xff, (g.off >> 8) & 0xff,
    ];
  }

  // ---- layout -----------------------------------------------------------

  /** Byte offset of the first data track. */
  get dirStart(): number {
    return this.geometry.off * this.geometry.spt * 128;
  }

  get dirBlocks(): number {
    return Math.ceil((this.dirEntries * DIR_ENTRY) / this.geometry.blockSize);
  }

  get blockCount(): number {
    return this.geometry.dsm + 1;
  }

  private get sectorsPerBlock(): number {
    return this.geometry.blockSize / RECORD;
  }

  /** Byte offset of a sector; data tracks go through the skew table. */
  private sectorOffset(track: number, sector: number): number {
    const phys = this.xlt && track >= this.geometry.off ? this.xlt[sector] : sector;
    return (track * this.geometry.spt + phys) * RECORD;
  }

  /** Byte offset of the n-th logical sector after the system tracks. */
  private logicalOffset(n: number): number {
    const { spt, off } = this.geometry;
    return this.sectorOffset(off + Math.floor(n / spt), n % spt);
  }

  /** Byte offset of directory entry i (the directory starts at block 0). */
  private entryOffset(i: number): number {
    const at = i * DIR_ENTRY;
    return this.logicalOffset(Math.floor(at / RECORD)) + (at % RECORD);
  }

  format(): void {
    this.data.fill(0, this.dirStart);
    for (let i = 0; i < this.dirEntries; i++) {
      const e = this.entryOffset(i);
      this.data.fill(0xe5, e, e + DIR_ENTRY);
    }
  }

  // ---- BIOS sector access (logical sector numbers) ----------------------

  readSector(track: number, sector: number): Uint8Array | null {
    const { spt } = this.geometry;
    if (track < 0 || track >= this.geometry.tracks || sector < 0 || sector >= spt) return null;
    const off = this.sectorOffset(track, sector);
    if (off + 128 > this.data.length) return null;
    return this.data.subarray(off, off + 128);
  }

  writeSector(track: number, sector: number, bytes: Uint8Array): boolean {
    const { spt } = this.geometry;
    if (track < 0 || track >= this.geometry.tracks || sector < 0 || sector >= spt) return false;
    const off = this.sectorOffset(track, sector);
    if (off + 128 > this.data.length) return false;
    this.data.set(bytes.subarray(0, 128), off);
    return true;
  }

  // ---- blocks -----------------------------------------------------------

  /** Copies up to `length` bytes of a block into `out` at `at`. */
  private readBlock(block: number, out: Uint8Array, at: number, length: number): void {
    for (let i = 0; i < this.sectorsPerBlock && length > 0; i++) {
      const off = this.logicalOffset(block * this.sectorsPerBlock + i);
      const n = Math.min(RECORD, length, this.data.length - off);
      if (n <= 0) return;
      out.set(this.data.subarray(off, off + n), at);
      at += n;
      length -= n;
    }
  }

  /** Writes one block (zero padded) into `buf`. */
  private writeBlock(buf: Uint8Array, block: number, bytes: Uint8Array): void {
    for (let i = 0; i < this.sectorsPerBlock; i++) {
      const off = this.logicalOffset(block * this.sectorsPerBlock + i);
      if (off + RECORD > buf.length) return;
      buf.fill(0, off, off + RECORD);
      const chunk = bytes.subarray(i * RECORD, (i + 1) * RECORD);
      buf.set(chunk, off);
    }
  }

  // ---- directory --------------------------------------------------------

  /** Directory entries that cannot be valid CP/M entries under this layout. */
  private directoryErrors(): number {
    const d = this.data;
    let bad = 0;
    for (let i = 0; i < this.dirEntries; i++) {
      const e = this.entryOffset(i);
      const user = d[e];
      if (user === 0xe5) continue;
      let ok = user <= 0x21; // users 0-15, plus CP/M 3 labels and stamps
      for (let j = 1; j < 12 && ok; j++) {
        const c = d[e + j] & 0x7f;
        if (c < 0x20 || c > 0x7e) ok = false;
      }
      if (ok && user <= 15) {
        if (d[e + 12] > 0x1f || d[e + 15] > 0x80) ok = false;
        for (let j = 0; j < this.pointers && ok; j++) if (this.readPointer(d, e, j) > this.geometry.dsm) ok = false;
      }
      if (!ok) bad++;
    }
    return bad;
  }

  extractFiles(): CpmFile[] {
    type Entry = { extent: number; rc: number; blocks: number[] };
    const grouped = new Map<string, { file: CpmFile; entries: Entry[] }>();
    const d = this.data;
    for (let i = 0; i < this.dirEntries; i++) {
      const base = this.entryOffset(i);
      const user = d[base];
      if (user === 0xe5 || user > 15) continue;
      let name = '';
      let ext = '';
      for (let j = 0; j < 8; j++) name += String.fromCharCode(d[base + 1 + j] & 0x7f);
      for (let j = 0; j < 3; j++) ext += String.fromCharCode(d[base + 9 + j] & 0x7f);
      const cleanName = padName(trimName(name));
      const cleanExt = padExt(trimName(ext));
      const key = `${user}|${cleanName}|${cleanExt}`;
      let group = grouped.get(key);
      if (!group) {
        group = {
          file: {
            user,
            name: cleanName,
            ext: cleanExt,
            data: new Uint8Array(0),
            ro: (d[base + 9] & 0x80) !== 0,
            sys: (d[base + 10] & 0x80) !== 0,
          },
          entries: [],
        };
        grouped.set(key, group);
      }
      // Logical extent number: S2 holds the bits above EX's five.
      const extent = ((d[base + 14] & 0x3f) << 5) | (d[base + 12] & 0x1f);
      // Keep zero pointers in place: they are holes in a sparse file.
      const blocks: number[] = [];
      for (let j = 0; j < this.pointers; j++) blocks.push(this.readPointer(d, base, j));
      group.entries.push({ extent, rc: Math.min(128, d[base + 15]), blocks });
    }

    const per = this.extentsPerEntry;
    const bls = this.geometry.blockSize;
    const files: CpmFile[] = [];
    for (const { file, entries } of grouped.values()) {
      // Older A-Prompt images put one 16K extent in each entry even when the
      // format packs several (EXM > 0). Real CP/M never gives two entries of
      // one file the same entry number, so a collision means the old layout.
      const legacy = per > 1 && new Set(entries.map((e) => Math.floor(e.extent / per))).size < entries.length;
      const spans = entries.map((e) => {
        const start = legacy ? e.extent * LOGICAL_EXTENT : Math.floor(e.extent / per) * per * LOGICAL_EXTENT;
        const length = (legacy ? 0 : (e.extent % per) * LOGICAL_EXTENT) + e.rc * RECORD;
        return { start, length, blocks: e.blocks };
      });
      const total = spans.reduce((n, s) => Math.max(n, s.start + s.length), 0);
      const data = new Uint8Array(total);
      for (const { start, length, blocks } of spans) {
        for (let j = 0; j < blocks.length; j++) {
          const at = j * bls;
          if (at >= length) break;
          if (blocks[j] !== 0 && blocks[j] <= this.geometry.dsm) this.readBlock(blocks[j], data, start + at, Math.min(bls, length - at));
        }
      }
      file.data = data;
      files.push(file);
    }
    return files;
  }

  /** Whether files of these sizes fit in the directory and the data blocks. */
  fits(lengths: Iterable<number>): boolean {
    const entryBytes = this.extentsPerEntry * LOGICAL_EXTENT;
    let blocks = 0;
    let entries = 0;
    for (const n of lengths) {
      blocks += Math.ceil(n / this.blockSize);
      entries += Math.max(1, Math.ceil(n / entryBytes));
    }
    return blocks <= this.blockCount - this.reservedBlocks && entries <= this.dirEntries;
  }

  /**
   * Re-encodes the directory and data area from `files`.  The image is only
   * changed when everything fits; otherwise it is left as it was.
   */
  rebuild(files: CpmFile[]): boolean {
    const bls = this.geometry.blockSize;
    const per = this.extentsPerEntry;
    const entryBytes = per * LOGICAL_EXTENT;
    const buf = this.data.slice();
    buf.fill(0, this.dirStart);
    const entryAt = (slot: number) => this.entryOffset(slot);
    for (let i = 0; i < this.dirEntries; i++) buf.fill(0xe5, entryAt(i), entryAt(i) + DIR_ENTRY);

    let slot = 0;
    let nextFree = this.reservedBlocks;
    for (const file of files) {
      const entries = Math.max(1, Math.ceil(file.data.length / entryBytes));
      for (let k = 0; k < entries; k++) {
        if (slot >= this.dirEntries) return false;
        const start = k * entryBytes;
        const length = Math.min(entryBytes, Math.max(0, file.data.length - start));
        const records = Math.ceil(length / RECORD);
        // EX/S2 name the last logical extent in this entry; RC counts its records.
        const last = records ? Math.floor((records - 1) / 128) : 0;
        const extent = k * per + last;
        const need = Math.ceil(length / bls);
        if (need > this.pointers || nextFree + need > this.blockCount) return false;

        const e = entryAt(slot);
        buf[e] = file.user & 0x0f;
        for (let i = 0; i < 8; i++) buf[e + 1 + i] = file.name.charCodeAt(i) & 0x7f;
        for (let i = 0; i < 3; i++) buf[e + 9 + i] = file.ext.charCodeAt(i) & 0x7f;
        if (file.ro) buf[e + 9] |= 0x80;
        if (file.sys) buf[e + 10] |= 0x80;
        buf[e + 12] = extent & 0x1f;
        buf[e + 13] = 0;
        buf[e + 14] = (extent >> 5) & 0x3f;
        buf[e + 15] = records - last * 128;
        buf.fill(0, e + 16, e + 32);
        for (let i = 0; i < need; i++) {
          const block = nextFree++;
          const at = start + i * bls;
          this.writeBlock(buf, block, file.data.subarray(at, Math.min(at + bls, start + length)));
          this.writePointer(buf, e, i, block);
        }
        slot++;
      }
    }

    this.data.set(buf);
    return true;
  }

  toBytes(): Uint8Array {
    return this.data.slice();
  }
}
