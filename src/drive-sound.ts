/**
 * Machine sounds, synthesized: the floppy drive (motor whir, the head-load
 * solenoid's clack, a tick for every track the head steps) and optional key
 * clicks. The BDOS reports each access with the track a real 8" drive would
 * seek to (`Bdos.onDisk`); this turns that stream into sound, so a burst of
 * reads on one track is quiet and a seek across the disk chatters.
 */
import { audioContext } from './audio';

const STEP_S = 0.009; // a little slower than an 8" drive's 6 ms, so ticks stay distinct
const MAX_STEPS = 14; // a long seek is a burst, not a second of ticking
const MOTOR_IDLE_MS = 1600; // the motor runs on after the last access
const VOLUME = 0.5;

export class MachineSounds {
  drive = true;
  keys = false;

  private out?: GainNode;
  private click?: AudioBuffer;
  private clack?: AudioBuffer;
  private key?: AudioBuffer;
  private track = 2;
  private nextStep = 0;
  private motor?: { stop(): void };
  private motorTimer?: ReturnType<typeof setTimeout>;

  /** The context, only once the browser lets the page play sound. */
  private ready(): AudioContext | undefined {
    const ctx = audioContext();
    if (!ctx || ctx.state !== 'running') return undefined;
    if (!this.out) {
      this.out = ctx.createGain();
      this.out.gain.value = VOLUME;
      this.out.connect(ctx.destination);
      this.click = burst(ctx, 0.006, 3);
      this.clack = burst(ctx, 0.03, 1.5);
      this.key = burst(ctx, 0.012, 2.5);
    }
    return ctx;
  }

  /** One disk access on `track`. */
  disk(track: number): void {
    if (!this.drive) return;
    const ctx = this.ready();
    if (!ctx) return;
    const now = ctx.currentTime;
    if (!this.motor) {
      this.motor = this.startMotor(ctx, now);
      this.play(ctx, this.clack!, now, 900, 0.9, 0.7); // head loads onto the disk
      this.nextStep = now + 0.05;
    }
    clearTimeout(this.motorTimer);
    this.motorTimer = setTimeout(() => {
      this.motor?.stop();
      this.motor = undefined;
    }, MOTOR_IDLE_MS);

    const steps = Math.min(Math.abs(track - this.track), MAX_STEPS);
    this.track = track;
    let t = Math.max(now, this.nextStep);
    // Do not let a fast program queue up seconds of ticks.
    if (t > now + 0.25) return;
    for (let i = 0; i < steps; i++, t += STEP_S) this.play(ctx, this.click!, t, 2600, 1.2, 0.55);
    this.nextStep = t;
  }

  /** A key going down. */
  keyClick(): void {
    if (!this.keys) return;
    const ctx = this.ready();
    if (!ctx) return;
    this.play(ctx, this.key!, ctx.currentTime, 1800 + Math.random() * 500, 0.8, 0.45);
  }

  private play(ctx: AudioContext, buf: AudioBuffer, t: number, freq: number, q: number, gain: number): void {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = freq;
    band.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(band).connect(g).connect(this.out!);
    src.start(t);
  }

  /** The spindle: low rumble with a 300 rpm wobble, fading in and out. */
  private startMotor(ctx: AudioContext, t: number): { stop(): void } {
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 260;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.16, t + 0.25);
    const wobble = ctx.createOscillator();
    wobble.frequency.value = 5;
    const depth = ctx.createGain();
    depth.gain.value = 0.04;
    wobble.connect(depth).connect(g.gain);
    src.connect(lp).connect(g).connect(this.out!);
    src.start(t);
    wobble.start(t);
    return {
      stop: () => {
        const end = ctx.currentTime;
        g.gain.cancelScheduledValues(end);
        g.gain.setValueAtTime(g.gain.value, end);
        g.gain.linearRampToValueAtTime(0, end + 0.4);
        src.stop(end + 0.45);
        wobble.stop(end + 0.45);
      },
    };
  }
}

/** A noise burst decaying over `dur` seconds; `shape` steepens the decay. */
function burst(ctx: BaseAudioContext, dur: number, shape: number): AudioBuffer {
  const len = Math.max(1, Math.ceil(dur * ctx.sampleRate));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** shape;
  return buf;
}
