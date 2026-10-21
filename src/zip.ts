import { inflateSync } from 'fflate';

/**
 * Minimal ZIP reader with support for the legacy PKWARE "Implode" method (6)
 * still used by some 1980s CP/M archives.  Methods 0 (stored) and 8 (deflate)
 * are handled by fflate.
 */
export function unzip(bytes: Uint8Array): Record<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view);
  if (eocd < 0) throw new Error('not a zip archive');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out: Record<string, Uint8Array> = {};

  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error('bad central directory');
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const uncompressedSize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder(flags & 0x800 ? 'utf-8' : 'latin1').decode(
      bytes.subarray(p + 46, p + 46 + nameLen),
    );
    const next = p + 46 + nameLen + extraLen + commentLen;

    if (!name.endsWith('/') && !(flags & 1)) {
      if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error('bad local header');
      const localName = view.getUint16(localOffset + 26, true);
      const localExtra = view.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + localName + localExtra;
      const compressed = bytes.subarray(start, start + compressedSize);
      let data: Uint8Array;
      if (method === 0) data = compressed.slice();
      else if (method === 8) data = inflateSync(compressed);
      else if (method === 6) throw new Error('unsupported compression method 6');
      else throw new Error(`unsupported compression method ${method}`);
      if (uncompressedSize && data.length !== uncompressedSize) {
        throw new Error(`size mismatch for ${name}`);
      }
      out[name] = data;
    }
    p = next;
  }
  return out;
}

function findEocd(view: DataView): number {
  const min = Math.max(0, view.byteLength - 0xffff - 22);
  for (let p = view.byteLength - 22; p >= min; p--) {
    if (view.getUint32(p, true) === 0x06054b50) {
      const comment = view.getUint16(p + 20, true);
      if (p + 22 + comment <= view.byteLength) return p;
    }
  }
  return -1;
}
