/**
 * A small ZMODEM sender and receiver, event-driven so they can live inside
 * a modem Link: feed them the other end's bytes with receive(), call tick()
 * now and then for timeouts, and they write through `send`. The AI board
 * delivers programs to ZMODEM.COM with the sender and takes uploads from
 * ZMODEM S with the receiver. CRC-16 always; CRC-32 when the other end
 * offers it (ZMODEM.COM does not, lrzsz does).
 */
export interface ZFile {
  name: string;
  data: Uint8Array;
}

const ZPAD = 0x2a, ZDLE = 0x18, ZBIN = 0x41, ZHEX = 0x42, ZBIN32 = 0x43, XON = 0x11;
const ZRQINIT = 0, ZRINIT = 1, ZSINIT = 2, ZACK = 3, ZFILE = 4, ZSKIP = 5, ZNAK = 6;
const ZFIN = 8, ZRPOS = 9, ZDATA = 10, ZEOF = 11, ZCHALLENGE = 14;
const ZCRCE = 0x68, ZCRCG = 0x69, ZCRCQ = 0x6a, ZCRCW = 0x6b, ZRUB0 = 0x6c, ZRUB1 = 0x6d;
/** ZRINIT ZF0 flags: full duplex, overlapped I/O, CRC-32. */
const CANFDX = 0x01, CANOVIO = 0x02, CANFC32 = 0x20;
const SUBPACKET = 1024;
const RETRY_MS = 10_000;
const MAX_TRIES = 10;

const TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let b = 0; b < 8; b++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
    t[i] = c;
  }
  return t;
})();

export function crc16(bytes: ArrayLike<number>, crc = 0): number {
  for (let i = 0; i < bytes.length; i++) crc = ((crc << 8) & 0xffff) ^ TABLE[((crc >> 8) ^ bytes[i]) & 0xff];
  return crc;
}

const TABLE32 = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let b = 0; b < 8; b++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE, as ZMODEM uses it): pass the previous result to continue. */
export function crc32(bytes: ArrayLike<number>, crc = 0): number {
  crc = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ TABLE32[(crc ^ bytes[i]) & 0xff];
  return ~crc >>> 0;
}

const ESCAPE = new Set([0x18, 0x10, 0x11, 0x13, 0x90, 0x91, 0x93, 0x0d, 0x8d]);

function zdle(out: number[], b: number): void {
  if (ESCAPE.has(b)) out.push(ZDLE, b ^ 0x40);
  else out.push(b);
}

const HEX = '0123456789abcdef';
function hexByte(out: number[], b: number): void {
  out.push(HEX.charCodeAt(b >> 4), HEX.charCodeAt(b & 15));
}

function posBytes(pos: number): number[] {
  return [pos & 0xff, (pos >>> 8) & 0xff, (pos >>> 16) & 0xff, (pos >>> 24) & 0xff];
}

function crcBytes(bytes: ArrayLike<number>, wide: boolean): number[] {
  if (wide) {
    const c = crc32(bytes);
    return [c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff, c >>> 24];
  }
  const c = crc16(bytes);
  return [c >> 8, c & 0xff];
}

function hexHeader(type: number, data: number[]): number[] {
  const out = [ZPAD, ZPAD, ZDLE, ZHEX];
  const bytes = [type, ...data];
  for (const b of bytes) hexByte(out, b);
  for (const b of crcBytes(bytes, false)) hexByte(out, b);
  out.push(0x0d, 0x8a);
  if (type !== ZFIN && type !== ZACK) out.push(XON);
  return out;
}

function binHeader(type: number, data: number[], wide: boolean): number[] {
  const out = [ZPAD, ZDLE, wide ? ZBIN32 : ZBIN];
  const bytes = [type, ...data];
  for (const b of bytes) zdle(out, b);
  for (const b of crcBytes(bytes, wide)) zdle(out, b);
  return out;
}

function subpacket(data: ArrayLike<number>, end: number, wide: boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < data.length; i++) zdle(out, data[i]);
  out.push(ZDLE, end);
  const all = new Uint8Array(data.length + 1);
  all.set(Array.from(data));
  all[data.length] = end;
  for (const b of crcBytes(all, wide)) zdle(out, b);
  if (end === ZCRCW) out.push(XON);
  return out;
}

/** The ZMODEM abort sequence: eight CANs, eight backspaces. */
const ABORT = [...new Array(8).fill(0x18), ...new Array(8).fill(0x08)];

type State = 'init' | 'file' | 'eof' | 'fin' | 'done';

