/**
 * The VT100 bell: the keyboard's small speaker driven by a square wave.
 *
 * MAME's VT100 keyboard drives it at ~786 Hz (the keyboard UART's serial
 * clock, 7.945 µs per bit, divided by 160), and the VT100 Technical Manual
 * (4.4.3) has the terminal send the speaker bit "approximately two hundred
 * times in a row, for about a quarter second". A band-pass stands in for the
 * little speaker in the keyboard case.
 */
const FREQ_HZ = 786;
const DURATION_S = 0.25;
const VOLUME = 0.12;

let ctx: AudioContext | undefined;
let busyUntil = 0;

export function ringBell(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
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
