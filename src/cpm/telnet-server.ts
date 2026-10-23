/**
 * The server side of a telnet line in BINARY mode, for peers that live in
 * the browser (the AI board, tests). The modem then passes every byte value
 * both ways: FFh is doubled on the wire and CR is not padded with NUL.
 */
const IAC = 255, WILL = 251, DO = 253, SB = 250, SE = 240;

export class TelnetServer {
  private state = 0;

  /** Sent first: the server will and wants BINARY. */
  greeting(): Uint8Array {
    return Uint8Array.from([IAC, WILL, 0, IAC, DO, 0]);
  }

  /** Data to the modem: IAC doubled. */
  escape(bytes: ArrayLike<number>): Uint8Array {
    const out: number[] = [];
    for (let i = 0; i < bytes.length; i++) {
      out.push(bytes[i]);
      if (bytes[i] === IAC) out.push(IAC);
    }
    return Uint8Array.from(out);
  }

  /** Data from the modem: option negotiation dropped, IAC IAC is FFh. */
  strip(bytes: ArrayLike<number>): number[] {
    const out: number[] = [];
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      switch (this.state) {
        case 0: if (b === IAC) this.state = 1; else out.push(b); break;
        case 1:
          if (b === IAC) { out.push(IAC); this.state = 0; }
          else if (b >= WILL) this.state = 2;
          else if (b === SB) this.state = 3;
          else this.state = 0;
          break;
        case 2: this.state = 0; break;
        case 3: if (b === IAC) this.state = 4; break;
        case 4: this.state = b === SE ? 0 : 3; break;
      }
    }
    return out;
  }
}
