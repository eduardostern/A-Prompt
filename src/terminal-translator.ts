export type TerminalType = 'ansi' | 'adm3a' | 'vt52';

/**
 * Translates the escape sequences used by common CP/M terminals into ANSI,
 * which xterm.js understands.  Normal bytes are returned unchanged (as a
 * number) so the caller can apply its CP437 mapping.
 */
export class TerminalTranslator {
  private state: 'normal' | 'esc' | 'row' | 'col' = 'normal';
  private row = 0;
  private response: number[] = [];

  constructor(public type: TerminalType = 'ansi') {}

  setType(type: TerminalType): void {
    this.type = type;
    this.state = 'normal';
    this.response = [];
  }

  /** Returns an ANSI string, a passthrough byte, or '' when consumed. */
  feed(byte: number): number | string {
    if (this.type === 'ansi') return byte;

    if (this.state === 'normal') {
      if (byte === 0x1b) {
        this.state = 'esc';
        return '';
      }
      return byte;
    }

    if (this.state === 'row') {
      this.row = Math.max(0, Math.min(23, byte - 0x20));
      this.state = 'col';
      return '';
    }

    if (this.state === 'col') {
      this.state = 'normal';
      const col = Math.max(0, Math.min(79, byte - 0x20));
      return `\x1b[${this.row + 1};${col + 1}H`;
    }

    this.state = 'normal';
    if (this.type === 'adm3a') return this.adm3a(byte);
    return this.vt52(byte);
  }

  private adm3a(byte: number): number | string {
    switch (byte) {
      case 0x3d: // ESC =  cursor address
        this.state = 'row';
        return '';
      case 0x2a: // ESC *  clear screen + home
        return '\x1b[2J\x1b[H';
      case 0x2b: // ESC +  cursor home
        return '\x1b[H';
      case 0x59: // ESC Y  clear to end of screen
        return '\x1b[J';
      case 0x54: // ESC T  clear to end of line
        return '\x1b[K';
      default:
        return '';
    }
  }

  private vt52(byte: number): number | string {
    switch (byte) {
      case 0x41: return '\x1b[A'; // up
      case 0x42: return '\x1b[B'; // down
      case 0x43: return '\x1b[C'; // right
      case 0x44: return '\x1b[D'; // left
      case 0x48: return '\x1b[H'; // home
      case 0x49: return '\x1bM'; // reverse line feed
      case 0x4a: return '\x1b[J'; // erase to end of screen
      case 0x4b: return '\x1b[K'; // erase to end of line
      case 0x4c: return '\x1b[L'; // insert line
      case 0x4d: return '\x1b[M'; // delete line
      case 0x59: // ESC Y  cursor address
        this.state = 'row';
        return '';
      case 0x5a: // ESC Z  identify -> terminal replies ESC / Z
        this.response.push(0x1b, 0x2f, 0x5a);
        return '';
      default:
        return '';
    }
  }

  /** Bytes the terminal should send back to the guest (VT52 identify). */
  takeResponse(): number[] {
    const r = this.response;
    this.response = [];
    return r;
  }
}
