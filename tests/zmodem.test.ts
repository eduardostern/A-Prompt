// The TypeScript ZMODEM sender and receiver (used by the AI board) against
// each other, our own ZMODEM.COM in the emulator, and lrzsz where installed.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CpmMachine } from '../src/cpm/machine';
import { BUILTIN_FILES } from '../src/assets/builtin-programs';
import type { ConsoleIO } from '../src/console';
import { TelnetServer } from '../src/cpm/telnet-server';
import { crc16, crc32, ZFile, ZmodemReceiver, ZmodemSender } from '../src/zmodem';

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

function sample(length: number, seed = 1): Uint8Array {
  const data = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    data[i] = x >>> 24;
  }
  if (length > 40) data.set([0xff, 0xff, 0x18, 0x0d, 0x00, 0x11, 0x13, 0x2a, 0x18, 0x41], 20);
  return data;
}

/** Boots a machine whose modem is connected to a ZmodemSender. */
async function connect(files: ZFile[], corruptAt = -1) {
  const con = new Con();
  const machine = new CpmMachine(con);
  machine.yieldFn = () => new Promise((r) => setImmediate(r));
  for (const f of BUILTIN_FILES) machine.disk.put(f.name, f.ext, Uint8Array.from(Buffer.from(f.data, 'base64')));
  const telnet = new TelnetServer();
  let sender!: ZmodemSender;
  let result: { ok: boolean; why?: string } | undefined;
  let sent = 0;
  machine.modem.dialer = (_t, h) => {
    sender = new ZmodemSender(files, (bytes) => {
      const copy = Uint8Array.from(bytes);
      for (let i = 0; i < copy.length; i++) if (sent++ === corruptAt) copy[i] ^= 0x55;
      h.onData(telnet.escape(copy));
    }, (ok, why) => { result = { ok, why }; });
    queueMicrotask(() => { h.onOpen(); h.onData(telnet.greeting()); });
    return { send: (b) => sender.receive(telnet.strip(b)), close: () => {} };
  };
  for (const c of 'ATDT1\r') machine.modem.write(c.charCodeAt(0));
  await new Promise((r) => setImmediate(r));
  while (machine.modem.available) machine.modem.read();
  sender.start();
  return { machine, con, result: () => result };
}

