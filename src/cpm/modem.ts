/**
 * A Hayes-style modem on a simple UART, wired to a telnet transport.
 *
 * The guest sees two I/O ports (see layout.ts): a status port and a data
 * port. In command mode the modem reads AT commands from the data port and
 * answers with result codes; ATDT opens a connection through the injected
 * dialer (a WebSocket to the Worker relay in the browser, a fake in tests).
 * Online, bytes pass through with the telnet protocol handled here, so the
 * guest sees a clean 8-bit stream.
 */
import { PHONE_BOOK } from '../phonebook';

/** An open connection. */
export interface Link {
  send(bytes: Uint8Array): void;
  close(): void;
}

export interface LinkHandlers {
  onOpen(): void;
  onData(bytes: Uint8Array): void;
  /** The connection ended or could not be made. */
  onClose(): void;
}

export type Dialer = (host: string, port: number, handlers: LinkHandlers) => Link;

/** An entry in the modem's phone book (ATI lists it, ATDT1 dials entry 1). */
export interface PhoneEntry {
  host: string;
  port: number;
  name?: string;
}

/** UART status bits. */
export const MODEM_RX_READY = 0x01;
export const MODEM_TX_READY = 0x02;
export const MODEM_CARRIER = 0x80;

const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;
const OPT_BINARY = 0, OPT_ECHO = 1, OPT_SGA = 3, OPT_TTYPE = 24, OPT_NAWS = 31;
const TTYPE_IS = 0, TTYPE_SEND = 1;

const RX_SIZE = 64 * 1024;
const GUARD_MS = 1000;
const CR = 13, LF = 10, BS = 8, DEL = 127;

type State = 'command' | 'dialing' | 'online';
type Telnet = 'data' | 'iac' | 'verb' | 'sb' | 'sb-iac';

export interface ModemOptions {
  dialer?: Dialer;
  phoneBook?: () => PhoneEntry[];
  /** Terminal name sent for the telnet TERMINAL-TYPE option. */
  terminalType?: () => string;
  /** Columns and rows sent for the telnet NAWS option. */
  windowSize?: () => [number, number];
  now?: () => number;
}

export class Modem {
  dialer?: Dialer;
  phoneBook: () => PhoneEntry[];
  terminalType: () => string;
  windowSize: () => [number, number];
  now: () => number;

  private state: State = 'command';
  private link?: Link;
  private echo = true;
  private line: number[] = [];

  private rx = new Uint8Array(RX_SIZE);
  private rxHead = 0;
  private rxCount = 0;
  private waiters: (() => void)[] = [];

  private telnet: Telnet = 'data';
  private verb = 0;
  private sub: number[] = [];
  private lastWasCr = false;
  /** Options already answered, so a server that repeats itself gets no loop. */
  private answered = new Set<number>();

  // +++ escape: one second of silence, three pluses, one second of silence.
  private lastTx = 0;
  private plus = 0;
  private plusAt = 0;

  constructor(options: ModemOptions = {}) {
    this.dialer = options.dialer;
    this.phoneBook = options.phoneBook ?? (() => [...PHONE_BOOK]);
    this.terminalType = options.terminalType ?? (() => 'ANSI');
    this.windowSize = options.windowSize ?? (() => [80, 24]);
    this.now = options.now ?? (() => Date.now());
  }

  get online(): boolean {
    return this.state === 'online';
  }

  /** Bytes waiting for the guest. */
  get available(): number {
    return this.rxCount;
  }

  status(): number {
    this.checkEscape();
    let s = MODEM_TX_READY;
    if (this.rxCount) s |= MODEM_RX_READY;
    if (this.state === 'online') s |= MODEM_CARRIER;
    return s;
  }

  /** Next byte for the guest, or 0 when none is waiting. */
  read(): number {
    this.checkEscape();
    if (!this.rxCount) return 0;
    const b = this.rx[this.rxHead];
    this.rxHead = (this.rxHead + 1) % RX_SIZE;
    this.rxCount--;
    return b;
  }

  /** Waits for a byte; resolves to 1Ah when there is none and no carrier. */
  async readBlocking(): Promise<number> {
    while (!this.rxCount) {
      if (this.state !== 'online') return 0x1a;
      await new Promise<void>((r) => this.waiters.push(r));
    }
    return this.read();
  }

  write(byte: number): void {
    byte &= 0xff;
    if (this.state === 'online') this.sendData(byte);
    else if (this.state === 'dialing') this.abortDial();
    else this.commandByte(byte);
  }

