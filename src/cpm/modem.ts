/**
 * A Hayes-style modem on a simple UART, wired to a telnet transport.
 *
 * The guest sees two I/O ports (see layout.ts): a status port and a data
 * port. In command mode the modem reads AT commands from the data port and
 * answers with result codes; ATDT opens a connection through the injected
 * dialer (in the browser a WebSocket, straight to the BBS or through the
 * Worker relay; a fake in tests). Online, bytes pass through with the telnet
 * protocol handled here, so the guest sees a clean 8-bit stream.
 */
import { PHONE_BOOK } from '../phonebook';

/** An open connection. */
export interface Link {
  send(bytes: Uint8Array): void;
  close(): void;
}

export interface LinkHandlers {
  /** The call is up; `info` is appended to CONNECT (e.g. "DIRECT"). */
  onOpen(info?: string): void;
  onData(bytes: Uint8Array): void;
  /** The connection ended or could not be made. */
  onClose(): void;
}

/** Where to call: a telnet host and port, and a WebSocket address if the BBS has one. */
export interface DialTarget {
  host: string;
  port: number;
  ws?: string;
}

export type Dialer = (target: DialTarget, handlers: LinkHandlers) => Link;

/** An entry in the modem's phone book (ATI lists it, ATDT1 dials entry 1). */
export interface PhoneEntry {
  host: string;
  port: number;
  name?: string;
  /** wss:// address the browser can dial without the relay. */
  ws?: string;
}

/** UART status bits. */
export const MODEM_RX_READY = 0x01;
export const MODEM_TX_READY = 0x02;
export const MODEM_CARRIER = 0x80;

const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;
const OPT_BINARY = 0, OPT_ECHO = 1, OPT_SGA = 3, OPT_TTYPE = 24, OPT_NAWS = 31;
const TTYPE_IS = 0, TTYPE_SEND = 1;

