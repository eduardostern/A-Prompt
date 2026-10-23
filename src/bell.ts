/**
 * The VT100 bell: the keyboard's small speaker driven by a square wave.
 *
 * MAME's VT100 keyboard drives it at ~786 Hz (the keyboard UART's serial
 * clock, 7.945 µs per bit, divided by 160), and the VT100 Technical Manual
 * (4.4.3) has the terminal send the speaker bit "approximately two hundred
 * times in a row, for about a quarter second". A band-pass stands in for the
 * little speaker in the keyboard case.
 */
import { audioContext } from './audio';

const FREQ_HZ = 786;
const DURATION_S = 0.25;
const VOLUME = 0.05;

let busyUntil = 0;

/** A bell rung while the browser still blocks sound waits for it. */
let waiting = false;

/**
 * Rings after the screen has drawn: setting up audio can take the main
 * thread for a moment, and the text before the bell should not wait for it.
 */
export function ringBell(): void {
  requestAnimationFrame(() => setTimeout(ring, 0));
}

function ring(): void {
  const ctx = audioContext();
  if (!ctx) return;
  if (ctx.state !== 'running') {
    // Before the first click or key the context stays suspended; resume()
    // settles once the page may play sound, and the bell rings then.
    if (!waiting) {
      waiting = true;
      ctx.resume().then(
        () => { waiting = false; ring(); },
        () => { waiting = false; },
      );
    }
    return;
  }
  try {
    const t = ctx.currentTime;
    // A bell while one is sounding just merges into it, like the real one.
    if (t < busyUntil) return;
    busyUntil = t + DURATION_S;

    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = FREQ_HZ;

    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 350; // a 2-inch speaker has no bass
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 5000;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(VOLUME, t + 0.003);
    gain.gain.setValueAtTime(VOLUME, t + DURATION_S - 0.006);
    gain.gain.linearRampToValueAtTime(0, t + DURATION_S);

    osc.connect(highpass).connect(lowpass).connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + DURATION_S + 0.01);
  } catch {
    /* no audio available */
  }
}