  /** DTR: a guest that drops it hangs up, as with AT&D2. */
  control(value: number): void {
    if (value & 1) return;
    this.hangup(false);
    this.line = [];
    this.rxHead = this.rxCount = 0;
  }

  /** Drops the line; `report` adds NO CARRIER for the guest. */
  hangup(report = true): void {
    const link = this.link;
    const wasConnected = report && (link !== undefined || this.state !== 'command');
    this.link = undefined;
    this.state = 'command';
    this.resetTelnet();
    link?.close();
    if (wasConnected) this.result('NO CARRIER');
    this.wake();
  }

  // ---- command mode ---------------------------------------------------

  private commandByte(b: number): void {
    const ch = b & 0x7f;
    if (ch === CR) {
      if (this.echo) this.push([CR, LF]);
      const text = String.fromCharCode(...this.line).trim().toUpperCase();
      const raw = String.fromCharCode(...this.line).trim();
      this.line = [];
      if (text.startsWith('AT')) this.execute(raw.slice(2));
      return;
    }
    if (ch === LF) return;
    if (ch === BS || ch === DEL) {
      if (this.line.length) {
        this.line.pop();
        if (this.echo) this.push([BS, 32, BS]);
      }
      return;
    }
    if (ch < 32 || this.line.length >= 80) return;
    this.line.push(ch);
    if (this.echo) this.push([ch]);
  }

  private execute(cmd: string): void {
    let i = 0;
    const num = (): number => {
      let s = '';
      while (i < cmd.length && /\d/.test(cmd[i])) s += cmd[i++];
      return s ? Number(s) : 0;
    };
    while (i < cmd.length) {
      const c = cmd[i++].toUpperCase();
      switch (c) {
        case ' ': break;
        case 'E': this.echo = num() !== 0; break;
        case 'H': num(); this.hangup(false); break;
        case 'Z': num(); this.echo = true; this.hangup(false); break;
        case 'I': num(); this.info(); break;
        case 'V': case 'Q': case 'X': case 'M': case 'L': num(); break;
        case '&': i++; num(); break;
        case 'S': // S-registers: accept and ignore
          num();
          if (cmd[i] === '=' ) { i++; num(); } else if (cmd[i] === '?') { i++; this.reply('000'); }
          break;
        case 'O':
          num();
          if (this.link) { this.state = 'online'; this.result('CONNECT'); return; }
          this.result('NO CARRIER');
          return;
        case 'D':
          this.dial(cmd.slice(i));
          return;
        default:
          this.result('ERROR');
          return;
      }
    }
    this.result('OK');
  }

  private info(): void {
    this.reply('A-Prompt telnet modem');
    const book = this.phoneBook();
    if (!book.length) {
      this.reply('No phone book: ATDT host:port');
      return;
    }
    book.forEach((e, n) => {
      this.reply(`${String(n + 1).padStart(2)}  ${e.host}:${e.port}${e.name ? `  ${e.name}` : ''}`);
    });
    this.reply('Dial with ATDT n or ATDT host:port');
  }

  private dial(arg: string): void {
    let target = arg.trim().replace(/^[TP]\s*/i, '').trim();
    const book = this.phoneBook();
    if (/^\d{1,3}$/.test(target) && Number(target) >= 1 && Number(target) <= book.length) {
      const e = book[Number(target) - 1];
      target = `${e.host}:${e.port}`;
    }
    const m = /^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(target);
    if (!m) { this.result('ERROR'); return; }
    const host = m[1].toLowerCase();
    const port = m[2] ? Number(m[2]) : 23;
    if (port < 1 || port > 65535) { this.result('ERROR'); return; }
    if (!this.dialer) { this.result('NO DIALTONE'); return; }

    this.link?.close();
    this.state = 'dialing';
    this.resetTelnet();
    let link: Link | undefined;
    const current = () => this.link === link;
    link = this.dialer(host, port, {
      onOpen: () => {
        if (!current() || this.state !== 'dialing') return;
        this.state = 'online';
        this.lastTx = this.now();
        this.result('CONNECT');
      },
      onData: (bytes) => {
        if (current() && this.state === 'online') this.receive(bytes);
      },
      onClose: () => {
        if (current()) this.hangup();
      },
    });
    this.link = link;
  }

  private abortDial(): void {
    this.hangup();
  }

  // ---- online ---------------------------------------------------------

