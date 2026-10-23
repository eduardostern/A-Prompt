import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { ConsoleIO } from './console';
import { TerminalTranslator, TerminalType } from './terminal-translator';
import { ringBell } from './bell';
import { CP437 } from './cp437';


/** Characters the line may queue before the program has to wait (a UART's buffer, roughly). */
const LINE_FIFO = 16;

export class XtermConsole implements ConsoleIO {
  readonly term: Terminal;
  private fitAddon: FitAddon;
  private queue: number[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;
  private translator = new TerminalTranslator('ansi');
  lastByte = 10;

  onActivity?: () => void;

  constructor(container: HTMLElement) {
    this.term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      cursorStyle: 'underline',
      fontFamily: "'JetBrains Mono', 'IBM Plex Mono', Menlo, Consolas, monospace",
      fontSize: 15,
      lineHeight: 1.25,
      letterSpacing: 0,
      scrollback: 2000,
      allowTransparency: true,
      theme: {
        background: '#08110b',
        foreground: '#c9f5d5',
        cursor: '#63e698',
        cursorAccent: '#08110b',
        selectionBackground: '#1e5c3a',
        black: '#08110b',
        red: '#ff7b72',
        green: '#63e698',
        yellow: '#e3d27c',
        blue: '#79b8ff',
        magenta: '#d2a8ff',
        cyan: '#7ee7d0',
        white: '#d7e4db',
        brightBlack: '#5f7a69',
        brightRed: '#ff9f97',
        brightGreen: '#8dffb8',
        brightYellow: '#f3e6a5',
        brightBlue: '#a8d1ff',
        brightMagenta: '#e3c8ff',
        brightCyan: '#a9f5e6',
        brightWhite: '#f2fff7',
      },
    });
    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.open(container);
    this.fit();

    this.term.onData((data) => {
      for (const ch of data) {
        const code = ch.codePointAt(0) ?? 0;
        if (ch === '\r') this.push(13);
        else if (ch === '\n') this.push(10);
        else if (ch === '\x7f') this.push(8);
        else if (code <= 0xff) this.push(code);
      }
    });

    this.term.onBell(() => ringBell());
    this.term.onResize(() => this.onActivity?.());
    container.addEventListener('mouseup', () => this.term.focus());
  }

  fit(): void {
    try {
      this.fitAddon.fit();
    } catch {
      /* container not laid out yet */
    }
  }

  /** Columns and rows that would fit now, with the current font. */
  proposeDimensions(): { cols: number; rows: number } | undefined {
    try {
      return this.fitAddon.proposeDimensions();
    } catch {
      return undefined;
    }
  }

  get columns(): number {
    return this.term.cols;
  }

  get terminalType(): TerminalType {
    return this.translator.type;
  }

  setTerminalType(type: TerminalType): void {
    this.translator.setType(type);
  }

  focus(): void {
    this.term.focus();
  }

  private push(code: number): void {
    this.queue.push(code);
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w();
    }
    this.onActivity?.();
  }

  /**
   * Output speed of the serial line in baud (0: no limit). Characters then
   * reach the screen at baud/10 a second, and the machine waits while more
   * than a few are queued, as a computer waits on its UART.
   */
  get baud(): number {
    return this.lineBaud;
  }

  set baud(value: number) {
    this.lineBaud = value;
    this.drain();
  }

  private lineBaud = 0;
  private pending = '';
  private drainTimer: ReturnType<typeof setTimeout> | undefined;
  private lastDrain = 0;

  /** Milliseconds the program should wait before sending more output. */
  outputDelay(): number {
    const backlog = this.pending.length - LINE_FIFO;
    return this.lineBaud && backlog > 0 ? (backlog * 10_000) / this.lineBaud : 0;
  }

  private out(text: string): void {
    if (!this.lineBaud && !this.pending) {
      this.term.write(text);
      return;
    }
    this.pending += text;
    if (this.drainTimer === undefined) {
      this.lastDrain = performance.now();
      this.drainTimer = setTimeout(() => this.drain(), 0);
    }
  }

  /** Sends what the line has carried since the last call. */
  private drain(): void {
    clearTimeout(this.drainTimer);
    this.drainTimer = undefined;
    if (!this.pending) return;
    if (!this.lineBaud) {
      this.term.write(this.pending);
      this.pending = '';
      return;
    }
    const now = performance.now();
    const n = Math.floor(((now - this.lastDrain) * this.lineBaud) / 10_000);
    if (n > 0) {
      this.term.write(this.pending.slice(0, n));
      this.pending = this.pending.slice(n);
      this.lastDrain += (n * 10_000) / this.lineBaud;
    }
    if (this.pending) this.drainTimer = setTimeout(() => this.drain(), 15);
  }

  write(text: string): void {
    this.out(text);
    if (text.length) this.lastByte = text.charCodeAt(text.length - 1);
  }

  writeByte(code: number): void {
    code &= 0xff;
    this.lastByte = code;
    if (this.translator.type !== 'ansi') {
      const out = this.translator.feed(code);
      if (typeof out === 'number') this.writeRawByte(out);
      else if (out) this.out(out);
      for (const b of this.translator.takeResponse()) this.push(b);
      return;
    }
    this.writeRawByte(code);
  }

  private writeRawByte(code: number): void {
    switch (code) {
      case 0x0d: this.out('\r'); break;
      case 0x0a: this.out('\n'); break;
      case 0x08: this.out('\b'); break;
      case 0x09: this.out('\t'); break;
      case 0x07: this.out('\x07'); break;
      case 0x0c: this.out('\x1b[2J\x1b[H'); break;
      default:
        if (code >= 0x20 && code < 0x7f) this.out(String.fromCharCode(code));
        else if (code >= 0x80) this.out(CP437[code - 0x80] ?? '?');
        else this.out(String.fromCharCode(code));
        break;
    }
  }

  async readByte(): Promise<number> {
    if (this.queue.length) return this.queue.shift()!;
    if (this.closed) return 0x1a;
    await new Promise<void>((resolve) => { this.waiter = resolve; });
    return this.queue.shift() ?? 0x1a;
  }

  pollByte(): number | undefined {
    return this.queue.shift();
  }

  hasInput(): boolean {
    return this.queue.length > 0;
  }

  peekByte(): number | undefined {
    return this.queue[0];
  }

  clear(): void {
    this.term.clear();
  }

  /** Feeds text to the guest as if typed on the keyboard. */
  send(text: string): void {
    for (const ch of text) {
      if (ch === '\r') this.push(13);
      else if (ch === '\n') this.push(10);
      else {
        const code = ch.codePointAt(0) ?? 0;
        if (code <= 0xff) this.push(code);
      }
    }
    this.term.focus();
  }

  close(): void {
    this.closed = true;
    this.waiter?.();
  }
}
