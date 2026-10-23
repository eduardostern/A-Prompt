import { afterEach, describe, expect, it, vi } from 'vitest';
import { digitsFor, playCall } from '../src/modem-audio';

/** Records every oscillator's frequency, start and (last) stop time. */
class FakeContext {
  currentTime = 0;
  sampleRate = 8000;
  oscs: { freq: number; start: number; stop: number }[] = [];
  private param() {
    return { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {} };
  }
  private node() {
    return { connect: (n: unknown) => n, disconnect() {} };
  }
  createGain() {
    return { ...this.node(), gain: this.param() };
  }
  createBiquadFilter() {
    return { ...this.node(), type: '', frequency: this.param(), Q: this.param() };
  }
  createBuffer(_c: number, len: number) {
    return { getChannelData: () => new Float32Array(len) };
  }
  createBufferSource() {
    return { ...this.node(), buffer: null, start() {}, stop() {} };
  }
  createOscillator() {
    const rec = { freq: 0, start: 0, stop: Infinity };
    this.oscs.push(rec);
    return {
      ...this.node(),
      type: 'sine',
      frequency: { value: 0, setValueAtTime: (f: number) => { if (!rec.freq) rec.freq = f; }, linearRampToValueAtTime() {} },
      start: (t: number) => { rec.start = t; },
      stop: (t = this.currentTime) => { rec.stop = t; },
    };
  }
}

/** Tones of `freq` that actually sound (stop after start). */
const heard = (ctx: FakeContext, freq: number) => ctx.oscs.filter((o) => o.freq === freq && o.stop > o.start);

describe('call sound', () => {
  afterEach(() => vi.useRealTimers());

  it('plays the digits and a ring even when the far end answers at once', () => {
    vi.useFakeTimers();
    const ctx = new FakeContext();
    const call = playCall(ctx as unknown as BaseAudioContext, ctx.createGain() as unknown as AudioNode, 'bbs.example');
    ctx.currentTime = 0.3; // the relay connected during the dial tone
    void call.answered();
    const digits = digitsFor('bbs.example');
    // Each digit has one column tone (1209/1336/1477 Hz).
    const cols = ctx.oscs.filter((o) => [1209, 1336, 1477].includes(o.freq) && o.stop > o.start);
    expect(cols).toHaveLength(digits.length);
    const rings = heard(ctx, 480).filter((o) => o.stop - o.start > 1);
    expect(rings).toHaveLength(1);
    const answer = heard(ctx, 2100)[0];
    expect(answer.start).toBeGreaterThanOrEqual(rings[0].stop);
  });

  it('lets the current ring finish and cancels the next one', () => {
    vi.useFakeTimers();
    const ctx = new FakeContext();
    const call = playCall(ctx as unknown as BaseAudioContext, ctx.createGain() as unknown as AudioNode, 'x');
    for (let i = 0; i < 100; i++) {
      ctx.currentTime += 0.1;
      vi.advanceTimersByTime(100);
    }
    void call.answered(); // at 10 s, between rings
    const rings = heard(ctx, 480).filter((o) => o.stop - o.start > 0.5);
    expect(rings.length).toBeGreaterThanOrEqual(1);
    expect(rings.every((r) => r.start < 10)).toBe(true);
    expect(heard(ctx, 2100)[0].start).toBeGreaterThanOrEqual(10);
  });
});
