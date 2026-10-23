import { describe, expect, it } from 'vitest';
import {
  bytesToB64, decodeFiles, decodeImage, encodeFiles, encodeImage, packFiles, sameBytes, unpackFiles,
} from '../src/storage';

describe('drive image storage', () => {
  it('round-trips an image through deflate + base64', () => {
    const image = new Uint8Array(255 * 128 * 128); // z80pack 4MB hard disk
    image.fill(0xe5, 0, 32 * 1024);
    for (let i = 32 * 1024; i < 200_000; i++) image[i] = (i * 31) & 0xff;
    const stored = encodeImage(image);
    expect(stored.v).toBe(3);
    // Mostly empty 4MB disks become small enough for localStorage.
    expect(stored.imagez.length).toBeLessThan(400_000);
    const back = decodeImage(JSON.parse(JSON.stringify(stored)))!;
    expect(sameBytes(back, image)).toBe(true);
  });

  it('still reads plain base64 images saved by v2', () => {
    const image = new Uint8Array([1, 2, 3, 0xe5, 0xff]);
    expect([...decodeImage({ image: bytesToB64(image) })!]).toEqual([...image]);
  });

  it('rejects a record whose size does not match', () => {
    const stored = encodeImage(new Uint8Array(1000));
    expect(decodeImage({ ...stored, size: 999 })).toBeNull();
  });
});

describe('file drive storage', () => {
  const files = [
    { user: 0, name: 'HELLO   ', ext: 'COM', ro: false, sys: false, data: new Uint8Array([0x0e, 0x09, 0xc9]) },
    { user: 3, name: 'NOTES   ', ext: 'TXT', ro: true, sys: true, data: new TextEncoder().encode('CP/M '.repeat(20_000)) },
    { user: 15, name: 'EMPTY   ', ext: '   ', ro: false, sys: false, data: new Uint8Array(0) },
  ];

  it('round-trips names, user areas, attributes and data', () => {
    const packed = packFiles(files);
    const stored = encodeFiles(packed);
    expect(stored.v).toBe(3);
    // 100K of text compresses to a small fraction of its base64 size.
    expect(stored.filesz.length).toBeLessThan(10_000);
    const back = unpackFiles(decodeFiles(JSON.parse(JSON.stringify(stored)))!)!;
    expect(back).toHaveLength(3);
    for (let i = 0; i < files.length; i++) {
      const { data, ...meta } = back[i];
      const { data: want, ...wantMeta } = files[i];
      expect(meta).toEqual(wantMeta);
      expect(sameBytes(data, want)).toBe(true);
    }
  });

  it('rejects truncated or foreign blocks', () => {
    const packed = packFiles(files);
    expect(unpackFiles(packed.subarray(0, packed.length - 1))).toBeNull();
    expect(unpackFiles(new TextEncoder().encode('{"v":2}'))).toBeNull();
    expect(decodeFiles({ ...encodeFiles(packed), size: 1 })).toBeNull();
  });
});

import { toCpmText } from '../src/cpm/text';

describe('CP/M text', () => {
  const bytes = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
  const str = (b: Uint8Array) => String.fromCharCode(...b);

  it('gives modern text CR LF line ends and a ^Z', () => {
    expect(str(toCpmText(bytes('\tORG\t100H\n\tEND\n')))).toBe('\tORG\t100H\r\n\tEND\r\n\x1a');
    expect(str(toCpmText(bytes('no newline')))).toBe('no newline\r\n\x1a');
    expect(str(toCpmText(bytes('dos\r\ntext\r\n')))).toBe('dos\r\ntext\r\n\x1a');
  });

  it('leaves CP/M text and binary files alone', () => {
    const cpm = bytes('A\r\n\x1a\x1a');
    expect(toCpmText(cpm)).toBe(cpm);
    const com = Uint8Array.from([0xc3, 0x00, 0x01, 0x0a]);
    expect(toCpmText(com)).toBe(com);
  });
});
