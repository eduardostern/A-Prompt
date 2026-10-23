import { describe, expect, it } from 'vitest';
import { DEFAULT_DISPLAY, MODERN_DISPLAY, PRESETS, fontSize, largestFitting, mix, parseDisplay, terminalTheme } from '../src/display';

describe('display settings', () => {
  it("a first visit gets Eduardo's look: VT220 at 28 px, white phosphor, no effects", () => {
    expect(DEFAULT_DISPLAY).toEqual(PRESETS.eduardo.settings);
    expect(DEFAULT_DISPLAY).toMatchObject({
      font: 'glass', size: 0, phosphor: 'colorwhite', scanlines: 'light', signal: 'rgb',
      glow: false, flicker: false, curve: false, interference: false,
    });
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
    expect(fontSize(DEFAULT_DISPLAY, false)).toBe(28);
    expect(fontSize(DEFAULT_DISPLAY, true)).toBe(16);
    // A chosen size that would leave a phone too few columns is capped.
    expect(fontSize(PRESETS.green.settings, false)).toBe(20);
    expect(fontSize(PRESETS.green.settings, true)).toBe(16);
    expect(fontSize({ ...DEFAULT_DISPLAY, size: 14 }, true)).toBe(14);
    expect(fontSize({ ...DEFAULT_DISPLAY, font: 'glass', size: 24 }, false)).toBe(24);
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

  it("Eduardo's look shows colours, with white text", () => {
    const t = terminalTheme(DEFAULT_DISPLAY);
    expect(t.red).not.toBe(t.blue);
    expect(t.brightWhite).toBe('#ffffff');
    expect(t.foreground).toBe('#e6e9ef');
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

describe('auto size', () => {
  // A fake terminal 1000x560 px, cells 0.6 x 1.0 of the font size.
  const screen = (px: number) => ({ cols: Math.floor(1000 / (px * 0.6)), rows: Math.floor(560 / px) });

  it('keeps the largest size when 80x24 fits', () => {
    expect(largestFitting(16, 12, 80, 24, screen)).toBe(16);
  });

  it('shrinks until a VT100 screen fits', () => {
    const px = largestFitting(28, 12, 80, 24, screen);
    expect(screen(px).cols).toBeGreaterThanOrEqual(80);
    expect(screen(px).rows).toBeGreaterThanOrEqual(24);
    expect(screen(px + 1).rows < 24 || screen(px + 1).cols < 80).toBe(true);
  });

  it('never goes below the smallest size', () => {
    expect(largestFitting(28, 20, 80, 24, screen)).toBe(20);
  });
});
