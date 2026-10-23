/**
 * The power switch. Browsers allow no sound until the visitor clicks or
 * types, so a fresh visit starts with the machine off: the click or key that
 * switches it on also unlocks the speaker, and the boot bell can ring.
 * Power-on plays the degauss thunk and the line-output whine while the
 * picture opens from a bright line, as a CRT warms up.
 */
import { audioContext } from './audio';

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** Shows the switch on `wrap` and resolves when the visitor turns it on. */
export function waitForPower(wrap: HTMLElement): Promise<void> {
  wrap.classList.add('power-off');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'power-switch';
  button.setAttribute('aria-label', 'Power on the computer');
  button.innerHTML = '<span class="power-icon">⏻</span><span>Press any key or click to power on</span>';
  wrap.append(button);

  return new Promise((resolve) => {
    const on = () => {
      window.removeEventListener('keydown', onKey, true);
      button.remove();
      wrap.classList.remove('power-off');
      resolve();
    };
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      // Typing in a form field (the DeepSeek key, say) is not the power switch.
      if (t?.closest('input, select, textarea:not(.xterm-helper-textarea), dialog')) return;
      // Browser shortcuts (Cmd-R, F5, Tab to move focus) stay the browser's.
      if (e.metaKey || e.ctrlKey || e.altKey || e.key === 'Tab' || /^F\d+$/.test(e.key)) return;
      // The key turns the machine on; CP/M never sees it.
      e.preventDefault();
      e.stopPropagation();
      on();
    };
    window.addEventListener('keydown', onKey, true);
    button.addEventListener('click', on);
  });
}

/** The picture opening and the warm-up sounds; resolves when the screen is up. */
export function warmUp(wrap: HTMLElement): Promise<void> {
  playWarmUp(wrap.dataset.signal === 'pal' ? 15625 : 15734);
  if (reducedMotion()) return Promise.resolve();
  const raster = document.createElement('div');
  raster.className = 'crt-on';
  raster.setAttribute('aria-hidden', 'true');
  wrap.append(raster);
  return new Promise((resolve) => {
    setTimeout(resolve, 650); // text starts as the picture opens
    setTimeout(() => raster.remove(), 1400);
  });
}

function playWarmUp(lineHz: number): void {
  const ctx = audioContext();
  if (!ctx) return;
  void ctx.resume?.();
  try {
    const t = ctx.currentTime + 0.02;
    const out = ctx.createGain();
    out.gain.value = 0.3;
    out.connect(ctx.destination);

    // The relay and the degauss coil: a thump, then mains hum dying away.
    const len = Math.ceil(0.12 * ctx.sampleRate);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
    const thump = ctx.createBufferSource();
    thump.buffer = buf;
    const thumpLp = ctx.createBiquadFilter();
    thumpLp.type = 'lowpass';
    thumpLp.frequency.value = 900;
    const thumpGain = ctx.createGain();
    thumpGain.gain.value = 0.9;
    thump.connect(thumpLp).connect(thumpGain).connect(out);
    thump.start(t);

    const hum = ctx.createOscillator();
    hum.type = 'sawtooth';
    hum.frequency.setValueAtTime(lineHz === 15625 ? 50 : 60, t);
    const humLp = ctx.createBiquadFilter();
    humLp.type = 'lowpass';
    humLp.frequency.setValueAtTime(700, t);
    humLp.frequency.exponentialRampToValueAtTime(160, t + 1.3);
    const humGain = ctx.createGain();
    humGain.gain.setValueAtTime(0, t);
    humGain.gain.linearRampToValueAtTime(0.5, t + 0.04);
    humGain.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
    hum.connect(humLp).connect(humGain).connect(out);
    hum.start(t);
    hum.stop(t + 1.45);

    // The flyback's line-frequency whine, faint, settling as it warms.
    const whine = ctx.createOscillator();
    whine.frequency.setValueAtTime(lineHz, t);
    const whineGain = ctx.createGain();
    whineGain.gain.setValueAtTime(0, t);
    whineGain.gain.linearRampToValueAtTime(0.02, t + 0.35);
    whineGain.gain.linearRampToValueAtTime(0, t + 2.2);
    whine.connect(whineGain).connect(out);
    whine.start(t);
    whine.stop(t + 2.25);
  } catch {
    /* no audio */
  }
}
