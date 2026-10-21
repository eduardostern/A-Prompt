import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { unzip } from '../src/zip';

const games = new URL('../downloads/games/', import.meta.url);
const fixtures = [
  ['sargon.zip', 'SARGON.COM'],
  ['manygame.zip', 'ADVENT~2/ADVENTUR.COM'],
];

describe('zip reader', () => {
  for (const [file, entry] of fixtures) {
    const path = new URL(file, games);
    it.skipIf(!existsSync(path))(file, () => {
      const entries = unzip(new Uint8Array(readFileSync(path)));
      expect(entries[entry]).toBeTruthy();
      expect(entries[entry].length).toBeGreaterThan(100);
    });
  }

  const zork = new URL('zork123_80.zip', games);
  it.skipIf(!existsSync(zork))('reports legacy Implode archives clearly', () => {
    expect(() => unzip(new Uint8Array(readFileSync(zork)))).toThrow(
      /unsupported compression method 6/,
    );
  });
});
