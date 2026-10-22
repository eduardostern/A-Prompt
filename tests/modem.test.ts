import { describe, expect, it } from 'vitest';
import { Dialer, LinkHandlers, Modem, MODEM_CARRIER, MODEM_RX_READY } from '../src/cpm/modem';
import { inPhoneBook, PHONE_BOOK } from '../src/phonebook';
import { originAllowed } from '../worker/origin';

const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;

class FakeLine {
  calls: { host: string; port: number }[] = [];
  sent: number[] = [];
  closed = false;
  handlers?: LinkHandlers;
  dialer: Dialer = (host, port, handlers) => {
    this.calls.push({ host, port });
    this.handlers = handlers;
    this.closed = false;
    return {
      send: (b) => this.sent.push(...b),
      close: () => { this.closed = true; },
    };
  };
}

function setup() {
  const line = new FakeLine();
  let clock = 10_000;
  const modem = new Modem({
    dialer: line.dialer,
    phoneBook: () => [{ host: 'bbs.example.com', port: 2323, name: 'Example' }],
    terminalType: () => 'ANSI',
    windowSize: () => [80, 25],
    now: () => clock,
  });
  const type = (s: string) => { for (const c of s) modem.write(c.charCodeAt(0)); };
  const drain = () => {
    let s = '';
    while (modem.status() & MODEM_RX_READY) s += String.fromCharCode(modem.read());
    return s;
  };
  const tick = (ms: number) => { clock += ms; };
  return { modem, line, type, drain, tick };
}

const bytes = (...b: number[]) => Uint8Array.from(b);

