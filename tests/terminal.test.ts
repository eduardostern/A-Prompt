import { describe, expect, it } from 'vitest';
import { TerminalTranslator } from '../src/terminal-translator';

const feedAll = (t: TerminalTranslator, bytes: number[]): string =>
  bytes
    .map((b) => {
      const r = t.feed(b);
      return typeof r === 'string' ? r : String.fromCharCode(r);
    })
    .join('');

describe('terminal profiles', () => {
  it('passes bytes through in ANSI mode', () => {
    const t = new TerminalTranslator('ansi');
    expect(feedAll(t, [0x41, 0x1b, 0x5b, 0x41])).toBe('A\x1b[A');
  });

  it('translates ADM-3A cursor addressing, clear and home', () => {
    const t = new TerminalTranslator('adm3a');
    expect(feedAll(t, [0x1b, 0x3d, 0x20 + 3, 0x20 + 10])).toBe('\x1b[4;11H');
    expect(feedAll(t, [0x1b, 0x2a])).toBe('\x1b[2J\x1b[H');
    expect(feedAll(t, [0x1b, 0x2b])).toBe('\x1b[H');
    expect(feedAll(t, [0x1b, 0x54])).toBe('\x1b[K');
  });

  it('translates VT52 motion and cursor addressing', () => {
    const t = new TerminalTranslator('vt52');
    expect(feedAll(t, [0x1b, 0x41])).toBe('\x1b[A');
    expect(feedAll(t, [0x1b, 0x59, 0x20 + 1, 0x20 + 2])).toBe('\x1b[2;3H');
    expect(feedAll(t, [0x1b, 0x4b])).toBe('\x1b[K');
  });

  it('answers VT52 identify with ESC / Z', () => {
    const t = new TerminalTranslator('vt52');
    expect(feedAll(t, [0x1b, 0x5a])).toBe('');
    expect(t.takeResponse()).toEqual([0x1b, 0x2f, 0x5a]);
  });

  it('does not eat normal characters', () => {
    const t = new TerminalTranslator('adm3a');
    const out = [0x48, 0x65, 0x6c, 0x6c, 0x6f].map((b) => t.feed(b));
    expect(out).toEqual([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
  });
});
