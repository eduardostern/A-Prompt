/**
 * Machine sounds, synthesized: the disk drives and optional key clicks. Each
 * kind of drive sounds like itself:
 *
 * - 8" floppy: a quiet spindle whir, the head-load solenoid's clack when an
 *   access starts, a sharp tick for every track the head steps.
 * - 5¼" floppy: the motor spinning up, and a buzzy stepper ("brrrt" on a
 *   long seek).
 * - Hard disk: a spin-up whine the first time, then a faint steady whine,
 *   and quick soft ticks when it seeks; it spins down after 6 s idle.
 *
 * A floppy recalibrates on its first access (a seek to track 0 and back),
 * the grind every CP/M machine made at boot. Motors stop half a second
 * (8") or about a second (5¼") after the last access. The timing comes
 * from `DriveTiming` (src/drives.ts).
 */
import { audioContext } from './audio';
import type { DriveKind } from './drives';

const MAX_STEPS = 14; // a long seek is a burst, not a second of ticking
const VOLUME = 0.5;
const HARD_SPIN_DOWN_MS = 6000;
/** How long a floppy's motor runs on after the last access. */
const FLOPPY_RUN_ON_MS = { floppy8: 500, floppy5: 900 };

interface Access {
  steps: number;
  started: boolean;
  kind: DriveKind;
}

interface Motor {
  stop(): void;
}

export class MachineSounds {
  drive = true;
  keys = false;

  private out?: GainNode;
  private click?: AudioBuffer;
  private clack?: AudioBuffer;
  private key?: AudioBuffer;
  private noise?: AudioBuffer;
  private motors = new Map<number, { motor: Motor; timer?: ReturnType<typeof setTimeout> }>();
  private nextStep = new Map<number, number>();
  private seen = new Set<number>();

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
      const len = ctx.sampleRate * 2;
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    return ctx;
  }

  /** One access to `drive`, as `DriveTiming.access` priced it. */
  disk(drive: number, a: Access): void {
    if (!this.drive) return;
    const ctx = this.ready();
    if (!ctx) return;
    const now = ctx.currentTime;
    let steps = Math.min(a.steps, MAX_STEPS);
    let t = Math.max(now, this.nextStep.get(drive) ?? 0);

    let m = this.motors.get(drive);
    if (!m) {
      m = { motor: this.startMotor(ctx, a.kind, now, !this.seen.has(drive)) };
      this.motors.set(drive, m);
      if (a.kind === 'floppy5') t = Math.max(t, now + 0.35); // the disk has to come up to speed
    }
    clearTimeout(m.timer);
    const motor = m.motor;
    m.timer = setTimeout(() => {
      motor.stop();
      this.motors.delete(drive);
    }, a.kind === 'hard' ? HARD_SPIN_DOWN_MS : FLOPPY_RUN_ON_MS[a.kind]);

    if (a.kind === 'floppy8' && a.started) {
      this.play(ctx, this.clack!, t, 900, 0.9, 0.7); // the head loads onto the disk
      t += 0.04;
    }
    // A floppy's first access recalibrates: out to track 0 and back.
    if (a.kind !== 'hard' && !this.seen.has(drive)) steps = MAX_STEPS * 2;
    this.seen.add(drive);

    // Do not let a fast program queue up seconds of ticks.
    if (t > now + 0.3) return;
    for (let i = 0; i < steps; i++) t = this.step(ctx, a.kind, t);
    this.nextStep.set(drive, t);
  }

  /** A key going down. */
  keyClick(): void {
    if (!this.keys) return;
    const ctx = this.ready();
    if (!ctx) return;
    this.play(ctx, this.key!, ctx.currentTime, 1800 + Math.random() * 500, 0.8, 0.45);
  }

  /** One head step at t; returns when the next may start. */
  private step(ctx: AudioContext, kind: DriveKind, t: number): number {
    switch (kind) {
      case 'floppy8':
        this.play(ctx, this.click!, t, 2600, 1.2, 0.55);
        return t + 0.009;
      case 'floppy5': {
        // The stepper rings: a short buzz under the click.
        this.play(ctx, this.click!, t, 1500, 1.5, 0.35);
        const o = ctx.createOscillator();
        o.type = 'square';
        o.frequency.value = 160;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.05, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.007);
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 1200;
        o.connect(lp).connect(g).connect(this.out!);
        o.start(t);
        o.stop(t + 0.008);
        return t + 0.007;
      }
      case 'hard':
        this.play(ctx, this.click!, t, 4200, 2, 0.18);
        return t + 0.004;
    }
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

  /** The motor of one drive; `first` spins a hard disk up from rest. */
  private startMotor(ctx: AudioContext, kind: DriveKind, t: number, first: boolean): Motor {
    const nodes: AudioScheduledSourceNode[] = [];
    const g = ctx.createGain();
    g.connect(this.out!);
    const rumble = ctx.createBufferSource();
    rumble.buffer = this.noise!;
    rumble.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    rumble.connect(lp).connect(g);
    nodes.push(rumble);

    if (kind === 'floppy8') {
      // The spindle: a quiet, smooth whir (a louder rumble and mains hum
      // sounded like wind and a buzz).
      lp.frequency.value = 220;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.035, t + 0.15);
    } else if (kind === 'floppy5') {
      // DC motor: spins up, with the 300 rpm wobble of the disk.
      lp.frequency.setValueAtTime(70, t);
      lp.frequency.exponentialRampToValueAtTime(340, t + 0.45);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.05, t + 0.3);
      const wobble = ctx.createOscillator();
      wobble.frequency.value = 5;
      const depth = ctx.createGain();
      depth.gain.value = 0.012;
      wobble.connect(depth).connect(g.gain);
      nodes.push(wobble);
    } else {
      // Hard disk: the platters whine up to 3600 rpm, then a faint steady tone.
      lp.frequency.value = 180;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.025, t + (first ? 2 : 0.3));
      const whine = ctx.createOscillator();
      whine.frequency.setValueAtTime(first ? 400 : 3600, t);
      if (first) whine.frequency.exponentialRampToValueAtTime(3600, t + 2.5);
      const wg = ctx.createGain();
      wg.gain.value = 0.1;
      whine.connect(wg).connect(g);
      nodes.push(whine);
    }
    for (const n of nodes) n.start(t);

    return {
      stop: () => {
        const end = ctx.currentTime;
        const fade = kind === 'hard' ? 2 : 0.2;
        g.gain.cancelScheduledValues(end);
        g.gain.setValueAtTime(g.gain.value, end);
        g.gain.linearRampToValueAtTime(0, end + fade);
        for (const n of nodes) {
          if (kind === 'hard' && n instanceof OscillatorNode) n.frequency.exponentialRampToValueAtTime(300, end + fade);
          n.stop(end + fade + 0.05);
        }
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
