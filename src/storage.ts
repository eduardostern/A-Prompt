import { deflateSync, inflateSync } from 'fflate';

/**
 * localStorage encoding for drives: mounted disk images and file drives.
 *
 * v3 stores the image deflated, then base64: a 4MB z80pack hard disk with
 * 2.4MB of programs takes about 1.6M characters instead of 5.6M, so it fits
 * the usual ~5MB browser quota. v2 (plain base64) is still read.
 */
export interface StoredImage {
  v: 3;
  /** Deflated image, base64. */
  imagez: string;
  /** Uncompressed size in bytes. */
  size: number;
}

export function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function bytesToB64(data: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    s += String.fromCharCode(...data.subarray(i, i + chunk));
  }
  return btoa(s);
}

export function encodeImage(bytes: Uint8Array): StoredImage {
  return { v: 3, imagez: bytesToB64(deflateSync(bytes, { level: 6 })), size: bytes.length };
}

/** Image bytes from a stored drive record (v3 deflated or v2 plain), or null. */
export function decodeImage(stored: { imagez?: unknown; image?: unknown; size?: unknown }): Uint8Array | null {
  if (typeof stored.imagez === 'string') {
    const bytes = inflateSync(b64ToBytes(stored.imagez));
    return typeof stored.size !== 'number' || bytes.length === stored.size ? bytes : null;
  }
  if (typeof stored.image === 'string') return b64ToBytes(stored.image);
  return null;
}

export function sameBytes(a: Uint8Array | undefined, b: Uint8Array): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A file as saved for a drive without an image. */
export interface StoredFileEntry {
  user: number;
  /** 8 characters, space padded. */
  name: string;
  /** 3 characters, space padded. */
  ext: string;
  ro: boolean;
  sys: boolean;
  data: Uint8Array;
}

/**
 * Compressed file-drive record (v3): the files packed into one block and
 * deflated, instead of one base64 string per file. Keeps R/O and SYS.
 */
export interface StoredFiles {
  v: 3;
  /** Deflated packFiles() block, base64. */
  filesz: string;
  /** Uncompressed size of the block in bytes. */
  size: number;
}

const MAGIC = [0x41, 0x50, 0x46, 0x31]; // "APF1"
const HEADER = 1 + 1 + 8 + 3 + 4; // user, flags, name, ext, length

/** Packs files as: "APF1", then per file user, flags, name, ext, u32 length, data. */
export function packFiles(files: StoredFileEntry[]): Uint8Array {
  const total = 4 + files.reduce((n, f) => n + HEADER + f.data.length, 0);
  const out = new Uint8Array(total);
  out.set(MAGIC, 0);
  const view = new DataView(out.buffer);
  let p = 4;
  for (const f of files) {
    out[p] = f.user & 0x0f;
    out[p + 1] = (f.ro ? 1 : 0) | (f.sys ? 2 : 0);
    for (let i = 0; i < 8; i++) out[p + 2 + i] = (f.name.charCodeAt(i) || 0x20) & 0x7f;
    for (let i = 0; i < 3; i++) out[p + 10 + i] = (f.ext.charCodeAt(i) || 0x20) & 0x7f;
    view.setUint32(p + 13, f.data.length, true);
    out.set(f.data, p + HEADER);
    p += HEADER + f.data.length;
  }
  return out;
}

/** Files from a packFiles() block, or null if it is malformed. */
export function unpackFiles(bytes: Uint8Array): StoredFileEntry[] | null {
  if (bytes.length < 4 || MAGIC.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files: StoredFileEntry[] = [];
  let p = 4;
  while (p < bytes.length) {
    if (p + HEADER > bytes.length) return null;
    const length = view.getUint32(p + 13, true);
    if (p + HEADER + length > bytes.length) return null;
    files.push({
      user: bytes[p] & 0x0f,
      ro: (bytes[p + 1] & 1) !== 0,
      sys: (bytes[p + 1] & 2) !== 0,
      name: String.fromCharCode(...bytes.subarray(p + 2, p + 10)),
      ext: String.fromCharCode(...bytes.subarray(p + 10, p + 13)),
      data: bytes.slice(p + HEADER, p + HEADER + length),
    });
    p += HEADER + length;
  }
  return files;
}

export function encodeFiles(packed: Uint8Array): StoredFiles {
  return { v: 3, filesz: bytesToB64(deflateSync(packed, { level: 6 })), size: packed.length };
}

/** The packed block from a v3 file-drive record, or null. */
export function decodeFiles(stored: { filesz?: unknown; size?: unknown }): Uint8Array | null {
  if (typeof stored.filesz !== 'string') return null;
  const bytes = inflateSync(b64ToBytes(stored.filesz));
  return typeof stored.size !== 'number' || bytes.length === stored.size ? bytes : null;
}