export class ZmodemSender {
  private state: State = 'init';
  private index = 0;
  private rx: number[] = [];
  private tries = 0;
  private lastSent = 0;
  /** The receiver offered CRC-32. */
  private wide = false;

  constructor(
    private files: ZFile[],
    private send: (bytes: Uint8Array) => void,
    private onDone: (ok: boolean, why?: string) => void,
    private now: () => number = () => Date.now(),
  ) {}

  get finished(): boolean {
    return this.state === 'done';
  }

  start(): void {
    this.write([...'rz\r'].map((c) => c.charCodeAt(0)));
    this.header(ZRQINIT, [0, 0, 0, 0]);
  }

  /** Bytes from the receiver. */
  receive(bytes: ArrayLike<number>): void {
    if (this.state === 'done') return;
    for (let i = 0; i < bytes.length; i++) this.rx.push(bytes[i]);
    for (;;) {
      const h = this.parse();
      if (!h) break;
      this.handle(h.type, h.data);
      if (this.finished) return;
    }
    if (this.rx.length > 4096) this.rx.splice(0, this.rx.length - 64);
  }

  /** Resends after silence; gives up after ten tries. */
  tick(): void {
    if (this.state === 'done' || this.now() - this.lastSent < RETRY_MS) return;
    if (++this.tries > MAX_TRIES) { this.finish(false, 'no answer from the receiver'); return; }
    switch (this.state) {
      case 'init': this.header(ZRQINIT, [0, 0, 0, 0]); break;
      case 'file': this.sendFileInfo(); break;
      case 'eof': this.write(binHeader(ZEOF, posBytes(this.files[this.index].data.length), this.wide)); break;
      case 'fin': this.header(ZFIN, [0, 0, 0, 0]); break;
    }
  }

  /** Stops with the ZMODEM abort sequence. */
  cancel(): void {
    if (this.state === 'done') return;
    this.write(ABORT);
    this.finish(false, 'cancelled');
  }

  private handle(type: number, data: number[]): void {
    const pos = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);
    if (type === ZCHALLENGE) { this.header(ZACK, data); return; }
    switch (this.state) {
      case 'init':
        if (type === ZRINIT) {
          this.wide = (data[3] & CANFC32) !== 0;
          this.nextFile(0);
        }
        break;
      case 'file':
        if (type === ZRPOS) this.sendData(pos >>> 0);
        else if (type === ZSKIP) this.nextFile(this.index + 1);
        break;
      case 'eof':
        if (type === ZRINIT) this.nextFile(this.index + 1);
        else if (type === ZRPOS) this.sendData(pos >>> 0);
        break;
      case 'fin':
        if (type === ZFIN) {
          this.write([0x4f, 0x4f]); // "OO"
          this.finish(true);
        }
        break;
    }
  }

  private nextFile(index: number): void {
    this.index = index;
    this.tries = 0;
    if (index >= this.files.length) {
      this.state = 'fin';
      this.header(ZFIN, [0, 0, 0, 0]);
      return;
    }
    this.state = 'file';
    this.sendFileInfo();
  }

  private sendFileInfo(): void {
    const f = this.files[this.index];
    const info = [...`${f.name}\0${f.data.length}\0`].map((c) => c.charCodeAt(0) & 0xff);
    this.write([...binHeader(ZFILE, [0, 0, 0, 0], this.wide), ...subpacket(info, ZCRCW, this.wide)]);
  }

  /** The whole file from `pos`, then ZEOF; a ZRPOS later restarts here. */
  private sendData(pos: number): void {
    const data = this.files[this.index].data;
    this.state = 'eof';
    this.tries = 0;
    if (pos > data.length) pos = data.length;
    if (pos < data.length) {
      this.write(binHeader(ZDATA, posBytes(pos), this.wide));
      for (let p = pos; p < data.length; p += SUBPACKET) {
        const end = Math.min(p + SUBPACKET, data.length);
        this.write(subpacket(data.subarray(p, end), end === data.length ? ZCRCE : ZCRCG, this.wide));
      }
    }
    this.write(binHeader(ZEOF, posBytes(data.length), this.wide));
  }

  private header(type: number, data: number[]): void {
    this.write(hexHeader(type, data));
  }

  private write(bytes: number[]): void {
    this.lastSent = this.now();
    this.send(Uint8Array.from(bytes));
  }

  private finish(ok: boolean, why?: string): void {
    this.state = 'done';
    this.onDone(ok, why);
  }

  /**
   * Takes one header off the front of the receive buffer, dropping noise
   * before it. Hex headers (what receivers send) and CRC-16 binary ones.
   */
  private parse(): { type: number; data: number[] } | undefined {
    const rx = this.rx;
    for (;;) {
      const start = rx.indexOf(ZPAD);
      if (start < 0) { rx.length = 0; return undefined; }
      if (start > 0) rx.splice(0, start);
      let i = 0;
      while (i < rx.length && rx[i] === ZPAD) i++;
      if (i + 2 > rx.length) return undefined;
      if (rx[i] !== ZDLE) { rx.splice(0, i); continue; }
      const kind = rx[i + 1];
      if (kind === ZHEX) {
        const need = i + 2 + 14;
        if (rx.length < need) return undefined;
        const text = String.fromCharCode(...rx.slice(i + 2, need));
        rx.splice(0, need);
        if (!/^[0-9a-fA-F]{14}$/.test(text)) continue;
        const bytes = text.match(/../g)!.map((h) => parseInt(h, 16));
        if (crc16(bytes.slice(0, 5)) !== ((bytes[5] << 8) | bytes[6])) continue;
        return { type: bytes[0], data: bytes.slice(1, 5) };
      }
      if (kind === ZBIN) {
        const bytes: number[] = [];
        let j = i + 2;
        while (bytes.length < 7 && j < rx.length) {
          let b = rx[j++];
          if (b === ZDLE) {
            if (j >= rx.length) return undefined;
            b = rx[j++] ^ 0x40;
          }
          bytes.push(b);
        }
        if (bytes.length < 7) return undefined;
        rx.splice(0, j);
        if (crc16(bytes.slice(0, 5)) !== ((bytes[5] << 8) | bytes[6])) continue;
        return { type: bytes[0], data: bytes.slice(1, 5) };
      }
      rx.splice(0, i + 1);
    }
  }
}

