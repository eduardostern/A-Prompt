/**
 * How the terminal looks: font, size, phosphor colour, background and the
 * CRT effects. Pure data and colour maths; `display-ui.ts` puts it on screen.
 */
import type { ITheme } from '@xterm/xterm';

export type FontId = 'modern' | 'glass' | 'vt323' | 'vga';
/** 'color' and 'colorwhite' keep the ANSI palette; the rest are one-colour monitors. */
export type Phosphor = 'color' | 'colorwhite' | 'green' | 'amber' | 'white';
export type Scanlines = 'off' | 'light' | 'heavy';
export type Signal = 'rgb' | 'ntsc' | 'pal';

export interface DisplaySettings {
  font: FontId;
  /** Font size in px; 0 picks the font's own size for the screen width. */
  size: number;
  phosphor: Phosphor;
  /** Screen background, #rrggbb. */
  background: string;
  scanlines: Scanlines;
  glow: boolean;
  flicker: boolean;
  /** Rounded glass with dark corners and a deeper vignette. */
  curve: boolean;
  /** Magnetic interference: the picture wobbles now and then. */
  interference: boolean;
  /** Composite colour fringes and the hum bar's speed (60 or 50 Hz). */
  signal: Signal;
}

export interface FontInfo {
  label: string;
  /** CSS family list; the first name is the one to wait for. */
  family: string;
  /** Size for desktop and for narrow screens. */
  auto: [number, number];
  lineHeight: number;
}

const FALLBACK = "Menlo, Consolas, 'DejaVu Sans Mono', monospace";

export const FONTS: Record<FontId, FontInfo> = {
  modern: { label: 'Modern', family: `'JetBrains Mono', 'IBM Plex Mono', ${FALLBACK}`, auto: [15, 12], lineHeight: 1.25 },
  glass: { label: 'DEC VT220 (Glass TTY)', family: `'Glass TTY VT220', ${FALLBACK}`, auto: [28, 16], lineHeight: 1.0 },
  vt323: { label: 'VT323', family: `'VT323', ${FALLBACK}`, auto: [22, 17], lineHeight: 1.0 },
  vga: { label: 'IBM PC VGA', family: `'IBM VGA 8x16', ${FALLBACK}`, auto: [16, 16], lineHeight: 1.0 },
};

export const SIZES = [0, 12, 14, 15, 16, 18, 20, 22, 24, 28, 32];

/** The clean look: modern font, ANSI colours, light scanlines. */
export const MODERN_DISPLAY: DisplaySettings = {
  font: 'modern',
  size: 0,
  phosphor: 'color',
  background: '#08110b',
  scanlines: 'light',
  glow: false,
  flicker: false,
  curve: false,
  interference: false,
  signal: 'rgb',
};

/** Background that goes with each phosphor when it is picked. */
export const PHOSPHOR_BACKGROUND: Record<Phosphor, string> = {
  color: '#08110b',
  colorwhite: '#08090c',
  green: '#031006',
  amber: '#0d0800',
  white: '#08090c',
};

/** P1 green, P3 amber, P4 white. */
const PHOSPHOR_RGB: Record<Exclude<Phosphor, 'color' | 'colorwhite'>, string> = {
  green: '#41ff7a',
  amber: '#ffb52e',
  white: '#e6edff',
};

export const PRESETS: Record<string, { label: string; short: string; settings: DisplaySettings }> = {
  eduardo: {
    label: "Eduardo's", short: 'Eduardo',
    settings: {
      font: 'glass', size: 0, phosphor: 'colorwhite', background: PHOSPHOR_BACKGROUND.colorwhite,
      scanlines: 'light', glow: false, flicker: false, curve: false, interference: false, signal: 'rgb',
    },
  },
  modern: { label: 'Modern', short: 'Modern', settings: MODERN_DISPLAY },
  green: {
    label: 'Green CRT', short: 'Green',
    settings: {
      font: 'glass', size: 20, phosphor: 'green', background: PHOSPHOR_BACKGROUND.green,
      scanlines: 'heavy', glow: true, flicker: true, curve: true, interference: false, signal: 'ntsc',
    },
  },
  amber: {
    label: 'Amber CRT', short: 'Amber',
    settings: {
      font: 'vt323', size: 0, phosphor: 'amber', background: PHOSPHOR_BACKGROUND.amber,
      scanlines: 'heavy', glow: true, flicker: true, curve: true, interference: false, signal: 'pal',
    },
  },
  ibm: {
    label: 'IBM PC', short: 'IBM',
    settings: {
      font: 'vga', size: 0, phosphor: 'color', background: '#000000',
      scanlines: 'light', glow: true, flicker: false, curve: true, interference: false, signal: 'rgb',
    },
  },
  worn: {
    label: 'Worn out', short: 'Worn',
    settings: {
      font: 'glass', size: 20, phosphor: 'white', background: PHOSPHOR_BACKGROUND.white,
      scanlines: 'heavy', glow: true, flicker: true, curve: true, interference: true, signal: 'ntsc',
    },
  },
};

/** What a first visit shows: Eduardo's choice. */
export const DEFAULT_DISPLAY: DisplaySettings = PRESETS.eduardo.settings;

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

