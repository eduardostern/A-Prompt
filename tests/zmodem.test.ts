// The TypeScript ZMODEM sender (used by the AI board) against our own
// ZMODEM.COM in the emulator, and against lrzsz's rz where installed.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CpmMachine } from '../src/cpm/machine';
import { BUILTIN_FILES } from '../src/assets/builtin-programs';
import type { ConsoleIO } from '../src/console';
import { TelnetServer } from '../src/cpm/telnet-server';
import { crc16, ZFile, ZmodemSender } from '../src/zmodem';

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
      const done = new Promise<{ ok: boolean }>((resolve) => {
        const sender = new ZmodemSender([{ name: 'hello.bin', data }], (b) => child.stdin.write(b), (ok) => resolve({ ok }));
        child.stdout.on('data', (d: Buffer) => sender.receive(d));
        sender.start();
      });
      expect((await done).ok).toBe(true);
      await new Promise((r) => child.on('exit', r));
      expect(Buffer.from(readFileSync(join(dir, 'hello.bin'))).equals(Buffer.from(data))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