export interface ZmodemReceiverOptions {
  /** Larger files are skipped (ZSKIP), or cancelled if they grow past it. */
  maxBytes?: number;
  /** Files after this many are skipped. */
  maxFiles?: number;
  /** Offer CRC-32 in ZRINIT (default true). */
  crc32?: boolean;
  /** How long to wait for the sender to begin (default three minutes). */
  startTimeoutMs?: number;
  now?: () => number;
}

type RxPhase = 'wait' | 'file' | 'info' | 'sinit' | 'pos' | 'data' | 'fin' | 'done';

const isFlow = (b: number) => b === XON || b === 0x13 || b === 0x91 || b === 0x93;
const unescape = (b: number) => (b === ZRUB0 ? 0x7f : b === ZRUB1 ? 0xff : b ^ 0x40);

/**
 * A ZMODEM receiver. start() sends ZRINIT (TERM sees it and tells the
 * caller to run ZMODEM S); then ZFILE, ZDATA subpackets and ZEOF per file,
 * and ZFIN. A bad subpacket or header asks for the data again with ZRPOS
 * from the last good byte. onDone gets the files that arrived whole.
 */
export class ZmodemReceiver {
  private phase: RxPhase = 'wait';
  private files: ZFile[] = [];
  private current?: { name: string; data: number[] };
  private offset = 0;
  private skipped = '';
  private tries = 0;
  private timer = 0;
  private startedAt = 0;
  private cans = 0;
  private os = 0;
  // header decoding
  private hst = 0;
  private hkind = 0;
  private hbuf: number[] = [];
  private hesc = false;
  // subpacket decoding
  private inSub = false;
  private subWide = false;
  private sub: number[] = [];
  private subEsc = false;
  private subEnd = -1;
  private subCrc: number[] = [];

  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly offerWide: boolean;
  private readonly startTimeout: number;
  private readonly now: () => number;

  constructor(
    private send: (bytes: Uint8Array) => void,
    private onDone: (ok: boolean, files: ZFile[], why?: string) => void,
    opts: ZmodemReceiverOptions = {},
  ) {
    this.maxBytes = opts.maxBytes ?? 1 << 20;
    this.maxFiles = opts.maxFiles ?? Infinity;
    this.offerWide = opts.crc32 ?? true;
    this.startTimeout = opts.startTimeoutMs ?? 180_000;
    this.now = opts.now ?? (() => Date.now());
  }

  get finished(): boolean {
    return this.phase === 'done';
  }

  /** The sender has spoken: a valid header came in. */
  get started(): boolean {
    return this.phase !== 'wait' && this.phase !== 'done';
  }

  start(): void {
    this.startedAt = this.now();
    this.zrinit();
  }

