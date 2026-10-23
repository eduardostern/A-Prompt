/**
 * The Display card: applies the look from `display.ts` to xterm and to the
 * CSS effect layers on the terminal, and keeps it in localStorage.
 */
import type { XtermConsole } from './terminal';
import {
  DEFAULT_DISPLAY, DisplaySettings, FONTS, FontId, PHOSPHOR_BACKGROUND, PRESETS, Phosphor, SIZES,
  SCREEN_COLS, SCREEN_ROWS, Scanlines, Signal, displayParam, fontSize, largestFitting, parseDisplay,
  parseDisplayParam, terminalTheme, textColor,
} from './display';
import './fonts/fonts.css';

const KEY = 'a-prompt.display';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** `openCard` shows the Display card, for the toolbar's "More settings…". */
export function setupDisplay(con: XtermConsole, isNarrow: () => boolean, openCard: () => void): { refit(): void } {
  const wrap = $('terminal-wrap');
  const font = $<HTMLSelectElement>('display-font');
  const size = $<HTMLSelectElement>('display-size');
  const phosphor = $<HTMLSelectElement>('display-phosphor');
  const background = $<HTMLInputElement>('display-background');
  const scanlines = $<HTMLSelectElement>('display-scanlines');
  const signal = $<HTMLSelectElement>('display-signal');
  const checks = {
    glow: $<HTMLInputElement>('display-glow'),
    flicker: $<HTMLInputElement>('display-flicker'),
    curve: $<HTMLInputElement>('display-curve'),
    interference: $<HTMLInputElement>('display-interference'),
  };
  const presets = $('display-presets');
  const toolbar = $<HTMLSelectElement>('display-preset');

  for (const [id, f] of Object.entries(FONTS)) font.add(new Option(f.label, id));
  for (const n of SIZES) size.add(new Option(n ? `${n} px` : 'Auto', String(n)));
  for (const [id, p] of Object.entries(PRESETS)) {
    const o = new Option(p.label, id);
    o.dataset.short = p.short;
    toolbar.add(o);
  }
  const custom = new Option('Custom', 'custom');
  custom.disabled = true;
  toolbar.add(custom);
  const more = new Option('More settings…', 'more');
  more.dataset.short = 'More…';
  toolbar.add(more);
  toolbar.addEventListener('change', () => {
    if (toolbar.value === 'more') openCard();
    else if (PRESETS[toolbar.value]) set({ ...PRESETS[toolbar.value].settings });
    apply(); // puts the menu back on the current look
    if (toolbar.value !== 'more') con.focus();
  });
  for (const [id, p] of Object.entries(PRESETS)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = p.label;
    b.dataset.preset = id;
    b.addEventListener('click', () => set({ ...p.settings }));
    presets.append(b);
  }

  let settings: DisplaySettings;
  try {
    settings = parseDisplay(localStorage.getItem(KEY));
  } catch {
    settings = { ...DEFAULT_DISPLAY };
  }
  // A shared link (?display=amber) shows its look for this visit only.
  const shared = new URLSearchParams(location.search).get('display');
  const fromLink = shared ? parseDisplayParam(shared) : undefined;
  if (fromLink) settings = fromLink;

  const share = $<HTMLButtonElement>('display-share');
  share.addEventListener('click', async () => {
    const url = new URL(location.href);
    url.searchParams.set('display', displayParam(settings));
    try {
      await navigator.clipboard.writeText(url.toString());
      share.textContent = 'Link copied';
    } catch {
      window.prompt('Copy this link:', url.toString());
    }
    setTimeout(() => { share.textContent = 'Copy link'; }, 1800);
  });
  let loadId = 0;

  /**
   * Auto size: the font's own size, made smaller if needed so a VT100 screen
   * (80x24) still fits, but never below its phone size.
   */
  function autoSize(): number {
    const [max, min] = FONTS[settings.font].auto;
    if (isNarrow()) return min;
    return largestFitting(max, min, SCREEN_COLS, SCREEN_ROWS, (px) => {
      con.term.options.fontSize = px;
      return con.proposeDimensions();
    });
  }

  /** Font, size and line height; waits for a web font so xterm measures the right one. */
  async function applyFont(): Promise<void> {
    const info = FONTS[settings.font];
    const id = ++loadId;
    const first = info.family.split(',')[0].trim();
    try {
      await document.fonts?.load(`${info.auto[0]}px ${first}`);
    } catch {
      /* fall back to the next font in the list */
    }
    if (id !== loadId) return;
    const o = con.term.options;
    const before = `${o.fontFamily}/${o.fontSize}/${o.lineHeight}`;
    o.fontFamily = info.family;
    o.lineHeight = info.lineHeight;
    o.fontSize = settings.size ? fontSize(settings, isNarrow()) : autoSize();
    if (`${o.fontFamily}/${o.fontSize}/${o.lineHeight}` !== before || id === 1) con.fit();
  }

  function apply(): void {
    const s = settings;
    con.term.options.theme = terminalTheme(s);
    wrap.style.setProperty('--term-bg', s.background);
    wrap.style.setProperty('--phosphor', textColor(s));
    wrap.dataset.scanlines = s.scanlines;
    wrap.dataset.signal = s.signal;
    for (const k of Object.keys(checks) as (keyof typeof checks)[]) wrap.classList.toggle(`fx-${k}`, s[k]);
    void applyFont();

    font.value = s.font;
    size.value = String(s.size);
    phosphor.value = s.phosphor;
    background.value = s.background;
    scanlines.value = s.scanlines;
    signal.value = s.signal;
    for (const k of Object.keys(checks) as (keyof typeof checks)[]) checks[k].checked = s[k];
    const current = JSON.stringify(s);
    const match = Object.keys(PRESETS).find((id) => JSON.stringify(PRESETS[id].settings) === current);
    for (const b of presets.querySelectorAll<HTMLButtonElement>('button')) {
      b.classList.toggle('active', b.dataset.preset === match);
    }
    toolbar.value = match ?? 'custom';
  }

  function set(next: DisplaySettings): void {
    settings = next;
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
    } catch {
      /* storage blocked: lasts for this visit */
    }
    apply();
  }

  const change = (patch: Partial<DisplaySettings>) => set({ ...settings, ...patch });
  font.addEventListener('change', () => change({ font: font.value as FontId }));
  size.addEventListener('change', () => change({ size: Number(size.value) }));
  phosphor.addEventListener('change', () => {
    const p = phosphor.value as Phosphor;
    change({ phosphor: p, background: PHOSPHOR_BACKGROUND[p] });
  });
  background.addEventListener('input', () => change({ background: background.value }));
  $('display-background-reset').addEventListener('click', () =>
    change({ background: PHOSPHOR_BACKGROUND[settings.phosphor] }),
  );
  scanlines.addEventListener('change', () => change({ scanlines: scanlines.value as Scanlines }));
  signal.addEventListener('change', () => change({ signal: signal.value as Signal }));
  for (const k of Object.keys(checks) as (keyof typeof checks)[]) {
    checks[k].addEventListener('change', () => change({ [k]: checks[k].checked }));
  }

  apply();
  // Auto sizes depend on the terminal's size; the caller runs this on resize.
  let pending = 0;
  return {
    refit: () => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => void applyFont());
    },
  };
}