/** Settings from storage, with anything missing or invalid set to the default. */
export function parseDisplay(json: string | null): DisplaySettings {
  let raw: Record<string, unknown> = {};
  try {
    const v = json ? JSON.parse(json) : {};
    if (v && typeof v === 'object') raw = v;
  } catch {
    /* corrupt: defaults */
  }
  const d = DEFAULT_DISPLAY;
  const bool = (k: keyof DisplaySettings) => (typeof raw[k] === 'boolean' ? (raw[k] as boolean) : (d[k] as boolean));
  return {
    font: pick(raw.font, Object.keys(FONTS) as FontId[], d.font),
    size: SIZES.includes(raw.size as number) ? (raw.size as number) : d.size,
    phosphor: pick(raw.phosphor, ['color', 'colorwhite', 'green', 'amber', 'white'], d.phosphor),
    background: typeof raw.background === 'string' && /^#[0-9a-f]{6}$/i.test(raw.background) ? raw.background : d.background,
    scanlines: pick(raw.scanlines, ['off', 'light', 'heavy'], d.scanlines),
    glow: bool('glow'),
    flicker: bool('flicker'),
    curve: bool('curve'),
    interference: bool('interference'),
    signal: pick(raw.signal, ['rgb', 'ntsc', 'pal'], d.signal),
  };
}

/**
 * The size to use: the chosen one, or the font's own for this width. On a
 * narrow screen a chosen size is capped at the font's own phone size, so the
 * screen keeps enough columns.
 */
export function fontSize(s: DisplaySettings, narrow: boolean): number {
  const auto = FONTS[s.font].auto[narrow ? 1 : 0];
  if (!s.size) return auto;
  return narrow ? Math.min(s.size, auto) : s.size;
}

/** The screen size programs expect of a VT100: Auto keeps it on screen. */
export const SCREEN_COLS = 80;
export const SCREEN_ROWS = 24;

/**
 * The largest font size from `max` down to `min` at which `measure` fits
 * cols x rows. Cells grow with the size, so it starts from the estimate the
 * first measurement gives and steps down from there.
 */
export function largestFitting(
  max: number,
  min: number,
  cols: number,
  rows: number,
  measure: (px: number) => { cols: number; rows: number } | undefined,
): number {
  const fits = (d: { cols: number; rows: number } | undefined) => !d || (d.cols >= cols && d.rows >= rows);
  const first = measure(max);
  if (fits(first)) return max;
  let px = Math.min(max - 1, Math.floor(max * Math.min(first!.cols / cols, first!.rows / rows)) + 1);
  while (px > min && !fits(measure(px))) px--;
  return Math.max(min, px);
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hex([r, g, b]: number[]): string {
  return '#' + [r, g, b].map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('');
}

/** `a` faded toward `b`: t = 0 gives a, 1 gives b. */
export function mix(a: string, b: string, t: number): string {
  const x = rgb(a);
  const y = rgb(b);
  return hex(x.map((c, i) => c + (y[i] - c) * t));
}

/** The colour terminal (ANSI palette) of the default look. */
const COLOR_THEME: ITheme = {
  foreground: '#c9f5d5',
  cursor: '#63e698',
  selectionBackground: '#1e5c3a',
  red: '#ff7b72',
  green: '#63e698',
  yellow: '#e3d27c',
  blue: '#79b8ff',
  magenta: '#d2a8ff',
  cyan: '#7ee7d0',
  white: '#d7e4db',
  brightBlack: '#5f7a69',
  brightRed: '#ff9f97',
  brightGreen: '#8dffb8',
  brightYellow: '#f3e6a5',
  brightBlue: '#a8d1ff',
  brightMagenta: '#e3c8ff',
  brightCyan: '#a9f5e6',
  brightWhite: '#f2fff7',
};

/** The colour palette with white text and neutral greys. */
const COLOR_WHITE_THEME: ITheme = {
  ...COLOR_THEME,
  foreground: '#e6e9ef',
  cursor: '#ffffff',
  selectionBackground: '#3a4150',
  white: '#d0d4dc',
  brightBlack: '#6e7681',
  brightWhite: '#ffffff',
};

/** The main text colour, for the glow. */
export function textColor(s: DisplaySettings): string {
  if (s.phosphor === 'color') return COLOR_THEME.foreground as string;
  if (s.phosphor === 'colorwhite') return COLOR_WHITE_THEME.foreground as string;
  return PHOSPHOR_RGB[s.phosphor];
}

/**
 * xterm's theme. A monochrome monitor shows every ANSI colour as a shade of
 * its one phosphor: normal colours dimmer, bright ones at full strength.
 */
export function terminalTheme(s: DisplaySettings): ITheme {
  const bg = s.background;
  if (s.phosphor === 'color' || s.phosphor === 'colorwhite') {
    const base = s.phosphor === 'color' ? COLOR_THEME : COLOR_WHITE_THEME;
    return { ...base, background: bg, black: bg, cursorAccent: bg };
  }
  const p = PHOSPHOR_RGB[s.phosphor];
  const shade = (t: number) => mix(bg, p, t);
  const normal = shade(0.78);
  const bright = p;
  return {
    background: bg,
    foreground: shade(0.88),
    cursor: bright,
    cursorAccent: bg,
    selectionBackground: shade(0.35),
    black: bg,
    red: normal, green: normal, yellow: normal, blue: normal, magenta: normal, cyan: normal, white: normal,
    brightBlack: shade(0.45),
    brightRed: bright, brightGreen: bright, brightYellow: bright, brightBlue: bright,
    brightMagenta: bright, brightCyan: bright, brightWhite: bright,
    extendedAnsi: xterm256().map(([r, g, b]) => shade((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255)),
  };
}

/** Colours 16-255 of the xterm palette: the 6x6x6 cube, then 24 greys. */
function xterm256(): [number, number, number][] {
  const out: [number, number, number][] = [];
  const level = [0, 95, 135, 175, 215, 255];
  for (let i = 0; i < 216; i++) out.push([level[Math.floor(i / 36)], level[Math.floor(i / 6) % 6], level[i % 6]]);
  for (let i = 0; i < 24; i++) out.push([8 + 10 * i, 8 + 10 * i, 8 + 10 * i]);
  return out;
}
