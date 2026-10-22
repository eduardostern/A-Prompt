import { deflateSync, inflateSync } from 'fflate';

/**
 * localStorage encoding for mounted disk images.
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
