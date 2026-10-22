import { describe, expect, it } from 'vitest';
import { bytesToB64, decodeImage, encodeImage, sameBytes } from '../src/storage';

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
