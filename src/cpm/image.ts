import { CpmFile, padExt, padName, trimName } from './disk';

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
const EXTENT_BYTES = 16 * 1024;

const G8: Geometry = {
  spt: 26, tracks: 77, blockSize: 1024, bsh: 3, blm: 7, exm: 0,
  dsm: 242, drm: 63, off: 2, al0: 0xc0, al1: 0,
};

const G512: Geometry = {
  spt: 64, tracks: 64, blockSize: 2048, bsh: 4, blm: 15, exm: 0,
  dsm: 239, drm: 511, off: 2, al0: 0xff, al1: 0,
};

const G4M: Geometry = {
  spt: 64, tracks: 512, blockSize: 16384, bsh: 7, blm: 127, exm: 0,
  dsm: 255, drm: 511, off: 2, al0: 0x80, al1: 0,
};

export function geometryForSize(size: number): Geometry | null {
  if (size === G8.tracks * G8.spt * 128) return { ...G8 };
  if (size === G512.tracks * G512.spt * 128) return { ...G512 };
  if (size === G4M.tracks * G4M.spt * 128) return { ...G4M };
  // Generic 8" image: 128-byte sectors, 26 per track.
  if (size % (26 * 128) !== 0) return null;
  const tracks = size / (26 * 128);
  if (tracks < 35 || tracks > 85) return null;
  const dsm = Math.floor(((tracks - G8.off) * 26 * 128) / G8.blockSize) - 1;
  return {
    ...G8,
    tracks,
    dsm,
  };
}

/**
 * A raw CP/M 2.2 disk image.  The directory and allocation blocks are decoded
 * into CpmFile objects for the BDOS, and re-encoded after writes.
 */
export class DiskImage {
  readonly data: Uint8Array;
  readonly geometry: Geometry;

  private constructor(data: Uint8Array, geometry: Geometry) {
    this.data = data;
    this.geometry = geometry;
  }

  static fromBytes(input: Uint8Array): DiskImage | null {
    const geometry = geometryForSize(input.length);
    if (!geometry) return null;
    const data = new Uint8Array(input.length);
    data.set(input);
    return new DiskImage(data, geometry);
  }

  static blank(geometry: Geometry = { ...G8 }): DiskImage {
    const data = new Uint8Array(geometry.tracks * geometry.spt * 128);
    const img = new DiskImage(data, geometry);
    img.format();
    return img;
  }

  get dirStart(): number {
    return this.geometry.off * this.geometry.spt * 128;
  }

  get dirEntries(): number {
    return this.geometry.drm + 1;
  }

  get dirBlocks(): number {
    return Math.ceil((this.dirEntries * DIR_ENTRY) / this.geometry.blockSize);
  }

  get blockCount(): number {
    return this.geometry.dsm + 1;
  }

  format(): void {
    this.data.fill(0, this.dirStart);
    this.data.fill(0xe5, this.dirStart, this.dirStart + this.dirEntries * DIR_ENTRY);
  }

  readSector(track: number, sector: number): Uint8Array | null {
    const { spt } = this.geometry;
    if (track < 0 || track >= this.geometry.tracks || sector < 0 || sector >= spt) return null;
    const off = (track * spt + sector) * 128;
    if (off + 128 > this.data.length) return null;
    return this.data.subarray(off, off + 128);
  }

  writeSector(track: number, sector: number, bytes: Uint8Array): boolean {
    const { spt } = this.geometry;
    if (track < 0 || track >= this.geometry.tracks || sector < 0 || sector >= spt) return false;
    const off = (track * spt + sector) * 128;
    if (off + 128 > this.data.length) return false;
    this.data.set(bytes.subarray(0, 128), off);
    return true;
  }

  private blockOffset(block: number): number {
    return this.dirStart + block * this.geometry.blockSize;
  }

  private readBlock(block: number): Uint8Array {
    const off = this.blockOffset(block);
    return this.data.subarray(off, Math.min(off + this.geometry.blockSize, this.data.length));
  }

  private writeBlock(block: number, bytes: Uint8Array): void {
    const off = this.blockOffset(block);
    const n = Math.min(bytes.length, this.geometry.blockSize);
    this.data.fill(0, off, off + this.geometry.blockSize);
    this.data.set(bytes.subarray(0, n), off);
  }

