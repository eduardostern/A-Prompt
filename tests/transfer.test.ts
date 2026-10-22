// XMODEM.COM and ZMODEM.COM against lrzsz, the reference rz/sz, through the
// modem as a telnet link in BINARY mode. Skipped where lrzsz is not installed
// (CI installs it).
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CpmMachine } from '../src/cpm/machine';
import { BUILTIN_FILES } from '../src/assets/builtin-programs';
import type { ConsoleIO } from '../src/console';

/** The lrzsz command for a role: Homebrew names them lsz, Debian sz. */
function tool(...names: string[]): string | undefined {
  return names.find((n) => spawnSync('sh', ['-c', `command -v ${n}`]).status === 0);
}
const SZ = tool('lsz', 'sz');
const RZ = tool('lrz', 'rz');
const SX = tool('lsx', 'sx');
const RX = tool('lrx', 'rx');
const HAVE = Boolean(SZ && RZ && SX && RX);

class Con implements ConsoleIO {
  output = '';
  lastByte = 10;
  readonly columns = 80;
  write(t: string) { this.output += t; }
  writeByte(c: number) { this.output += String.fromCharCode(c); }
  async readByte() { return 0x1a; }
  pollByte() { return undefined; }
  peekByte() { return undefined; }
  hasInput() { return false; }
}

const IAC = 255, WILL = 251, DO = 253, SB = 250, SE = 240;

/** A telnet server in BINARY mode in front of a child process's stdio. */
class Peer {
  child?: ChildProcess;
  exit?: Promise<number>;
  stderr = '';
  /** Flip one byte of the stream to the program / from the program at this offset. */
  corruptIn = -1;
  corruptOut = -1;
  private sentIn = 0;
  private sentOut = 0;
  private onData?: (b: Uint8Array) => void;
  private state = 0;

  attach(machine: CpmMachine): void {
    machine.modem.dialer = (_t, h) => {
      this.onData = (b) => h.onData(b);
      queueMicrotask(() => {
        h.onOpen();
        h.onData(Uint8Array.from([IAC, WILL, 0, IAC, DO, 0]));
      });
      return { send: (b) => this.fromModem(b), close: () => this.child?.kill() };
    };
  }

  start(cmd: string, args: string[], cwd: string): void {
    const child = spawn(cmd, args, { cwd });
    this.child = child;
    child.stdout!.on('data', (d: Buffer) => {
      const out: number[] = [];
      for (let b of d) {
        if (this.sentIn++ === this.corruptIn) b ^= 0x55;
        out.push(b);
        if (b === IAC) out.push(IAC);
      }
      this.onData?.(Uint8Array.from(out));
    });
    child.stderr!.on('data', (d: Buffer) => { this.stderr += d.toString(); });
    this.exit = new Promise((r) => child.on('exit', (code) => r(code ?? -1)));
  }

  /** Strips telnet commands; IAC IAC is a data FFh. */
  private fromModem(bytes: Uint8Array): void {
    const out: number[] = [];
    for (const b of bytes) {
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
    for (let i = 0; i < out.length; i++) if (this.sentOut++ === this.corruptOut) out[i] ^= 0x55;
    if (out.length && this.child?.stdin?.writable) this.child.stdin.write(Uint8Array.from(out));
  }
}

function boot(): { machine: CpmMachine; con: Con; peer: Peer } {
  const con = new Con();
  const machine = new CpmMachine(con);
  // Let child-process I/O in between instruction slices.
  machine.yieldFn = () => new Promise((r) => setImmediate(r));
  for (const f of BUILTIN_FILES) {
    machine.disk.put(f.name, f.ext, Uint8Array.from(Buffer.from(f.data, 'base64')));
  }
  const peer = new Peer();
  peer.attach(machine);
  for (const c of 'ATDT1\r') machine.modem.write(c.charCodeAt(0));
  return { machine, con, peer };
}

async function connected(machine: CpmMachine): Promise<void> {
  await new Promise((r) => setImmediate(r));
  expect(machine.modem.online).toBe(true);
  while (machine.modem.available) machine.modem.read(); // the CONNECT message
}

/** Test data with every byte value telnet and ZMODEM treat specially. */
function sample(length: number): Uint8Array {
  const data = new Uint8Array(length);
  let x = 12345;
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    data[i] = x >>> 24;
  }
  data.set([0x0d, 0x00, 0x0d, 0x0a, 0xff, 0xff, 0x18, 0x18, 0x11, 0x13, 0x91, 0x93, 0x10, 0x90, 0x8d, 0x7f, 0x2a, 0x2a, 0x18, 0x42], 100);
  return data;
}

/** A CP/M file holds whole records; the tail of the last one is ^Z. */
function expectCpmCopy(got: Uint8Array, want: Uint8Array): void {
  expect(got.length).toBe(Math.ceil(want.length / 128) * 128);
  expect(Buffer.from(got.subarray(0, want.length)).equals(Buffer.from(want))).toBe(true);
  expect([...got.subarray(want.length)].every((b) => b === 0x1a)).toBe(true);
}

async function run(machine: CpmMachine, name: string, line: string): Promise<void> {
  const com = machine.disk.find(0, name.padEnd(8), 'COM')!;
  await machine.runCom(com, line);
}

let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });
const scratch = () => (dir = mkdtempSync(join(tmpdir(), 'aprompt-xfer-')));