  /** Bytes from the sender. */
  receive(bytes: ArrayLike<number>): void {
    for (let i = 0; i < bytes.length && this.phase !== 'done'; i++) {
      const b = bytes[i];
      if (b === 0x18) {
        if (++this.cans >= 5) { this.finish(false, 'cancelled by the sender'); return; }
      } else this.cans = 0;
      if (this.phase === 'fin' && !this.inSub && this.hst === 0 && b === 0x4f) { // "OO"
        if (++this.os >= 2) this.finish(true);
        continue;
      }
      if (this.inSub) this.subByte(b);
      else this.headerByte(b);
    }
  }

  /** Timeouts: ZRPOS or ZRINIT again after ten seconds of silence. */
  tick(): void {
    if (this.phase === 'done') return;
    const now = this.now();
    if (this.phase === 'wait') {
      if (now - this.startedAt >= this.startTimeout) this.finish(false, 'no upload started');
      return;
    }
    if (this.phase === 'fin') {
      if (now - this.timer >= 2000) this.finish(true); // no "OO": fine
      return;
    }
    if (now - this.timer < RETRY_MS) return;
    if (++this.tries > MAX_TRIES) { this.abort('no data from the sender'); return; }
    if (this.current) this.zrpos();
    else this.zrinit();
  }

  /** Stops; sends the abort sequence unless `quiet`. */
  cancel(quiet = false): void {
    if (this.phase === 'done') return;
    if (!quiet) this.write(ABORT);
    this.finish(false, 'cancelled');
  }

  // ---- decoding ------------------------------------------------------

  private headerByte(b: number): void {
    switch (this.hst) {
      case 0: if (b === ZPAD) this.hst = 1; return;
      case 1:
        if (b === ZDLE) this.hst = 2;
        else if (b !== ZPAD) this.hst = 0;
        return;
      case 2:
        if (b === ZHEX || b === ZBIN || b === ZBIN32) {
          this.hkind = b;
          this.hbuf = [];
          this.hesc = false;
          this.hst = 3;
        } else this.hst = b === ZPAD ? 1 : 0;
        return;
    }
    if (this.hkind === ZHEX) {
      const d = parseInt(String.fromCharCode(b), 16);
      if (Number.isNaN(d)) { this.hst = b === ZPAD ? 1 : 0; return; }
      this.hbuf.push(d);
      if (this.hbuf.length < 14) return;
      const bytes: number[] = [];
      for (let i = 0; i < 14; i += 2) bytes.push((this.hbuf[i] << 4) | this.hbuf[i + 1]);
      this.hst = 0;
      this.checkHeader(bytes, false);
      return;
    }
    if (this.hesc) { this.hesc = false; b = unescape(b); }
    else if (b === ZDLE) { this.hesc = true; return; }
    else if (isFlow(b)) return;
    this.hbuf.push(b);
    const wide = this.hkind === ZBIN32;
    if (this.hbuf.length < (wide ? 9 : 7)) return;
    this.hst = 0;
    this.checkHeader(this.hbuf, wide);
  }

  private checkHeader(bytes: number[], wide: boolean): void {
    const body = bytes.slice(0, 5);
    if (crcBytes(body, wide).some((c, i) => c !== bytes[5 + i])) { this.garbled(); return; }
    this.header(body[0], body.slice(1), wide);
  }

  private subByte(b: number): void {
    if (this.subEnd < 0) {
      if (this.subEsc) {
        this.subEsc = false;
        if (b >= ZCRCE && b <= ZCRCW) { this.subEnd = b; return; }
        b = unescape(b);
      } else if (b === ZDLE) { this.subEsc = true; return; }
      else if (isFlow(b)) return;
      this.sub.push(b);
      if (this.sub.length > 8192) this.garbled(); // no end in sight
      return;
    }
    if (this.subEsc) { this.subEsc = false; b = unescape(b); }
    else if (b === ZDLE) { this.subEsc = true; return; }
    else if (isFlow(b)) return;
    this.subCrc.push(b);
    if (this.subCrc.length < (this.subWide ? 4 : 2)) return;
    const data = this.sub, end = this.subEnd, got = this.subCrc;
    const ok = crcBytes([...data, end], this.subWide).every((c, i) => c === got[i]);
    this.expectSub(this.subWide);
    if (ok) this.subpacket(data, end);
    else this.garbled();
  }

  private expectSub(wide: boolean): void {
    this.inSub = true;
    this.subWide = wide;
    this.sub = [];
    this.subEsc = false;
    this.subEnd = -1;
    this.subCrc = [];
  }