describe('ZMODEM sender (TypeScript)', () => {
  it('computes CRC-16/XMODEM', () => {
    expect(crc16([...'123456789'].map((c) => c.charCodeAt(0)))).toBe(0x31c3);
  });

  it('delivers files to ZMODEM.COM byte for byte', async () => {
    const a = sample(3000);
    const b = sample(2048, 7);
    const { machine, con, result } = await connect([
      { name: 'PROG.ASM', data: a },
      { name: 'PROG.COM', data: b },
    ]);
    await machine.runCom(machine.disk.find(0, 'ZMODEM  ', 'COM')!, 'ZMODEM R');
    expect(con.output).toContain('Transfer complete');
    expect(result()).toEqual({ ok: true, why: undefined });
    const gotA = machine.disk.find(0, 'PROG    ', 'ASM')!.data;
    expect(Buffer.from(gotA.subarray(0, a.length)).equals(Buffer.from(a))).toBe(true);
    expect([...gotA.subarray(a.length)].every((x) => x === 0x1a)).toBe(true);
    expect(Buffer.from(machine.disk.find(0, 'PROG    ', 'COM')!.data).equals(Buffer.from(b))).toBe(true);
  }, 30_000);

  it('restarts from ZRPOS after a corrupted byte', async () => {
    const a = sample(5000, 3);
    const { machine, con, result } = await connect([{ name: 'BIG.BIN', data: a }], 2500);
    await machine.runCom(machine.disk.find(0, 'ZMODEM  ', 'COM')!, 'ZMODEM R');
    expect(con.output).toContain('Transfer complete');
    expect(result()?.ok).toBe(true);
    const got = machine.disk.find(0, 'BIG     ', 'BIN')!.data;
    expect(Buffer.from(got.subarray(0, a.length)).equals(Buffer.from(a))).toBe(true);
  }, 30_000);

  const rz = ['lrz', 'rz'].find((n) => spawnSync('sh', ['-c', `command -v ${n}`]).status === 0);
  it.skipIf(!rz)('interoperates with lrzsz rz', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aprompt-zs-'));
    try {
      const data = sample(4000, 9);
      const child = spawn(rz!, ['-y'], { cwd: dir });
      const wire: number[] = [];
      const done = new Promise<{ ok: boolean }>((resolve) => {
        const sender = new ZmodemSender([{ name: 'hello.bin', data }], (b) => { wire.push(...b); child.stdin.write(b); }, (ok) => resolve({ ok }));
        child.stdout.on('data', (d: Buffer) => sender.receive(d));
        sender.start();
      });
      expect((await done).ok).toBe(true);
      await new Promise((r) => child.on('exit', r));
      expect(Buffer.from(readFileSync(join(dir, 'hello.bin'))).equals(Buffer.from(data))).toBe(true);
      // rz offers CRC-32, so the data went with ZBIN32 headers.
      expect(Buffer.from(wire).includes(Buffer.from([0x2a, 0x18, 0x43]))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * A sender and a receiver wired together. Bytes cross asynchronously, as on
 * a line; `mangle` may change what the sender puts on the wire.
 */
function pair(files: ZFile[], opts: { crc32?: boolean; maxBytes?: number; mangle?: (b: number[]) => number[] } = {}) {
  const wire: number[] = [];
  const back: number[] = [];
  let rx!: ZmodemReceiver;
  let tx!: ZmodemSender;
  const sent = new Promise<{ ok: boolean; why?: string }>((resolveTx) => {
    tx = new ZmodemSender(files, (b) => {
      const bytes = opts.mangle ? opts.mangle([...b]) : [...b];
      wire.push(...bytes);
      setImmediate(() => rx.receive(bytes));
    }, (ok, why) => resolveTx({ ok, why }));
  });
  const got = new Promise<{ ok: boolean; files: ZFile[]; why?: string }>((resolveRx) => {
    rx = new ZmodemReceiver((b) => {
      back.push(...b);
      setImmediate(() => tx.receive(b));
    }, (ok, files, why) => resolveRx({ ok, files, why }), { crc32: opts.crc32, maxBytes: opts.maxBytes });
  });
  return { tx, rx, sent, got, wire, back };
}

const hasHeader = (bytes: number[], kind: number, type: number) =>
  bytes.some((b, i) => b === 0x2a && bytes[i + 1] === 0x18 && bytes[i + 2] === kind && bytes[i + 3] === type);
const hexHeaders = (bytes: number[], type: number) =>
  Buffer.from(bytes).toString('latin1').split(`**\x18B${type.toString(16).padStart(2, '0')}`).length - 1;

describe('ZMODEM receiver (TypeScript)', () => {
  it('computes CRC-32', () => {
    const digits = [...'123456789'].map((c) => c.charCodeAt(0));
    expect(crc32(digits)).toBe(0xcbf43926);
    expect(crc32(digits.slice(4), crc32(digits.slice(0, 4)))).toBe(0xcbf43926);
  });

  for (const wide of [true, false]) {
    it(`takes a batch from the TypeScript sender with CRC-${wide ? 32 : 16}`, async () => {
      // Every byte value, so every ZDLE escape is on the wire.
      const every = Uint8Array.from({ length: 2600 }, (_, i) => (i * 7) & 0xff);
      const files = [
        { name: 'every.bin', data: every },
        { name: 'empty.txt', data: new Uint8Array(0) },
        { name: 'S.ASM', data: sample(5000, 4) },
      ];
      const p = pair(files, { crc32: wide });
      p.rx.start();
      p.tx.start();
      const [sent, got] = await Promise.all([p.sent, p.got]);
      expect(sent.ok).toBe(true);
      expect(got.ok).toBe(true);
      expect(got.files.map((f) => f.name)).toEqual(['every.bin', 'empty.txt', 'S.ASM']);
      got.files.forEach((f, i) => expect(Buffer.from(f.data).equals(Buffer.from(files[i].data))).toBe(true));
      expect(hasHeader(p.wire, 0x43, 10)).toBe(wide); // ZDATA as ZBIN32
      expect(hasHeader(p.wire, 0x41, 10)).toBe(!wide);
      // These go only escaped (ZDLE, then the byte XOR 40h); XON and CR are
      // also flow control and line ends around headers.
      for (const b of [0x10, 0x13, 0x8d, 0x90, 0x91, 0x93]) expect(p.wire.includes(b), `raw ${b}`).toBe(false);
      expect(p.wire.includes(0x18)).toBe(true);
    });
  }

  it('asks again with ZRPOS when a subpacket arrives corrupted', async () => {
    const data = sample(6000, 5);
    let n = 0;
    let hit = false;
    const p = pair([{ name: 'X.BIN', data }], {
      mangle: (bytes) => bytes.map((b) => {
        // One flipped byte in the second subpacket, once.
        if (!hit && n++ === 1500) { hit = true; return b ^ 0x01; }
        return b;
      }),
    });
    p.rx.start();
    p.tx.start();
    const [sent, got] = await Promise.all([p.sent, p.got]);
    expect(hit).toBe(true);
    expect(sent.ok && got.ok).toBe(true);
    expect(Buffer.from(got.files[0].data).equals(Buffer.from(data))).toBe(true);
    // ZRPOS 0 to start, then one from the last good subpacket (1024 = 400h).
    expect(hexHeaders(p.back, 9)).toBe(2);
    expect(Buffer.from(p.back).toString('latin1')).toContain('**\x18B0900040000');
  });

  it('skips a file over the size limit', async () => {
    const p = pair([{ name: 'HUGE.ASM', data: sample(70_000) }], { maxBytes: 64 * 1024 });
    p.rx.start();
    p.tx.start();
    const [sent, got] = await Promise.all([p.sent, p.got]);
    expect(sent.ok).toBe(true);
    expect(got).toEqual({ ok: true, files: [], why: 'HUGE.ASM is over 64 KB' });
    expect(hexHeaders(p.back, 5)).toBe(1); // ZSKIP
  });

  it('stops on five CANs, and when nobody starts sending', () => {
    let result: unknown;
    const rx = new ZmodemReceiver(() => {}, (ok, _files, why) => { result = { ok, why }; });
    rx.start();
    rx.receive([0x18, 0x18, 0x18, 0x18]);
    expect(result).toBeUndefined();
    rx.receive([0x18, 0x18, 0x18]);
    expect(result).toEqual({ ok: false, why: 'cancelled by the sender' });

    let t = 0;
    const idle = new ZmodemReceiver(() => {}, (ok, _files, why) => { result = { ok, why }; }, { now: () => t });
    idle.start();
    t = 179_000;
    idle.tick();
    expect(idle.finished).toBe(false);
    t = 180_000;
    idle.tick();
    expect(result).toEqual({ ok: false, why: 'no upload started' });
  });

  it('repeats ZRPOS when the sender goes quiet, then gives up', () => {
    let t = 0;
    let result: unknown;
    const out: number[] = [];
    const rx = new ZmodemReceiver((b) => out.push(...b), (ok, _files, why) => { result = { ok, why }; }, { now: () => t });
    rx.start();
    const fromTx: number[] = [];
    const tx = new ZmodemSender([{ name: 'Q.ASM', data: sample(100) }], (b) => fromTx.push(...b), () => {});
    tx.start();
    rx.receive(fromTx.splice(0)); // rz, ZRQINIT
    tx.receive(out.splice(0)); // ZRINIT twice: the sender answers with ZFILE
    rx.receive(fromTx.splice(0));
    expect(hexHeaders(out, 9)).toBe(1); // ZRPOS 0; the data never comes
    for (let i = 1; i <= 11; i++) { t = i * 10_000; rx.tick(); }
    expect(hexHeaders(out, 9)).toBe(11);
    expect(result).toEqual({ ok: false, why: 'no data from the sender' });
    expect(out.slice(-16)).toEqual([...new Array(8).fill(0x18), ...new Array(8).fill(0x08)]);
  });

  it('takes uploads from ZMODEM.COM in the emulator, also after a corrupted byte', async () => {
    for (const corruptAt of [-1, 1500]) {
      const con = new Con();
      const machine = new CpmMachine(con);
      machine.yieldFn = () => new Promise((r) => setImmediate(r));
      for (const f of BUILTIN_FILES) machine.disk.put(f.name, f.ext, Uint8Array.from(Buffer.from(f.data, 'base64')));
      const data = sample(3000, 11);
      machine.disk.put('UP', 'BIN', data);
      const telnet = new TelnetServer();
      let rx!: ZmodemReceiver;
      let result: { ok: boolean; files: ZFile[] } | undefined;
      let seen = 0;
      machine.modem.dialer = (_t, h) => {
        rx = new ZmodemReceiver((b) => h.onData(telnet.escape(b)), (ok, files) => { result = { ok, files }; });
        queueMicrotask(() => { h.onOpen(); h.onData(telnet.greeting()); });
        return {
          send: (b) => {
            const bytes = telnet.strip(b);
            for (let i = 0; i < bytes.length; i++) if (seen++ === corruptAt) bytes[i] ^= 0x55;
            rx.receive(bytes);
          },
          close: () => {},
        };
      };
      for (const c of 'ATDT1\r') machine.modem.write(c.charCodeAt(0));
      await new Promise((r) => setImmediate(r));
      while (machine.modem.available) machine.modem.read();
      rx.start();
      await machine.runCom(machine.disk.find(0, 'ZMODEM  ', 'COM')!, 'ZMODEM S UP.BIN');
      expect(con.output).toContain('Transfer complete');
      expect(result?.ok).toBe(true);
      const got = result!.files[0];
      expect(got.name).toBe('up.bin');
      // ZMODEM.COM sends whole records: the file, then ^Z padding.
      expect(got.data.length).toBe(3072);
      expect(Buffer.from(got.data.subarray(0, 3000)).equals(Buffer.from(data))).toBe(true);
    }
  }, 30_000);

  const sz = ['lsz', 'sz'].find((n) => spawnSync('sh', ['-c', `command -v ${n}`]).status === 0);
  it.skipIf(!sz)('takes a file from lrzsz sz (CRC-32)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aprompt-zr-'));
    try {
      const data = sample(9000, 13);
      writeFileSync(join(dir, 'fromsz.asm'), data);
      const child = spawn(sz!, ['fromsz.asm'], { cwd: dir });
      const wire: number[] = [];
      const got = await new Promise<{ ok: boolean; files: ZFile[] }>((resolve) => {
        const rx = new ZmodemReceiver((b) => child.stdin.write(b), (ok, files) => resolve({ ok, files }));
        child.stdout.on('data', (d: Buffer) => { wire.push(...d); rx.receive(d); });
        rx.start();
      });
      await new Promise((r) => child.on('exit', r));
      expect(got.ok).toBe(true);
      expect(got.files[0].name).toBe('fromsz.asm');
      expect(Buffer.from(got.files[0].data).equals(Buffer.from(data))).toBe(true);
      expect(hasHeader(wire, 0x43, 10)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