/** Options we let the BBS enable on its side, and the ones we perform. */
const HIM_OK = new Set([OPT_BINARY, OPT_ECHO, OPT_SGA]);
const US_OK = new Set([OPT_BINARY, OPT_SGA, OPT_TTYPE, OPT_NAWS]);

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
  /** Telnet options in force on each side, and requests we sent. */
  private him = new Set<number>();
  private us = new Set<number>();
  private askedHim = new Set<number>();
  private askedUs = new Set<number>();
  /** Options we refused, so a server that repeats itself gets no loop. */
  private refused = new Set<number>();
  private telnetSeen = false;

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

  /** True when both directions run in telnet BINARY mode (8-bit clean). */
  get binary(): boolean {
    return this.him.has(OPT_BINARY) && this.us.has(OPT_BINARY);
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
    else if (this.state === 'dialing') this.hangup();
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
      const raw = String.fromCharCode(...this.line).trim();
      this.line = [];
      if (raw.toUpperCase().startsWith('AT')) this.execute(raw.slice(2));
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
    if (ch < 32 || this.line.length >= 120) return;
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
          if (cmd[i] === '=') { i++; num(); } else if (cmd[i] === '?') { i++; this.reply('000'); }
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
      const direct = e.ws ? ' *' : '';
      this.reply(`${String(n + 1).padStart(2)}  ${e.host}:${e.port}${e.name ? `  ${e.name}` : ''}${direct}`);
    });
    if (book.some((e) => e.ws)) this.reply(' * connects straight from the browser');
    this.reply('Dial with ATDT n, ATDT host:port or ATDT wss://host:port');
  }

  /** Parses the dial string: a phone book number, host[:port] or a ws(s):// URL. */
  private target(arg: string): DialTarget | undefined {
    const text = arg.trim().replace(/^[TP]\s*/i, '').trim();
    const book = this.phoneBook();
    if (/^\d{1,3}$/.test(text)) {
      const e = book[Number(text) - 1];
      return e ? { host: e.host, port: e.port, ws: e.ws } : undefined;
    }
    if (/^wss?:\/\//i.test(text)) {
      try {
        const url = new URL(text);
        const port = Number(url.port) || (url.protocol === 'wss:' ? 443 : 80);
        return { host: url.hostname.toLowerCase(), port, ws: url.href };
      } catch {
        return undefined;
      }
    }
    const m = /^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(text);
    if (!m) return undefined;
    const host = m[1].toLowerCase();
    const port = m[2] ? Number(m[2]) : 23;
    if (port < 1 || port > 65535) return undefined;
    const e = book.find((b) => b.host === host && b.port === port);
    return { host, port, ws: e?.ws };
  }

  private dial(arg: string): void {
    const target = this.target(arg);
    if (!target) { this.result('ERROR'); return; }
    if (!this.dialer) { this.result('NO DIALTONE'); return; }

    this.link?.close();
    this.state = 'dialing';
    this.resetTelnet();
    let link: Link | undefined;
    const current = () => this.link === link;
    link = this.dialer(target, {
      onOpen: (info) => {
        if (!current() || this.state !== 'dialing') return;
        this.state = 'online';
        this.lastTx = this.now();
        this.result(info ? `CONNECT ${info}` : 'CONNECT');
      },
      onData: (bytes) => {
        if (current() && this.state !== 'dialing') this.receive(bytes);
      },
      onClose: () => {
        if (current()) this.hangup();
      },
    });
    this.link = link;
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
    if (b === IAC && this.telnetSeen) this.send([IAC, IAC]);
    else if (b === CR && this.telnetSeen && !this.us.has(OPT_BINARY)) this.send([CR, 0]); // NVT
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
          if (b === 0 && this.lastWasCr && !this.him.has(OPT_BINARY)) { this.lastWasCr = false; break; }
          this.lastWasCr = b === CR;
          out.push(b);
          break;
        case 'iac':
          if (b === IAC) { out.push(IAC); this.telnet = 'data'; break; }
          this.startTelnet();
          if (b >= WILL && b <= DONT) { this.verb = b; this.telnet = 'verb'; }
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
    // While escaped to command mode the line stays up but its data is dropped.
    if (this.state === 'online') this.push(out);
  }

  /** The peer speaks telnet: ask for BINARY both ways so transfers are 8-bit clean. */
  private startTelnet(): void {
    if (this.telnetSeen) return;
    this.telnetSeen = true;
    this.askedUs.add(OPT_BINARY);
    this.askedHim.add(OPT_BINARY);
    this.send([IAC, WILL, OPT_BINARY, IAC, DO, OPT_BINARY]);
  }

  private negotiate(verb: number, opt: number): void {
    switch (verb) {
      case WILL:
        if (!HIM_OK.has(opt)) { this.refuse(DONT, opt); break; }
        if (!this.him.has(opt)) {
          this.him.add(opt);
          if (!this.askedHim.delete(opt)) this.send([IAC, DO, opt]);
        }
        break;
      case WONT:
        this.askedHim.delete(opt);
        if (this.him.delete(opt)) this.send([IAC, DONT, opt]);
        break;
      case DO:
        if (!US_OK.has(opt)) { this.refuse(WONT, opt); break; }
        if (!this.us.has(opt)) {
          this.us.add(opt);
          if (!this.askedUs.delete(opt)) this.send([IAC, WILL, opt]);
          if (opt === OPT_NAWS) {
            const [cols, rows] = this.windowSize();
            this.send([IAC, SB, OPT_NAWS, ...word(cols), ...word(rows), IAC, SE]);
          }
        }
        break;
      case DONT:
        this.askedUs.delete(opt);
        if (this.us.delete(opt)) this.send([IAC, WONT, opt]);
        break;
    }
  }

  private refuse(answer: number, opt: number): void {
    const key = answer * 256 + opt;
    if (this.refused.has(key)) return;
    this.refused.add(key);
    this.send([IAC, answer, opt]);
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
    this.him.clear();
    this.us.clear();
    this.askedHim.clear();
    this.askedUs.clear();
    this.refused.clear();
    this.telnetSeen = false;
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
