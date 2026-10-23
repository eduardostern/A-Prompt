/**
 * A small ZMODEM sender (CRC-16), event-driven so it can live inside a
 * modem Link: feed it the receiver's bytes with receive(), call tick()
 * now and then for timeouts, and it writes through `send`. Used by the AI
 * board to deliver programs to ZMODEM.COM.
 */
export interface ZFile {
  name: string;
  data: Uint8Array;
}

const ZPAD = 0x2a, ZDLE = 0x18, ZBIN = 0x41, ZHEX = 0x42, XON = 0x11;
const ZRQINIT = 0, ZRINIT = 1, ZACK = 3, ZFILE = 4, ZSKIP = 5, ZFIN = 8, ZRPOS = 9;
const ZDATA = 10, ZEOF = 11, ZCHALLENGE = 14;
const ZCRCE = 0x68, ZCRCG = 0x69, ZCRCW = 0x6b;
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

type State = 'init' | 'file' | 'eof' | 'fin' | 'done';

export class ZmodemSender {
  private state: State = 'init';
  private index = 0;
  private rx: number[] = [];
  private tries = 0;
  private lastSent = 0;

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
      case 'eof': this.binHeader(ZEOF, posBytes(this.files[this.index].data.length)); break;
      case 'fin': this.header(ZFIN, [0, 0, 0, 0]); break;
    }
  }

  /** Stops with the ZMODEM abort sequence. */
  cancel(): void {
    if (this.state === 'done') return;
    this.write([...new Array(8).fill(0x18), ...new Array(8).fill(0x08)]);
    this.finish(false, 'cancelled');
  }

  private handle(type: number, data: number[]): void {
    const pos = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);
    if (type === ZCHALLENGE) { this.header(ZACK, data); return; }
    switch (this.state) {
      case 'init':
        if (type === ZRINIT) this.nextFile(0);
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
    this.binHeader(ZFILE, [0, 0, 0, 0]);
    this.subpacket(info, ZCRCW);
  }

  /** The whole file from `pos`, then ZEOF; a ZRPOS later restarts here. */
  private sendData(pos: number): void {
    const data = this.files[this.index].data;
    this.state = 'eof';
    this.tries = 0;
    if (pos > data.length) pos = data.length;
    if (pos < data.length) {
      this.binHeader(ZDATA, posBytes(pos));
      for (let p = pos; p < data.length; p += SUBPACKET) {
        const end = Math.min(p + SUBPACKET, data.length);
        this.subpacket(data.subarray(p, end), end === data.length ? ZCRCE : ZCRCG);
      }
    }
    this.binHeader(ZEOF, posBytes(data.length));
  }

  private header(type: number, data: number[]): void {
    const out = [ZPAD, ZPAD, ZDLE, ZHEX];
    const bytes = [type, ...data];
    for (const b of bytes) hexByte(out, b);
    const crc = crc16(bytes);
    hexByte(out, crc >> 8);
    hexByte(out, crc & 0xff);
    out.push(0x0d, 0x8a);
    if (type !== ZFIN && type !== ZACK) out.push(XON);
    this.write(out);
  }

  private binHeader(type: number, data: number[]): void {
    const out = [ZPAD, ZDLE, ZBIN];
    const bytes = [type, ...data];
    for (const b of bytes) zdle(out, b);
    const crc = crc16(bytes);
    zdle(out, crc >> 8);
    zdle(out, crc & 0xff);
    this.write(out);
  }

  private subpacket(data: ArrayLike<number>, end: number): void {
    const out: number[] = [];
    for (let i = 0; i < data.length; i++) zdle(out, data[i]);
    out.push(ZDLE, end);
    const crc = crc16([end], crc16(data));
    zdle(out, crc >> 8);
    zdle(out, crc & 0xff);
    if (end === ZCRCW) out.push(XON);
    this.write(out);
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
