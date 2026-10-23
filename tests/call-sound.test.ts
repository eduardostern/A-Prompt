import { describe, expect, it } from 'vitest';
import { Dialer, LinkHandlers, Modem } from '../src/cpm/modem';
import { withCallSound } from '../src/call-sound';
import type { CallSound } from '../src/modem-audio';
import { digitsFor } from '../src/modem-audio';

class FakeSound implements CallSound {
  log: string[] = [];
  private resolve?: () => void;
  answered() { this.log.push('answered'); return new Promise<void>((r) => { this.resolve = r; }); }
  failed() { this.log.push('failed'); }
  stop() { this.log.push('stop'); }
  finishHandshake() { this.resolve?.(); }
}

function setup() {
  const sound = new FakeSound();
  let far!: LinkHandlers;
  let closed = false;
  const inner: Dialer = (_t, h) => { far = h; return { send: () => {}, close: () => { closed = true; } }; };
  const modem = new Modem({ dialer: withCallSound(inner, () => sound) });
  const type = (s: string) => { for (const c of s) modem.write(c.charCodeAt(0)); };
  const drain = () => { let s = ''; while (modem.available) s += String.fromCharCode(modem.read()); return s; };
  type('ATDT1\r');
  drain();
  return { sound, far: () => far, modem, drain, closed: () => closed, type };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('modem speaker', () => {
  it('holds CONNECT and early data until the handshake has played', async () => {
    const t = setup();
    t.far().onOpen();
    t.far().onData(Uint8Array.from([72, 105]));
    await flush();
    expect(t.drain()).toBe('');
    expect(t.modem.online).toBe(false);
    t.sound.finishHandshake();
    await flush();
    expect(t.drain()).toBe('\r\nCONNECT\r\nHi');
    expect(t.modem.online).toBe(true);
    t.far().onData(Uint8Array.from([33]));
    expect(t.drain()).toBe('!');
  });

  it('plays busy when the call fails, and stops on hang-up', async () => {
    const t = setup();
    t.far().onClose();
    expect(t.sound.log).toEqual(['failed']);
    expect(t.drain()).toContain('NO CARRIER');

    const u = setup();
    u.far().onOpen();
    u.type('x'); // a key while dialing hangs up
    expect(u.closed()).toBe(true);
    expect(u.sound.log).toEqual(['answered', 'stop']);
    u.sound.finishHandshake();
    await flush();
    expect(u.modem.online).toBe(false); // no late CONNECT
  });

  it('ATM and ATL set the speaker; AT&W saves, ATZ restores, AT&F resets', () => {
    const modem = new Modem();
    const saved: unknown[] = [];
    modem.onSaveProfile = (p) => saved.push(p);
    const type = (s: string) => { for (const c of s) modem.write(c.charCodeAt(0)); };
    type('ATM0L3&W\r');
    expect([modem.speaker, modem.volume]).toEqual([0, 3]);
    expect(saved).toEqual([{ speaker: 0, volume: 3 }]);
    type('ATM2L1\r');
    type('ATZ\r');
    expect([modem.speaker, modem.volume]).toEqual([0, 3]);
    type('AT&F\r');
    expect([modem.speaker, modem.volume]).toEqual([1, 2]);
    modem.loadProfile({ speaker: 2, volume: 9 });
    expect([modem.speaker, modem.volume]).toEqual([2, 3]);
    let s = '';
    type('ATI\r');
    while (modem.available) s += String.fromCharCode(modem.read());
    expect(s).toContain('speaker M2 L3');
  });

  it('dials a stable, plausible number for each host', () => {
    const a = digitsFor('vert.synchro.net:23');
    expect(a).toMatch(/^1[2-9]\d\d[2-9]\d{6}$/);
    expect(digitsFor('vert.synchro.net:23')).toBe(a);
    expect(digitsFor('telehack.com:23')).not.toBe(a);
  });
});
