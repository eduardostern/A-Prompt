export interface ConsoleIO {
  /** Writes a string (may contain \r\n and ANSI escapes). */
  write(text: string): void;
  /** Writes one 8-bit CP/M / CP437 character. */
  writeByte(code: number): void;
  /** Waits for one raw byte (keyboard). Resolves to 0x1A if the console closes. */
  readByte(): Promise<number>;
  /** Returns and consumes the next pending byte without blocking, if any. */
  pollByte(): number | undefined;
  /** True when a byte is waiting. Does not consume it. */
  hasInput(): boolean;
  /** Last byte written, used to avoid double line breaks. */
  lastByte: number;
  /** Terminal width in columns (CP/M assumes 80). */
  readonly columns: number;
}

export class WarmBoot extends Error {
  constructor() {
    super('warm boot');
  }
}

/** Shared line editor for the CCP and for BDOS function 10. */
export async function readConsoleLine(con: ConsoleIO, max = 127, echo = true): Promise<string> {
  let buf = '';
  for (;;) {
    const ch = await con.readByte();
    if (ch === 13) {
      if (echo) con.write('\r\n');
      return buf;
    }
    if (ch === 10) continue;
    if (ch === 3) {
      if (echo) con.write('^C\r\n');
      throw new WarmBoot();
    }
    if (ch === 8 || ch === 127) {
      if (buf.length) {
        buf = buf.slice(0, -1);
        if (echo) con.write('\b \b');
      }
      continue;
    }
    if (ch === 21 || ch === 24) {
      if (echo && buf.length) con.write('\r' + ' '.repeat(buf.length) + '\r');
      buf = '';
      continue;
    }
    if (ch === 5) {
      if (echo) con.write('\r\n');
      continue;
    }
    if (ch === 18) {
      if (echo) con.write('\r\n' + buf);
      continue;
    }
    if (ch === 19) continue;
    if (ch >= 32 && ch < 127) {
      if (buf.length < max) {
        buf += String.fromCharCode(ch);
        if (echo) con.writeByte(ch);
      }
    }
  }
}
