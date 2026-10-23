/**
 * The modem's speaker, synthesized with Web Audio (no recordings): dial tone,
 * touch-tone digits, ringback, the answer and training handshake, and a busy
 * signal when the call fails. Frequencies follow the North American tone plan
 * (dial 350+440 Hz, ringback 440+480, busy 480+620), DTMF (ITU-T Q.23) and
 * the V.8/V.34 start-up: 2100 Hz answer tone with 15 Hz amplitude modulation
 * and phase reversals, V.21 FSK negotiation, line-probing tones, then the hiss
 * of the scrambled training.
 *
 * The schedule* functions work on any BaseAudioContext, so a test can render
 * them offline and check the frequencies.
 */
import { audioContext } from './audio';

const DTMF: Record<string, [number, number]> = {
  1: [697, 1209], 2: [697, 1336], 3: [697, 1477],
  4: [770, 1209], 5: [770, 1336], 6: [770, 1477],
  7: [852, 1209], 8: [852, 1336], 9: [852, 1477],
  '*': [941, 1209], 0: [941, 1336], '#': [941, 1477],
};

/** A made-up but stable phone number for a host: 1, area code, number. */
export function digitsFor(target: string): string {
  let h = 0x811c9dc5;
  for (const c of target) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  const d = (n: number, lo = 0) => String(lo + (Math.floor(h / 10 ** n) % (10 - lo)));
  return `1${d(0, 2)}${d(1)}${d(2)}${d(3, 2)}${d(4)}${d(5)}${d(6)}${d(7)}${d(8)}${d(1)}`;
}

/** Schedules sounds into `dest` and can stop them all. */
export class Synth {
  private nodes: AudioScheduledSourceNode[] = [];
  private seed = 1;

  constructor(readonly ctx: BaseAudioContext, readonly dest: AudioNode) {}

  private random(): number {
    this.seed = (this.seed * 1103515245 + 12345) >>> 0;
    return this.seed / 4294967296;
  }

  /** A gain node with short ramps from t to t+dur. */
  private envelope(t: number, dur: number, level: number): GainNode {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.005);
    g.gain.setValueAtTime(level, Math.max(t + 0.005, t + dur - 0.005));
    g.gain.linearRampToValueAtTime(0, t + dur);
    g.connect(this.dest);
    return g;
  }

  private osc(freq: number, t: number, dur: number, into: AudioNode, type: OscillatorType = 'sine'): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.connect(into);
    o.start(t);
    o.stop(t + dur + 0.01);
    this.nodes.push(o);
    return o;
  }

  /** Several sine tones together; returns the end time. */
  tones(freqs: number[], t: number, dur: number, level = 0.5): number {
    const g = this.envelope(t, dur, level / freqs.length);
    for (const f of freqs) this.osc(f, t, dur, g);
    return t + dur;
  }

  dialTone(t: number, dur = 0.9): number {
    return this.tones([350, 440], t, dur);
  }

  dtmf(t: number, digits: string): number {
    for (const ch of digits) {
      const pair = DTMF[ch];
      if (pair) this.tones(pair, t, 0.08, 0.6);
      t += 0.14;
    }
    return t;
  }

  /** One ring of ringback; returns when the next ring would start. */
  ring(t: number): number {
    this.tones([440, 480], t, 1.2, 0.35);
    return t + 3;
  }

  busy(t: number, cycles = 3): number {
    for (let i = 0; i < cycles; i++) t = this.tones([480, 620], t, 0.5, 0.45) + 0.5;
    return t;
  }

  /** White noise through a band-pass, for the training hiss. */
  private noise(t: number, dur: number, centre: number, level: number): void {
    const len = Math.ceil(dur * this.ctx.sampleRate);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = this.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const band = this.ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.setValueAtTime(centre, t);
    band.Q.value = 0.9;
    src.connect(band).connect(this.envelope(t, dur, level));
    src.start(t);
    src.stop(t + dur + 0.01);
    this.nodes.push(src);
  }

  /** V.21 FSK: random bits at 300 baud between the mark and space tones. */
  private fsk(t: number, dur: number, mark: number, space: number, level: number): void {
    const o = this.osc(mark, t, dur, this.envelope(t, dur, level));
    for (let s = t; s < t + dur; s += 1 / 300) o.frequency.setValueAtTime(this.random() < 0.5 ? mark : space, s);
  }

  /** The handshake from the answer tone to the data carrier; returns the end time. */
  handshake(t: number, seed = 1): number {
    this.seed = seed || 1;
    // ANSam: 2100 Hz, 15 Hz amplitude modulation, a phase reversal every 450 ms.
    const ans = 1.6;
    const g = this.envelope(t, ans, 0.32);
    const am = this.ctx.createGain();
    am.gain.setValueAtTime(0.8, t);
    am.connect(g);
    const lfo = this.ctx.createOscillator();
    lfo.frequency.setValueAtTime(15, t);
    const depth = this.ctx.createGain();
    depth.gain.setValueAtTime(0.2, t);
    lfo.connect(depth).connect(am.gain);
    lfo.start(t);
    lfo.stop(t + ans + 0.01);
    this.nodes.push(lfo);
    this.osc(2100, t, ans, am);
    for (let r = t + 0.45; r < t + ans; r += 0.45) {
      am.gain.setValueAtTime(0.8, r - 0.004);
      am.gain.linearRampToValueAtTime(0, r);
      am.gain.linearRampToValueAtTime(0.8, r + 0.004);
    }
    t += ans + 0.08;
    // V.8 call menu and joint menu over V.21: the caller's channel, then ours.
    this.fsk(t, 0.45, 1180, 980, 0.25);
    t += 0.45;
    this.fsk(t, 0.4, 1850, 1650, 0.25);
    t += 0.5;
    // Line probing: a comb of tones every 150 Hz, twice.
    const comb = Array.from({ length: 24 }, (_, i) => 150 * (i + 1));
    t = this.tones(comb, t, 0.18, 0.5) + 0.12;
    t = this.tones(comb, t, 0.18, 0.5) + 0.1;
    // Equalizer training: scrambled data, one side, then both at once.
    this.noise(t, 1.1, 1800, 0.5);
    this.tones([1800], t, 0.25, 0.15);
    t += 1.1;
    this.noise(t, 1.0, 2400, 0.45);
    this.noise(t, 1.0, 1200, 0.3);
    return t + 1.0;
  }

  stopAll(): void {
    for (const n of this.nodes) {
      try { n.stop(); } catch { /* not started or already stopped */ }
    }
    this.nodes = [];
  }
}