  private expectHeader(): void {
    this.inSub = false;
    this.hst = 0;
  }

  /** A bad CRC or a runaway subpacket: ask again from the last good byte. */
  private garbled(): void {
    this.expectHeader();
    if (this.phase === 'data' || this.phase === 'pos') {
      this.phase = 'pos';
      this.zrpos();
    } else if (this.phase === 'info') {
      this.phase = 'file';
      this.hexHeader(ZNAK, [0, 0, 0, 0]);
    }
  }

  // ---- protocol ------------------------------------------------------

  private header(type: number, data: number[], wide: boolean): void {
    const pos = (data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24)) >>> 0;
    this.timer = this.now();
    switch (type) {
      case ZRQINIT:
        if (this.phase === 'wait' || this.phase === 'file') { this.phase = 'file'; this.zrinit(); }
        return;
      case ZSINIT:
        if (this.phase === 'fin') return;
        this.phase = 'sinit';
        this.expectSub(wide);
        return;
      case ZFILE:
        if (this.phase === 'fin') return;
        this.current = undefined;
        this.phase = 'info';
        this.expectSub(wide);
        return;
      case ZDATA:
        if (!this.current || (this.phase !== 'pos' && this.phase !== 'data')) return;
        if (pos !== this.offset) { this.phase = 'pos'; this.zrpos(); return; }
        this.phase = 'data';
        this.expectSub(wide);
        return;
      case ZEOF:
        if (!this.current) return;
        // A ZEOF from before our ZRPOS is stale; the timeout covers a lost one.
        if (pos !== this.offset) return;
        this.files.push({ name: this.current.name, data: Uint8Array.from(this.current.data) });
        this.current = undefined;
        this.tries = 0;
        this.phase = 'file';
        this.zrinit();
        return;
      case ZFIN:
        this.phase = 'fin';
        this.current = undefined;
        this.os = 0;
        this.hexHeader(ZFIN, [0, 0, 0, 0]);
        return;
    }
  }

  private subpacket(data: number[], end: number): void {
    this.timer = this.now();
    this.tries = 0;
    if (this.phase === 'sinit') {
      this.expectHeader();
      this.phase = 'file';
      this.hexHeader(ZACK, [0, 0, 0, 0]);
      return;
    }
    if (this.phase === 'info') {
      this.expectHeader();
      const [path, rest = ''] = String.fromCharCode(...data).split('\0');
      const name = path.slice(path.lastIndexOf('/') + 1);
      const size = parseInt(rest, 10);
      this.phase = 'file';
      if (this.files.length >= this.maxFiles) { this.skip(`only ${this.maxFiles} file${this.maxFiles === 1 ? '' : 's'} at a time`); return; }
      if (size > this.maxBytes) { this.skip(`${name} is over ${this.maxBytes >> 10} KB`); return; }
      if (!name) { this.skip('a file with no name'); return; }
      this.current = { name, data: [] };
      this.offset = 0;
      this.phase = 'pos';
      this.zrpos();
      return;
    }
    if (this.phase !== 'data' || !this.current) { this.expectHeader(); return; }
    for (const b of data) this.current.data.push(b);
    this.offset += data.length;
    if (this.offset > this.maxBytes) { this.abort(`${this.current.name} is over ${this.maxBytes >> 10} KB`); return; }
    if (end === ZCRCQ || end === ZCRCW) this.hexHeader(ZACK, posBytes(this.offset));
    if (end === ZCRCW || end === ZCRCE) { this.expectHeader(); this.phase = 'pos'; }
  }

  private skip(why: string): void {
    this.skipped = why;
    this.hexHeader(ZSKIP, [0, 0, 0, 0]);
  }

  private zrinit(): void {
    this.hexHeader(ZRINIT, [0, 0, 0, CANFDX | CANOVIO | (this.offerWide ? CANFC32 : 0)]);
  }

  private zrpos(): void {
    this.expectHeader();
    this.hexHeader(ZRPOS, posBytes(this.offset));
  }

  private hexHeader(type: number, data: number[]): void {
    this.write(hexHeader(type, data));
  }

  private write(bytes: number[]): void {
    this.timer = this.now();
    this.send(Uint8Array.from(bytes));
  }

  private abort(why: string): void {
    this.write(ABORT);
    this.finish(false, why);
  }

  private finish(ok: boolean, why?: string): void {
    if (this.phase === 'done') return;
    this.phase = 'done';
    this.onDone(ok, this.files, why ?? (this.files.length ? undefined : this.skipped || undefined));
  }
}