  private sendData(b: number): void {
    const now = this.now();
    if (b === 0x2b) { // '+'
      if (this.plus === 0 ? now - this.lastTx >= GUARD_MS : now - this.plusAt < GUARD_MS) {
        this.plus = Math.min(this.plus + 1, 4);
      } else {
        this.plus = 0;
      }
      this.plusAt = now;
    } else {
      this.plus = 0;
    }
    this.lastTx = now;
    if (b === IAC) this.send([IAC, IAC]);
    else if (b === CR) this.send([CR, 0]); // NVT: a bare CR is CR NUL
    else this.send([b]);
  }

  private checkEscape(): void {
    if (this.state === 'online' && this.plus === 3 && this.now() - this.plusAt >= GUARD_MS) {
      this.plus = 0;
      this.state = 'command'; // the link stays up; ATO goes back online
      this.result('OK');
    }
  }

  private send(bytes: number[]): void {
    this.link?.send(Uint8Array.from(bytes));
  }

  private receive(bytes: Uint8Array): void {
    const out: number[] = [];
    for (const b of bytes) {
      switch (this.telnet) {
        case 'data':
          if (b === IAC) { this.telnet = 'iac'; break; }
          if (b === 0 && this.lastWasCr) { this.lastWasCr = false; break; }
          this.lastWasCr = b === CR;
          out.push(b);
          break;
        case 'iac':
          if (b === IAC) { out.push(IAC); this.telnet = 'data'; }
          else if (b >= WILL && b <= DONT) { this.verb = b; this.telnet = 'verb'; }
          else if (b === SB) { this.sub = []; this.telnet = 'sb'; }
          else this.telnet = 'data'; // NOP, GA, AYT and friends
          break;
        case 'verb':
          this.negotiate(this.verb, b);
          this.telnet = 'data';
          break;
        case 'sb':
          if (b === IAC) this.telnet = 'sb-iac';
          else if (this.sub.length < 64) this.sub.push(b);
          break;
        case 'sb-iac':
          if (b === SE) { this.subnegotiate(this.sub); this.telnet = 'data'; }
          else { if (b === IAC && this.sub.length < 64) this.sub.push(IAC); this.telnet = 'sb'; }
          break;
      }
    }
    this.push(out);
  }

  private negotiate(verb: number, opt: number): void {
    if (verb === WONT || verb === DONT) return;
    const key = verb * 256 + opt;
    if (this.answered.has(key)) return;
    this.answered.add(key);
    if (verb === WILL) {
      const ok = opt === OPT_ECHO || opt === OPT_SGA || opt === OPT_BINARY;
      this.send([IAC, ok ? DO : DONT, opt]);
      return;
    }
    // DO
    if (opt === OPT_TTYPE || opt === OPT_SGA) {
      this.send([IAC, WILL, opt]);
    } else if (opt === OPT_NAWS) {
      this.send([IAC, WILL, opt]);
      const [cols, rows] = this.windowSize();
      this.send([IAC, SB, OPT_NAWS, ...word(cols), ...word(rows), IAC, SE]);
    } else {
      this.send([IAC, WONT, opt]);
    }
  }

  private subnegotiate(sub: number[]): void {
    if (sub[0] === OPT_TTYPE && sub[1] === TTYPE_SEND) {
      const name = [...this.terminalType()].map((c) => c.charCodeAt(0) & 0x7f);
      this.send([IAC, SB, OPT_TTYPE, TTYPE_IS, ...name, IAC, SE]);
    }
  }

  private resetTelnet(): void {
    this.telnet = 'data';
    this.sub = [];
    this.lastWasCr = false;
    this.answered.clear();
    this.plus = 0;
  }

  // ---- receive buffer -------------------------------------------------

  private result(text: string): void {
    this.push([CR, LF, ...[...text].map((c) => c.charCodeAt(0)), CR, LF]);
  }

  private reply(text: string): void {
    this.push([...[...text].map((c) => c.charCodeAt(0)), CR, LF]);
  }

  private push(bytes: number[]): void {
    for (const b of bytes) {
      if (this.rxCount === RX_SIZE) break; // overflow: drop, like a real UART
      this.rx[(this.rxHead + this.rxCount) % RX_SIZE] = b;
      this.rxCount++;
    }
    if (bytes.length) this.wake();
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r();
  }
}

function word(n: number): number[] {
  const hi = (n >> 8) & 0xff, lo = n & 0xff;
  // A 255 inside a subnegotiation must be doubled.
  return [...(hi === IAC ? [IAC, IAC] : [hi]), ...(lo === IAC ? [IAC, IAC] : [lo])];
}