  extractFiles(): CpmFile[] {
    const grouped = new Map<string, { file: CpmFile; extents: Map<number, { rc: number; blocks: number[] }> }>();
    for (let i = 0; i < this.dirEntries; i++) {
      const base = this.dirStart + i * DIR_ENTRY;
      const user = this.data[base];
      if (user === 0xe5 || user > 15) continue;
      let name = '';
      let ext = '';
      for (let j = 0; j < 8; j++) name += String.fromCharCode(this.data[base + 1 + j] & 0x7f);
      for (let j = 0; j < 3; j++) ext += String.fromCharCode(this.data[base + 9 + j] & 0x7f);
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
            ro: (this.data[base + 9] & 0x80) !== 0,
            sys: (this.data[base + 10] & 0x80) !== 0,
          },
          extents: new Map(),
        };
        grouped.set(key, group);
      }
      const ex = this.data[base + 12] & 0x1f;
      const rc = Math.min(128, this.data[base + 15]);
      const blocks: number[] = [];
      const perExtent = Math.ceil(EXTENT_BYTES / this.geometry.blockSize);
      for (let j = 0; j < perExtent; j++) {
        const b = this.data[base + 16 + j];
        if (b !== undefined && b !== 0) blocks.push(b);
      }
      group.extents.set(ex, { rc, blocks });
    }

    const files: CpmFile[] = [];
    for (const { file, extents } of grouped.values()) {
      let total = 0;
      for (const [ex, ent] of extents) {
        total = Math.max(total, ex * EXTENT_BYTES + ent.rc * 128);
      }
      const data = new Uint8Array(total);
      for (const [ex, ent] of extents) {
        const base = ex * EXTENT_BYTES;
        let remain = Math.min(EXTENT_BYTES, total - base);
        if (remain <= 0) continue;
        for (let bi = 0; bi < ent.blocks.length && remain > 0; bi++) {
          const chunk = this.readBlock(ent.blocks[bi]);
          const n = Math.min(chunk.length, remain, this.geometry.blockSize);
          data.set(chunk.subarray(0, n), base + bi * this.geometry.blockSize);
          remain -= n;
        }
      }
      file.data = data;
      files.push(file);
    }
    return files;
  }

  rebuild(files: CpmFile[]): boolean {
    const { blockSize, al0, al1 } = this.geometry;
    const reserved = this.dirBlocks;
    const used = new Uint8Array(this.blockCount);
    for (let i = 0; i < reserved && i < used.length; i++) used[i] = 1;
    // Honour the allocation mask even if it differs from the computed count.
    for (let b = 0; b < 16; b++) {
      const mask = b < 8 ? al0 : al1;
      if (mask & (0x80 >> (b & 7))) used[b] = 1;
    }

    const directory = new Uint8Array(this.dirEntries * DIR_ENTRY);
    directory.fill(0xe5);
    this.data.fill(0, this.dirStart);
    const perExtent = Math.ceil(EXTENT_BYTES / blockSize);
    let slot = 0;
    let nextFree = reserved;

    for (const file of files) {
      const extents = Math.max(1, Math.ceil(file.data.length / EXTENT_BYTES));
      for (let ex = 0; ex < extents; ex++) {
        if (slot >= this.dirEntries) return false;
        const base = ex * EXTENT_BYTES;
        const length = Math.min(EXTENT_BYTES, Math.max(0, file.data.length - base));
        const rc = Math.ceil(length / 128);
        const blocks: number[] = [];
        const need = Math.ceil(length / blockSize);
        for (let i = 0; i < need; i++) {
          while (nextFree < this.blockCount && used[nextFree]) nextFree++;
          if (nextFree >= this.blockCount) return false;
          used[nextFree] = 1;
          blocks.push(nextFree);
          nextFree++;
        }
        if (blocks.length > perExtent) return false;
        for (let i = 0; i < blocks.length; i++) {
          const off = base + i * blockSize;
          const n = Math.min(blockSize, file.data.length - off);
          this.writeBlock(blocks[i], file.data.subarray(off, off + Math.max(0, n)));
        }
        const e = slot * DIR_ENTRY;
        directory.fill(0, e, e + DIR_ENTRY);
        directory[e] = file.user & 0x0f;
        for (let i = 0; i < 8; i++) directory[e + 1 + i] = file.name.charCodeAt(i) & 0x7f;
        for (let i = 0; i < 3; i++) directory[e + 9 + i] = file.ext.charCodeAt(i) & 0x7f;
        if (file.ro) directory[e + 9] |= 0x80;
        if (file.sys) directory[e + 10] |= 0x80;
        directory[e + 12] = ex & 0x1f;
        directory[e + 15] = rc;
        for (let i = 0; i < blocks.length; i++) directory[e + 16 + i] = blocks[i];
        slot++;
      }
    }

    this.data.set(directory, this.dirStart);
    return true;
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

  toBytes(): Uint8Array {
    return this.data.slice();
  }
}
