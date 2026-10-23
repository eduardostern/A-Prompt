import { describe, expect, it } from 'vitest';
import { DEFAULT_DISPLAY, MODERN_DISPLAY, PRESETS, fontSize, mix, parseDisplay, terminalTheme } from '../src/display';

describe('display settings', () => {
  it('a first visit gets the green CRT', () => {
    expect(DEFAULT_DISPLAY).toEqual(PRESETS.green.settings);
  });

  it('falls back to the default look for missing or broken storage', () => {
    expect(parseDisplay(null)).toEqual(DEFAULT_DISPLAY);
    expect(parseDisplay('{not json')).toEqual(DEFAULT_DISPLAY);
    expect(parseDisplay('"text"')).toEqual(DEFAULT_DISPLAY);
  });

  it('keeps valid fields and replaces invalid ones', () => {
    const s = parseDisplay(JSON.stringify({ font: 'glass', size: 13, phosphor: 'amber', background: 'red', flicker: true, signal: 'secam' }));
    expect(s.font).toBe('glass');
    expect(s.phosphor).toBe('amber');
    expect(s.flicker).toBe(true);
    expect(s.size).toBe(DEFAULT_DISPLAY.size);
    expect(s.background).toBe(DEFAULT_DISPLAY.background);
    expect(s.signal).toBe(DEFAULT_DISPLAY.signal);
  });

  it('every preset survives a round trip through storage', () => {
    for (const p of Object.values(PRESETS)) expect(parseDisplay(JSON.stringify(p.settings))).toEqual(p.settings);
  });

  it('auto size follows the font and the screen width', () => {
    expect(fontSize(MODERN_DISPLAY, false)).toBe(15);
    expect(fontSize(MODERN_DISPLAY, true)).toBe(12);
    expect(fontSize(DEFAULT_DISPLAY, false)).toBe(20);
    expect(fontSize({ ...DEFAULT_DISPLAY, font: 'glass', size: 24 }, true)).toBe(24);
  });

  it('a monochrome phosphor shows every ANSI colour as a shade of itself', () => {
    const t = terminalTheme({ ...DEFAULT_DISPLAY, phosphor: 'amber', background: '#000000' });
    expect(t.red).toBe(t.blue);
    expect(t.brightRed).toBe('#ffb52e');
    expect(t.black).toBe('#000000');
    expect(t.background).toBe('#000000');
    // The 256-colour palette too: 16 is black, 231 white.
    expect(t.extendedAnsi).toHaveLength(240);
    expect(t.extendedAnsi![0]).toBe('#000000');
    expect(t.extendedAnsi![231 - 16]).toBe('#ffb52e');
  });

  it('the colour look keeps the ANSI palette on the chosen background', () => {
    const t = terminalTheme({ ...MODERN_DISPLAY, background: '#102030' });
    expect(t.red).not.toBe(t.blue);
    expect(t.background).toBe('#102030');
  });

  it('mixes colours', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mix('#102030', '#ffffff', 0)).toBe('#102030');
  });
});