describe('telnet modem', () => {
  it('answers AT with OK and echoes the command', () => {
    const { type, drain } = setup();
    type('AT\r');
    expect(drain()).toBe('AT\r\n\r\nOK\r\n');
  });

  it('ATE0 turns echo off and bad commands give ERROR', () => {
    const { type, drain } = setup();
    type('ATE0\r');
    drain();
    type('ATQ0V1\r');
    expect(drain()).toBe('\r\nOK\r\n');
    type('ATY\r');
    expect(drain()).toBe('\r\nERROR\r\n');
  });

  it('dials host:port and reports CONNECT once the relay is up', () => {
    const { modem, line, type, drain } = setup();
    type('ATDT bbs.example.com:2323\r');
    expect(line.calls).toEqual([{ host: 'bbs.example.com', port: 2323 }]);
    drain();
    expect(modem.status() & MODEM_CARRIER).toBe(0);
    line.handlers!.onOpen();
    expect(drain()).toBe('\r\nCONNECT\r\n');
    expect(modem.status() & MODEM_CARRIER).toBe(MODEM_CARRIER);
  });

  it('dials phone book entries by number, port 23 by default', () => {
    const { line, type } = setup();
    type('ATDT1\r');
    line.handlers!.onClose();
    type('ATD other.example.org\r');
    expect(line.calls).toEqual([
      { host: 'bbs.example.com', port: 2323 },
      { host: 'other.example.org', port: 23 },
    ]);
  });

  it('ATI lists the phone book', () => {
    const { type, drain } = setup();
    type('ATI\r');
    expect(drain()).toContain(' 1  bbs.example.com:2323  Example\r\n');
  });

  it('a failed call gives NO CARRIER', () => {
    const { modem, line, type, drain } = setup();
    type('ATDT 1\r');
    drain();
    line.handlers!.onClose();
    expect(drain()).toBe('\r\nNO CARRIER\r\n');
    expect(modem.online).toBe(false);
  });

  it('passes data both ways, telnet-escaped', () => {
    const { modem, line, type, drain } = setup();
    type('ATDT1\r');
    line.handlers!.onOpen();
    drain();
    line.handlers!.onData(bytes(72, 105, IAC, IAC, 13, 0, 10));
    expect([...drain()].map((c) => c.charCodeAt(0))).toEqual([72, 105, 255, 13, 10]);
    modem.write(0x41);
    modem.write(0xff);
    modem.write(13);
    expect(line.sent).toEqual([0x41, IAC, IAC, 13, 0]);
  });

  it('negotiates echo, SGA, terminal type and window size', () => {
    const { line, type, drain } = setup();
    type('ATDT1\r');
    line.handlers!.onOpen();
    drain();
    line.handlers!.onData(bytes(
      IAC, WILL, 1, IAC, WILL, 3, IAC, DO, 24, IAC, DO, 31, IAC, DO, 32, IAC, WILL, 99,
      IAC, SB, 24, 1, IAC, SE, 79, 75,
    ));
    expect(drain()).toBe('OK');
    expect(line.sent).toEqual([
      IAC, DO, 1, IAC, DO, 3, IAC, WILL, 24,
      IAC, WILL, 31, IAC, SB, 31, 0, 80, 0, 25, IAC, SE,
      IAC, WONT, 32, IAC, DONT, 99,
      IAC, SB, 24, 0, 65, 78, 83, 73, IAC, SE,
    ]);
    // A repeated request is not answered again (no negotiation loops).
    line.sent = [];
    line.handlers!.onData(bytes(IAC, DO, 32));
    expect(line.sent).toEqual([]);
  });

  it('keeps a telnet command split across packets', () => {
    const { line, type, drain } = setup();
    type('ATDT1\r');
    line.handlers!.onOpen();
    drain();
    line.handlers!.onData(bytes(65, IAC));
    line.handlers!.onData(bytes(WILL));
    line.handlers!.onData(bytes(1, 66));
    expect(drain()).toBe('AB');
    expect(line.sent).toEqual([IAC, DO, 1]);
  });

  it('+++ with guard time escapes to command mode, ATO resumes, ATH hangs up', () => {
    const { modem, line, type, drain, tick } = setup();
    type('ATDT1\r');
    line.handlers!.onOpen();
    drain();
    tick(1500);
    type('+++');
    expect(modem.online).toBe(true);
    tick(1200);
    expect(drain()).toBe('\r\nOK\r\n');
    expect(modem.online).toBe(false);
    type('ATO\r');
    expect(drain()).toContain('CONNECT');
    expect(modem.online).toBe(true);
    tick(1500);
    type('+++');
    tick(1200);
    drain();
    type('ATH\r');
    expect(line.closed).toBe(true);
    expect(drain()).toBe('ATH\r\n\r\nOK\r\n');
  });

  it('+++ inside typed text does not escape', () => {
    const { modem, line, type, tick } = setup();
    type('ATDT1\r');
    line.handlers!.onOpen();
    tick(100);
    type('a+++');
    tick(2000);
    expect(modem.status() & MODEM_CARRIER).toBe(MODEM_CARRIER);
  });

  it('remote hang-up reports NO CARRIER; dropping DTR hangs up quietly', () => {
    const a = setup();
    a.type('ATDT1\r');
    a.line.handlers!.onOpen();
    a.drain();
    a.line.handlers!.onClose();
    expect(a.drain()).toBe('\r\nNO CARRIER\r\n');

    const b = setup();
    b.type('ATDT1\r');
    b.line.handlers!.onOpen();
    b.modem.control(0);
    expect(b.line.closed).toBe(true);
    expect(b.modem.online).toBe(false);
    expect(b.drain()).toBe('');
  });

  it('a key pressed while dialing aborts the call', () => {
    const { line, type, drain } = setup();
    type('ATDT1\r');
    drain();
    type('x');
    expect(line.closed).toBe(true);
    expect(drain()).toBe('\r\nNO CARRIER\r\n');
    line.handlers!.onOpen(); // a late answer is ignored
    expect(drain()).toBe('');
  });

  it('without a dialer reports NO DIALTONE', () => {
    const modem = new Modem();
    for (const c of 'ATDT1\r') modem.write(c.charCodeAt(0));
    let s = '';
    while (modem.available) s += String.fromCharCode(modem.read());
    expect(s).toContain('NO DIALTONE');
  });

  it('readBlocking waits for data and returns ^Z without carrier', async () => {
    const { modem, line, type, drain } = setup();
    expect(await modem.readBlocking()).toBe(0x1a);
    type('ATDT1\r');
    line.handlers!.onOpen();
    drain();
    const pending = modem.readBlocking();
    line.handlers!.onData(bytes(0x42));
    expect(await pending).toBe(0x42);
    const waiting = modem.readBlocking();
    line.handlers!.onClose();
    expect(await waiting).toBe(13); // the NO CARRIER message
  });
});

describe('relay phone book', () => {
  it('allows only listed host:port pairs', () => {
    const e = PHONE_BOOK[0];
    expect(inPhoneBook(e.host, e.port)).toBe(true);
    expect(inPhoneBook(e.host.toUpperCase(), e.port)).toBe(true);
    expect(inPhoneBook(e.host, e.port + 1)).toBe(false);
    expect(inPhoneBook('localhost', 22)).toBe(false);
  });

  it('accepts same-origin and local pages only', () => {
    expect(originAllowed(null, 'a-prompt.example.dev')).toBe(true);
    expect(originAllowed('https://a-prompt.example.dev', 'a-prompt.example.dev')).toBe(true);
    expect(originAllowed('http://localhost:5173', 'localhost:8787')).toBe(true);
    expect(originAllowed('https://evil.example.com', 'a-prompt.example.dev')).toBe(false);
    expect(originAllowed('not a url', 'a-prompt.example.dev')).toBe(false);
  });
});