describe.skipIf(!HAVE)('file transfer against lrzsz', () => {
  it('XMODEM R receives 128-byte CRC blocks from sx', async () => {
    const { machine, con, peer } = boot();
    await connected(machine);
    const want = sample(3000);
    writeFileSync(join(scratch(), 'in.bin'), want);
    peer.start(SX!, ['in.bin'], dir);
    await run(machine, 'XMODEM', 'XMODEM R IN.BIN');
    expect(con.output).toContain('Transfer complete');
    expect(await peer.exit).toBe(0);
    expectCpmCopy(machine.disk.find(0, 'IN      ', 'BIN')!.data, want);
  }, 60_000);

  it('XMODEM R receives 1K blocks from sx -k', async () => {
    const { machine, con, peer } = boot();
    await connected(machine);
    const want = sample(5000);
    writeFileSync(join(scratch(), 'k.bin'), want);
    peer.start(SX!, ['-k', 'k.bin'], dir);
    await run(machine, 'XMODEM', 'XMODEM R K.BIN');
    expect(con.output).toContain('Transfer complete');
    expect(await peer.exit).toBe(0);
    expectCpmCopy(machine.disk.find(0, 'K       ', 'BIN')!.data, want);
  }, 60_000);

  it('XMODEM S sends to rx', async () => {
    const { machine, con, peer } = boot();
    await connected(machine);
    const want = sample(1280);
    machine.disk.put('OUT', 'BIN', want);
    peer.start(RX!, ['-c', 'out.bin'], scratch());
    await run(machine, 'XMODEM', 'XMODEM S OUT.BIN');
    expect(con.output).toContain('Transfer complete');
    expect(await peer.exit).toBe(0);
    expect(Buffer.from(readFileSync(join(dir, 'out.bin'))).equals(Buffer.from(want))).toBe(true);
  }, 60_000);

  it('ZMODEM R receives files from sz', async () => {
    const { machine, con, peer } = boot();
    await connected(machine);
    const a = sample(5000);
    const b = sample(300).reverse();
    writeFileSync(join(scratch(), 'first.bin'), a);
    writeFileSync(join(dir, 'second.txt'), b);
    peer.start(SZ!, ['first.bin', 'second.txt'], dir);
    await run(machine, 'ZMODEM', 'ZMODEM R');
    expect(con.output).toContain('Transfer complete');
    expect(await peer.exit).toBe(0);
    expectCpmCopy(machine.disk.find(0, 'FIRST   ', 'BIN')!.data, a);
    expectCpmCopy(machine.disk.find(0, 'SECOND  ', 'TXT')!.data, b);
  }, 60_000);

  it('ZMODEM S sends a file to rz', async () => {
    const { machine, con, peer } = boot();
    await connected(machine);
    const want = sample(4096 + 256);
    machine.disk.put('UP', 'BIN', want);
    peer.start(RZ!, ['-y'], scratch());
    await run(machine, 'ZMODEM', 'ZMODEM S UP.BIN');
    expect(con.output).toContain('Transfer complete');
    expect(await peer.exit).toBe(0);
    expect(Buffer.from(readFileSync(join(dir, 'up.bin'))).equals(Buffer.from(want))).toBe(true);
  }, 60_000);

  it('XMODEM R recovers from a corrupted block', async () => {
    const { machine, con, peer } = boot();
    await connected(machine);
    const want = sample(2000);
    writeFileSync(join(scratch(), 'bad.bin'), want);
    peer.corruptIn = 700;
    peer.start(SX!, ['bad.bin'], dir);
    await run(machine, 'XMODEM', 'XMODEM R BAD.BIN');
    expect(con.output).toContain('Transfer complete');
    expectCpmCopy(machine.disk.find(0, 'BAD     ', 'BIN')!.data, want);
  }, 60_000);

  it('ZMODEM R resumes with ZRPOS after a corrupted subpacket', async () => {
    const { machine, con, peer } = boot();
    await connected(machine);
    const want = sample(40_000);
    writeFileSync(join(scratch(), 'big.bin'), want);
    peer.corruptIn = 20_000;
    peer.start(SZ!, ['big.bin'], dir);
    await run(machine, 'ZMODEM', 'ZMODEM R');
    expect(con.output).toContain('Transfer complete');
    expect(await peer.exit).toBe(0);
    expectCpmCopy(machine.disk.find(0, 'BIG     ', 'BIN')!.data, want);
  }, 60_000);

  it('ZMODEM S seeks back when rz asks with ZRPOS', async () => {
    const { machine, con, peer } = boot();
    await connected(machine);
    const want = sample(30_000 - 30_000 % 128);
    machine.disk.put('SEEK', 'BIN', want);
    peer.corruptOut = 15_000;
    peer.start(RZ!, ['-y'], scratch());
    await run(machine, 'ZMODEM', 'ZMODEM S SEEK.BIN');
    expect(con.output).toContain('Transfer complete');
    expect(await peer.exit).toBe(0);
    expect(Buffer.from(readFileSync(join(dir, 'seek.bin'))).equals(Buffer.from(want))).toBe(true);
  }, 60_000);

  it('ZMODEM R turns a Unix name into 8.3 on the drive asked for', async () => {
    const { machine, con, peer } = boot();
    await connected(machine);
    writeFileSync(join(scratch(), 'my long.name.tgz'), sample(200));
    peer.start(SZ!, ['my long.name.tgz'], dir);
    await run(machine, 'ZMODEM', 'ZMODEM R B:');
    expect(con.output).toContain('Transfer complete');
    expect(machine.drives[1].find(0, 'MY-LONG-', 'TGZ')).toBeTruthy();
  }, 60_000);
});