/** The sounds of one call, driven by what the line does. */
export interface CallSound {
  /** The far end answered: plays the handshake, resolves when it ends. */
  answered(): Promise<void>;
  /** The call failed: busy signal. */
  failed(): void;
  /** Hung up: silence. */
  stop(): void;
}

/** The speaker's output: the volume (ATL0-3), and a telephone line's band. */
function lineOut(ctx: AudioContext, volume: number): AudioNode {
  const level = [0.08, 0.12, 0.22, 0.4][Math.max(0, Math.min(3, volume))];
  const gain = ctx.createGain();
  gain.gain.value = level;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 300;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 3400;
  gain.connect(hp).connect(lp).connect(ctx.destination);
  return gain;
}

/** Starts the dialing sounds for a call to `target`; undefined without audio. */
export function startCallSound(target: string, volume: number): CallSound | undefined {
  const ctx = audioContext();
  if (!ctx) return undefined;
  const out = lineOut(ctx, volume);
  const synth = new Synth(ctx, out);
  let t = ctx.currentTime + 0.05;
  t = synth.dialTone(t);
  const dialed = synth.dtmf(t + 0.1, digitsFor(target)) + 0.4;
  let nextRing = dialed;
  let done = false;
  let ringTimer: ReturnType<typeof setTimeout> | undefined;
  // Ring until the far end answers.
  const ring = () => {
    if (done) return;
    nextRing = synth.ring(Math.max(nextRing, ctx.currentTime));
    ringTimer = setTimeout(ring, (nextRing - ctx.currentTime - 0.2) * 1000);
  };
  ringTimer = setTimeout(ring, Math.max(0, (dialed - ctx.currentTime - 0.2) * 1000));
  const finish = () => {
    done = true;
    clearTimeout(ringTimer);
  };
  return {
    answered() {
      finish();
      synth.stopAll();
      // Answer once the number is dialed, as a real call would.
      const start = Math.max(ctx.currentTime + 0.05, dialed);
      const end = new Synth(ctx, out).handshake(start, digitsFor(target).length + target.length);
      return new Promise((resolve) => setTimeout(resolve, (end - ctx.currentTime) * 1000));
    },
    failed() {
      finish();
      synth.stopAll();
      new Synth(ctx, out).busy(Math.max(ctx.currentTime + 0.05, dialed - 0.3));
    },
    stop() {
      finish();
      synth.stopAll();
      out.disconnect();
    },
  };
}
