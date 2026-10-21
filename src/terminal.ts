import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { ConsoleIO } from './console';
import { TerminalTranslator, TerminalType } from './terminal-translator';

/** CP437 (the character set CP/M software was written for) to Unicode. */
const CP437 =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»' +
  '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
  'αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0';

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

  write(text: string): void {
    this.term.write(text);
    if (text.length) this.lastByte = text.charCodeAt(text.length - 1);
  }

  writeByte(code: number): void {
    code &= 0xff;
    this.lastByte = code;
    if (this.translator.type !== 'ansi') {
      const out = this.translator.feed(code);
      if (typeof out === 'number') this.writeRawByte(out);
      else if (out) this.term.write(out);
      for (const b of this.translator.takeResponse()) this.push(b);
      return;
    }
    this.writeRawByte(code);
  }

  private writeRawByte(code: number): void {
    switch (code) {
      case 0x0d: this.term.write('\r'); break;
      case 0x0a: this.term.write('\n'); break;
      case 0x08: this.term.write('\b'); break;
      case 0x09: this.term.write('\t'); break;
      case 0x07: this.term.write('\x07'); break;
      case 0x0c: this.term.write('\x1b[2J\x1b[H'); break;
      default:
        if (code >= 0x20 && code < 0x7f) this.term.write(String.fromCharCode(code));
        else if (code >= 0x80) this.term.write(CP437[code - 0x80] ?? '?');
        else this.term.write(String.fromCharCode(code));
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
