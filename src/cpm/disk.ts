/**
 * In-memory CP/M disk.
 *
 * Files are stored as plain byte arrays, but they are exposed to guest software
 * through CP/M 8.3 names, user areas and 128-byte records.  A single drive (A:)
 * is emulated; its capacity is only limited by MAX_BYTES.
 */

import { DiskImage } from './image';

export const MAX_BYTES = 4 * 1024 * 1024;
const RECORD = 128;
const EXTENT_BYTES = 16 * 1024;

export interface CpmFile {
  user: number;
  name: string; // exactly 8 chars, space padded
  ext: string; // exactly 3 chars, space padded
  data: Uint8Array;
  ro: boolean;
  sys: boolean;
}

export interface ParsedName {
  drive: number | null; // 0 = A:
  name: string;
  ext: string;
}

export const padName = (s: string): string => (s.toUpperCase() + '        ').slice(0, 8);
export const padExt = (s: string): string => (s.toUpperCase() + '   ').slice(0, 3);

export function trimName(s: string): string {
  return s.replace(/\s+$/, '');
}

export function displayName(f: { name: string; ext: string }): string {
  const ext = trimName(f.ext);
  return trimName(f.name) + (ext ? '.' + ext : '');
}

/** Parses "B:FOO.TXT", "FOO", "*.COM" into a CP/M name. Returns null if invalid. */
export function parseName(input: string): ParsedName | null {
  let s = input.trim().toUpperCase();
  if (!s) return null;
  let drive: number | null = null;
  if (/^[A-P]:/.test(s)) {
    drive = s.charCodeAt(0) - 65;
    s = s.slice(2);
  }
  if (!s) return null;
  // Split on the last dot; CP/M only allows one.
  const dot = s.lastIndexOf('.');
  let base = dot >= 0 ? s.slice(0, dot) : s;
  let ext = dot >= 0 ? s.slice(dot + 1) : '';
  if (base === '') base = '*';
  if (!/^[A-Z0-9$#@!%&'()\-_{}~`^*?]+$/.test(base)) return null;
  if (ext && !/^[A-Z0-9$#@!%&'()\-_{}~`^*?]+$/.test(ext)) return null;

  let name = '';
  let extOut = '';
  if (base.includes('*')) {
    const [head] = base.split('*');
    name = (head + '????????').slice(0, 8);
  } else {
    name = padName(base.slice(0, 8));
  }
  if (ext.includes('*')) {
    extOut = '???';
  } else {
    extOut = padExt(ext.slice(0, 3));
  }
  return { drive, name, ext: extOut };
}

function matches(file: CpmFile, name: string, ext: string): boolean {
  for (let i = 0; i < 8; i++) {
    if (name[i] !== '?' && name[i] !== file.name[i]) return false;
  }
  for (let i = 0; i < 3; i++) {
    if (ext[i] !== '?' && ext[i] !== file.ext[i]) return false;
  }
  return true;
}

export class Disk {
  files: CpmFile[] = [];
  /** Set when this drive is backed by a .dsk/.img image. */
  image?: DiskImage;
  imageDirty = false;
  filesDirty = false;

  constructor(public label = 'A') {}

  reset(): void {
    this.files = [];
    this.image = undefined;
    this.imageDirty = false;
    this.filesDirty = false;
  }

  mountImage(input: Uint8Array): boolean {
    const image = DiskImage.fromBytes(input);
    if (!image) return false;
    this.image = image;
    this.files = image.extractFiles();
    this.imageDirty = false;
    this.filesDirty = false;
    return true;
  }

  ejectImage(): void {
    this.syncImage();
    this.image = undefined;
    this.imageDirty = false;
    this.filesDirty = false;
  }

  syncImage(): void {
    if (!this.image) return;
    if (this.filesDirty) {
      this.image.rebuild(this.files);
      this.imageDirty = false;
    } else if (this.imageDirty) {
      this.files = this.image.extractFiles();
      this.imageDirty = false;
    }
    this.filesDirty = false;
  }

  markFilesDirty(): void {
    if (this.image) this.filesDirty = true;
  }

  /** Raw image bytes, creating an 8" image from the files if needed. */
  exportImage(): Uint8Array | null {
    if (this.image) {
      this.syncImage();
      return this.image.toBytes();
    }
    const image = DiskImage.blank();
    if (!image.rebuild(this.files)) return null;
    return image.toBytes();
  }

  usedBytes(): number {
    return this.files.reduce((n, f) => n + f.data.length, 0);
  }

  list(user: number): CpmFile[] {
    return this.files
      .filter((f) => f.user === user)
      .sort((a, b) => (a.name + a.ext).localeCompare(b.name + b.ext));
  }

  find(user: number, name: string, ext: string): CpmFile | undefined {
    return this.files.find((f) => f.user === user && f.name === name && f.ext === ext);
  }

  search(user: number, name: string, ext: string): CpmFile[] {
    return this.list(user).filter((f) => matches(f, name, ext));
  }

  create(user: number, name: string, ext: string): CpmFile | { error: 'full' } {
    const existing = this.find(user, name, ext);
    if (existing) {
      existing.data = new Uint8Array(0);
      existing.ro = false;
      existing.sys = false;
      this.markFilesDirty();
      return existing;
    }
    if (this.usedBytes() > MAX_BYTES) return { error: 'full' };
    const f: CpmFile = {
      user,
      name: padName(trimName(name)),
      ext: padExt(trimName(ext)),
      data: new Uint8Array(0),
      ro: false,
      sys: false,
    };
    this.files.push(f);
    this.markFilesDirty();
    return f;
  }

  /** Adds or replaces a file (used by uploads and the built-in image). */
  put(name: string, ext: string, data: Uint8Array, user = 0, ro = false, sys = false): CpmFile | null {
    const n = padName(name);
    const e = padExt(ext);
    const existing = this.find(user, n, e);
    if (existing) {
      if (this.usedBytes() - existing.data.length + data.length > MAX_BYTES) return null;
      existing.data = data;
      existing.ro = ro;
      existing.sys = sys;
      this.markFilesDirty();
      return existing;
    }
    if (this.usedBytes() + data.length > MAX_BYTES) return null;
    const f: CpmFile = { user, name: n, ext: e, data, ro, sys };
    this.files.push(f);
    this.markFilesDirty();
    return f;
  }

  remove(file: CpmFile): boolean {
    const i = this.files.indexOf(file);
    if (i < 0) return false;
    this.files.splice(i, 1);
    this.markFilesDirty();
    return true;
  }

  /** Number of 128-byte records in the file. */
  static records(f: CpmFile): number {
    return Math.ceil(f.data.length / RECORD);
  }

  /** Number of 16K extents the file occupies (always at least one). */
  static extents(f: CpmFile): number {
    return Math.max(1, Math.ceil(f.data.length / EXTENT_BYTES));
  }

  /** Records used in the given extent (0-128). */
  static extentRecords(f: CpmFile, extent: number): number {
    const remaining = f.data.length - extent * EXTENT_BYTES;
    if (remaining <= 0) return 0;
    return Math.min(128, Math.ceil(remaining / RECORD));
  }
}
