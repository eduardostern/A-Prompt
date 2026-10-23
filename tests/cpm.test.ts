import { describe, expect, it } from 'vitest';
import { CpmMachine } from '../src/cpm/machine';
import { BUILTIN_FILES } from '../src/assets/builtin-programs';
import type { ConsoleIO } from '../src/console';
import { displayName } from '../src/cpm/disk';
import { DiskImage } from '../src/cpm/image';

class TestConsole implements ConsoleIO {
  output = '';
  queue: number[] = [];
  lastByte = 10;
  readonly columns = 80;

  write(text: string): void {
    this.output += text;
    if (text.length) this.lastByte = text.charCodeAt(text.length - 1);
  }

  writeByte(code: number): void {
    this.lastByte = code;
    if (code === 13) this.output += '\r';
    else if (code === 10) this.output += '\n';
    else if (code === 8) this.output += '\b';
    else if (code === 9) this.output += '\t';
    else if (code === 27) this.output += '\x1b';
    else if (code >= 32 && code < 127) this.output += String.fromCharCode(code);
    else if (code >= 128) this.output += '.';
  }

  private idleReads = 0;

  async readByte(): Promise<number> {
    const ch = this.queue.shift();
    if (ch !== undefined) { this.idleReads = 0; return ch; }
    // Fail instead of hanging when a test waits for input it never feeds.
    if (++this.idleReads > 10_000) throw new Error('test console: waiting for input');
    return 0x1a;
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

  feed(text: string): void {
    for (const ch of text) this.queue.push(ch.charCodeAt(0));
  }
}

function boot(): { machine: CpmMachine; con: TestConsole } {
  const con = new TestConsole();
  const machine = new CpmMachine(con);
  machine.yieldFn = () => Promise.resolve();
  for (const f of BUILTIN_FILES) {
    const bin = atob(f.data);
    const data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    machine.disk.put(f.name, f.ext, data);
  }
  return { machine, con };
}

describe('CP/M 2.2 machine', () => {
  it('runs HELLO.COM', async () => {
    const { machine, con } = boot();
    const hello = machine.disk.find(0, 'HELLO   ', 'COM');
    expect(hello).toBeTruthy();
    await machine.runCom(hello!, 'HELLO');
    expect(con.output).toContain('Hello from CP/M 2.2!');
  });

  it('reports disk activity for the drive sounds: directory, then the file a track at a time', async () => {
    const { machine } = boot();
    const tracks: number[] = [];
    const records: number[] = [];
    machine.bdos.onDisk = (drive, track, _write, n) => {
      expect(drive).toBe(0);
      tracks.push(track);
      records.push(n);
    };
    machine.disk.put('BIG', 'COM', new Uint8Array(60 * 128).fill(0xc9)); // RET
    await machine.runCom(machine.disk.find(0, 'BIG     ', 'COM')!, 'BIG');
    // Directory (track 2), then 60 records = three tracks in a row.
    expect(tracks[0]).toBe(2);
    expect(tracks).toHaveLength(4);
    expect(records).toEqual([1, 26, 26, 8]);
    expect(tracks[2]).toBe(tracks[1] + 1);
    expect(tracks[3]).toBe(tracks[2] + 1);
    expect(tracks.every((t) => t >= 2 && t < 77)).toBe(true);
  });

  it('waits for a slow serial line before sending more output', async () => {
    const { machine, con } = boot();
    let queued = 0;
    // A line that queues every character and needs 5 ms per character beyond 16.
    const write = con.write.bind(con);
    con.write = (t: string) => { queued += t.length; write(t); };
    const writeByte = con.writeByte.bind(con);
    con.writeByte = (b: number) => { queued++; writeByte(b); };
    (con as unknown as { outputDelay: () => number }).outputDelay = () => Math.max(0, queued - 16) * 5;
    const sleeps: number[] = [];
    machine.sleepFn = async (ms) => { sleeps.push(ms); queued = Math.max(0, queued - ms / 5); };
    await machine.runCom(machine.disk.find(0, 'HELLO   ', 'COM')!, 'HELLO');
    expect(con.output).toContain('Hello from CP/M 2.2!');
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it('waits for the drive when drives run at the speed of the era', async () => {
    const { machine } = boot();
    const sleeps: number[] = [];
    machine.sleepFn = async (ms) => { sleeps.push(ms); };
    machine.bdos.onDisk = (_d, _t, _w, n) => machine.owe(n * 36);
    await machine.runCom(machine.disk.find(0, 'HELLO   ', 'COM')!, 'HELLO');
    // HELLO.COM is one record, plus the directory: 72 ms before it runs.
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(72);
  });

  it('returns to the CCP when a program halts the CPU', async () => {
    const { machine, con } = boot();
    machine.disk.put('HALT', 'COM', new Uint8Array([0x76]));
    const halt = machine.disk.find(0, 'HALT    ', 'COM')!;
    await machine.runCom(halt, 'HALT');
    expect(machine.busy).toBe(false);
    expect(con.output).not.toContain('execution limit');
  });

  it('DIR lists bundled files', async () => {
    const { machine, con } = boot();
    await machine.ccp.execute('DIR');
    expect(con.output).toContain('PIP      COM');
    expect(con.output).toContain('HELLO    COM');
    expect(con.output).toContain('files');
  });

  it('TYPE prints a text file', async () => {
    const { machine, con } = boot();
    await machine.ccp.execute('TYPE HELLO.ASM');
    expect(con.output).toContain('Hello from CP/M 2.2!');
    expect(con.output).toContain('CALL\t5');
  });

  it('SAVE and ERA', async () => {
    const { machine } = boot();
    machine.mem.set([1, 2, 3, 4], 0x0100);
    await machine.ccp.execute('SAVE 1 TEST.BIN');
    const f = machine.disk.find(0, 'TEST    ', 'BIN');
    expect(f?.data.length).toBe(256);
    expect([...f!.data.slice(0, 4)]).toEqual([1, 2, 3, 4]);
    await machine.ccp.execute('ERA TEST.BIN');
    expect(machine.disk.find(0, 'TEST    ', 'BIN')).toBeUndefined();
  });

  it('PIP copies a file', async () => {
    const { machine, con } = boot();
    const pip = machine.disk.find(0, 'PIP     ', 'COM')!;
    await machine.runCom(pip, 'PIP COPY.TXT=HELLO.ASM');
    const src = machine.disk.find(0, 'HELLO   ', 'ASM')!;
    const dst = machine.disk.find(0, 'COPY    ', 'TXT');
    expect(con.output).not.toContain('ERROR');
    expect(dst).toBeTruthy();
    expect([...dst!.data.slice(0, src.data.length)]).toEqual([...src.data]);
    expect(dst!.data.length).toBeGreaterThanOrEqual(src.data.length);
  });

  it('STAT identifies the drive', async () => {
    const { machine, con } = boot();
    const stat = machine.disk.find(0, 'STAT    ', 'COM')!;
    await machine.runCom(stat, 'STAT');
    expect(con.output).toContain('A: R/W');
    expect(con.output.toUpperCase()).toContain('SPACE');
  });

  it('ASM assembles and LOAD converts HELLO.ASM', async () => {
    const { machine, con } = boot();
    const asm = machine.disk.find(0, 'ASM     ', 'COM')!;
    await machine.runCom(asm, 'ASM HELLO.ASM');
    const hex = machine.disk.find(0, 'HELLO   ', 'HEX');
    expect(con.output).toContain('END OF ASSEMBLY');
    expect(hex).toBeTruthy();
    expect(new TextDecoder().decode(hex!.data)).toContain(':100100000E');

    const load = machine.disk.find(0, 'LOAD    ', 'COM')!;
    await machine.runCom(load, 'LOAD HELLO');
    const com = machine.disk.find(0, 'HELLO   ', 'COM')!;
    expect([...com.data.slice(0, 9)]).toEqual([0x0e, 0x09, 0x11, 0x09, 0x01, 0xcd, 0x05, 0x00, 0xc9]);
    expect(com.data.length).toBeGreaterThanOrEqual(9);
  });

  it('PIP copies a multi-extent file', async () => {
    const { machine } = boot();
    const big = new Uint8Array(20000);
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
    machine.disk.put('BIG', 'BIN', big);
    const pip = machine.disk.find(0, 'PIP     ', 'COM')!;
    await machine.runCom(pip, 'PIP COPY.BIN=BIG.BIN');
    const dst = machine.disk.find(0, 'COPY    ', 'BIN')!;
    expect(dst.data.length).toBeGreaterThanOrEqual(big.length);
    expect([...dst.data.slice(0, big.length)]).toEqual([...big]);
  });

  it('SUBMIT queues and runs commands through the CCP', async () => {
    const { machine, con } = boot();
    const submit = machine.disk.find(0, 'SUBMIT  ', 'COM')!;
    await machine.runCom(submit, 'SUBMIT DEMO');
    for (let i = 0; i < 3; i++) {
      const line = await machine.ccp.prompt();
      await machine.ccp.execute(line);
    }
    expect(con.output).toContain('HELLO    COM');
    expect(con.output).toContain('Hello from CP/M 2.2!');
    expect(con.output).toContain('A: R/W');
    expect(machine.disk.find(0, '$$$     ', 'SUB')).toBeUndefined();
  });

  it('copies between drives and runs a program from B:', async () => {
    const { machine, con } = boot();
    const pip = machine.drives[0].find(0, 'PIP     ', 'COM')!;
    await machine.runCom(pip, 'PIP B:COPY.TXT=HELLO.ASM');
    const src = machine.drives[0].find(0, 'HELLO   ', 'ASM')!;
    const dst = machine.drives[1].find(0, 'COPY    ', 'TXT');
    expect(dst).toBeTruthy();
    expect([...dst!.data.slice(0, src.data.length)]).toEqual([...src.data]);

    const hello = machine.drives[0].find(0, 'HELLO   ', 'COM')!;
    machine.drives[1].put(hello.name, hello.ext, hello.data);
    await machine.runCom(machine.drives[1].find(0, 'HELLO   ', 'COM')!, 'B:HELLO');
    expect(con.output).toContain('Hello from CP/M 2.2!');

    await machine.ccp.execute('DIR B:');
    expect(con.output).toContain('B: HELLO');
    expect(con.output).toContain('B: COPY');

    await machine.ccp.execute('B:');
    expect(machine.bdos.drive).toBe(1);
    await machine.ccp.execute('DIR');
    expect(con.output).toContain('B: COPY');
  });

  it('XSUB feeds console input from the SUBMIT queue', async () => {
    const { machine, con } = boot();
    const submit = machine.disk.find(0, 'SUBMIT  ', 'COM')!;
    await machine.runCom(submit, 'SUBMIT XSUB');
    for (let i = 0; i < 2; i++) {
      const line = await machine.ccp.prompt();
      await machine.ccp.execute(line);
    }
    expect(con.output).toContain('XSUB enabled');
    expect(con.output).toContain('NAME?');
    expect(con.output).toContain('ALICE');
    expect(machine.disk.find(0, '$$$     ', 'SUB')).toBeUndefined();
  });

  it('captures printer/serial output and exposes the clock', async () => {
    const { machine, con } = boot();
    const code = new Uint8Array([
      0x0e, 0x05, 0x1e, 0x50, 0xcd, 0x05, 0x00, // L_WRITE 'P'
      0x0e, 0x04, 0x1e, 0x53, 0xcd, 0x05, 0x00, // A_WRITE 'S'
      0x0e, 0x69, 0x11, 0x00, 0x02, 0xcd, 0x05, 0x00, // T_GET at 0200h
      0xc9,
    ]);
    machine.drives[0].put('DEVTEST', 'COM', code);
    await machine.runCom(machine.drives[0].find(0, 'DEVTEST ', 'COM')!, 'DEVTEST');
    expect(machine.bdos.printerLog).toEqual([0x50]);
    expect(machine.bdos.serialLog).toEqual([0x53]);
    const days = machine.mem[0x0200] | (machine.mem[0x0201] << 8);
    expect(days).toBeGreaterThan(0);
    expect(machine.mem[0x0202]).toBeLessThan(24);
    expect(machine.mem[0x0203]).toBeLessThan(60);

    await machine.ccp.execute('DATE');
    expect(con.output).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);

    machine.bdos.printerLog.length = 0;
    machine.bdos.serialLog.length = 0;
    expect(machine.bdos.printerLog).toHaveLength(0);
  });

  it('dir/rename/user builtins keep the FCB layer consistent', async () => {
    const { machine } = boot();
    await machine.ccp.execute('REN NOVO.TXT=HELLO.ASM');
    expect(machine.disk.find(0, 'NOVO    ', 'TXT')).toBeTruthy();
    expect(machine.disk.find(0, 'HELLO   ', 'ASM')).toBeUndefined();
    await machine.ccp.execute('USER 3');
    expect(machine.bdos.user).toBe(3);
    expect(displayName(machine.disk.find(0, 'NOVO    ', 'TXT')!)).toBe('NOVO.TXT');
  });
});

describe('CP/M 2.2 compatibility', () => {
  const CALL5 = [0xcd, 0x05, 0x00];
  const bdos = (fn: number, de: number) => [0x0e, fn, 0x11, de & 0xff, de >> 8, ...CALL5];

  async function run(machine: CpmMachine, code: number[], line = 'PROBE'): Promise<void> {
    const f = machine.disk.put('PROBE', 'COM', new Uint8Array(code));
    await machine.runCom(f!, line);
  }

  it('BDOS 6 with E=FFh returns 0 when no key is waiting', async () => {
    const { machine } = boot();
    await run(machine, [0x0e, 0x06, 0x1e, 0xff, ...CALL5, 0x32, 0x00, 0x02, 0xc9]);
    expect(machine.mem[0x0200]).toBe(0);
  });

  it('console status does not swallow the pending key', async () => {
    const { machine, con } = boot();
    con.feed('Q');
    await run(machine, [...bdos(11, 0), ...bdos(1, 0), 0x32, 0x00, 0x02, 0xc9]);
    expect(machine.mem[0x0200]).toBe(0x51);
  });

  it('resets DMA to 0080h before each program', async () => {
    const { machine } = boot();
    machine.disk.put('T', 'DAT', new Uint8Array(128).fill(0x41));
    await run(machine, [...bdos(26, 0x3000), 0xc9]);
    machine.mem.fill(0, 0x80, 0x100);
    await run(machine, [...bdos(15, 0x5c), ...bdos(20, 0x5c), 0xc9], 'PROBE T.DAT');
    expect(machine.mem[0x80]).toBe(0x41);
  });

  it('rereads the last random record on the next sequential read', async () => {
    const { machine } = boot();
    const data = new Uint8Array(512);
    for (let r = 0; r < 4; r++) data.fill(r, r * 128, r * 128 + 128);
    machine.disk.put('R', 'DAT', data);
    await run(machine, [
      ...bdos(15, 0x5c),
      0x21, 0x7d, 0x00, 0x36, 0x02, // R0 = 2
      ...bdos(33, 0x5c),
      ...bdos(26, 0x3000),
      ...bdos(20, 0x5c),
      0xc9,
    ], 'PROBE R.DAT');
    expect(machine.mem[0x3000]).toBe(2);
  });

  it('keeps the BIOS and system data above the TPA', async () => {
    const { machine, con } = boot();
    const tpaTop = machine.mem[6] | (machine.mem[7] << 8);
    const bios = machine.mem[1] | (machine.mem[2] << 8);
    expect(bios).toBeGreaterThan(tpaTop);
    // Fill the whole TPA below the BDOS with HALT, then call BIOS CONOUT via 0001h.
    const code = [
      0x2a, 0x06, 0x00,             // LHLD 0006h
      0x2b,                         // DCX H
      0x36, 0x76,                   // loop: MVI M,76h
      0x2b,                         // DCX H
      0x7c, 0xfe, 0x10,             // MOV A,H / CPI 10h
      0xc2, 0x04, 0x01,             // JNZ loop
      0x2a, 0x01, 0x00,             // LHLD 0001h
      0x11, 0x09, 0x00, 0x19,       // HL = CONOUT
      0x0e, 0x58,                   // MVI C,'X'
      0x11, 0x1c, 0x01, 0xd5, 0xe9, // push return, PCHL
      0x00,
      0xc9,                         // 011Ch: RET
    ];
    await run(machine, code);
    expect(con.output).toContain('X');
  });

  it('keeps running a SUBMIT batch after it changes drive', async () => {
    const { machine, con } = boot();
    machine.drives[1].put('SW', 'SUB', new TextEncoder().encode('A:\r\nHELLO\r\n\x1a'));
    await machine.ccp.execute('B:');
    await machine.ccp.execute('A:SUBMIT SW');
    expect(machine.drives[1].find(0, '$$$     ', 'SUB')).toBeTruthy();
    for (let i = 0; i < 2; i++) await machine.ccp.execute(await machine.ccp.prompt());
    expect(con.output).toContain('Hello from CP/M 2.2!');
    expect(machine.bdos.drive).toBe(0);
    expect(machine.drives[1].find(0, '$$$     ', 'SUB')).toBeUndefined();
  });

  it('runs a SUBMIT batch from another user area', async () => {
    const { machine, con } = boot();
    const submit = machine.disk.find(0, 'SUBMIT  ', 'COM')!;
    machine.disk.put('SUBMIT', 'COM', submit.data, 3);
    machine.disk.put('U', 'SUB', new TextEncoder().encode('DIR\r\n\x1a'), 3);
    await machine.ccp.execute('USER 3');
    await machine.ccp.execute('SUBMIT U');
    await machine.ccp.execute(await machine.ccp.prompt());
    expect(con.output).toContain('A>DIR');
    expect(con.output).toContain('SUBMIT   COM');
    expect(machine.disk.find(3, '$$$     ', 'SUB')).toBeUndefined();
  });

  it('fills a file drive block by block until the disk is full', async () => {
    const { machine } = boot();
    // F_MAKE BIG.DAT, then F_WRITE until it fails; store the error at 0200h.
    await run(machine, [
      ...bdos(22, 0x5c),
      ...bdos(21, 0x5c),
      0xb7, 0xca, 0x08, 0x01,
      0x32, 0x00, 0x02, 0xc9,
    ], 'PROBE BIG.DAT');
    expect(machine.mem[0x0200]).toBe(2);
    const big = machine.disk.find(0, 'BIG     ', 'DAT')!;
    const others = machine.disk.files.filter((f) => f !== big)
      .reduce((n, f) => n + Math.ceil(f.data.length / 2048), 0);
    expect(big.data.length).toBe((2040 - 16 - others) * 2048);
  });

  it('STAT reports the free space of the drive', async () => {
    const { machine, con } = boot();
    machine.disk.put('BIG', 'DAT', new Uint8Array(100_000));
    const used = machine.disk.files.reduce((n, f) => n + Math.ceil(f.data.length / 2048), 0);
    await run(machine, [], 'PROBE');
    await machine.runCom(machine.disk.find(0, 'STAT    ', 'COM')!, 'STAT');
    expect(con.output).toContain(`A: R/W, Space: ${(2040 - 16 - used) * 2}k`);
    await machine.runCom(machine.disk.find(0, 'STAT    ', 'COM')!, 'STAT BIG.DAT');
    // 100000 bytes = 782 records in 49 2K blocks (98k) and 7 16K extents.
    expect(con.output).toMatch(/782\s+98k\s+7 R\/W A:BIG\.DAT/);
  });

  it('keeps the prompt on its drive after a program resets the disks', async () => {
    const { machine } = boot();
    const hello = machine.disk.find(0, 'HELLO   ', 'COM')!;
    machine.drives[1].put('RESET', 'COM', new Uint8Array([...bdos(13, 0), 0xc9]));
    machine.drives[1].put(hello.name, hello.ext, hello.data);
    await machine.ccp.execute('B:');
    await machine.ccp.execute('RESET');
    expect(machine.bdos.drive).toBe(1);
  });

  /** Counts search first/next results for *.* ; `patch` is 5 bytes run first. */
  function countSearch(patch: number[]): number[] {
    return [
      ...patch,
      ...bdos(17, 0x5c), // 0105: search first
      0x3c, 0xca, 0x20, 0x01, // 010D: INC A / JZ 0120 (A was FFh: done)
      0x21, 0x00, 0x02, 0x34, // 0111: INC (0200h)
      ...bdos(18, 0x5c), // 0115: search next
      0xc3, 0x0d, 0x01, // 011D: JMP 010D
      0xc9, // 0120
    ];
  }

  it('directory search returns each file once unless EX is ?', async () => {
    const { machine } = boot();
    machine.disk.put('BIG', 'DAT', new Uint8Array(40_000)); // three 16K extents
    machine.disk.put('PROBE', 'COM', new Uint8Array(0));
    const files = machine.disk.list(0);
    const entries = files.reduce((n, f) => n + Math.max(1, Math.ceil(f.data.length / 16384)), 0);
    machine.mem[0x0200] = 0;
    await run(machine, countSearch([0, 0, 0, 0, 0]), 'PROBE *.*');
    expect(machine.mem[0x0200]).toBe(files.length);
    machine.mem[0x0200] = 0;
    await run(machine, countSearch([0x3e, 0x3f, 0x32, 0x68, 0x00]), 'PROBE *.*'); // EX = '?'
    expect(machine.mem[0x0200]).toBe(entries);
  });

  it('directory search with ? in the drive byte covers every user area', async () => {
    const { machine } = boot();
    machine.disk.put('OTHER', 'TXT', new Uint8Array(10), 5);
    machine.disk.put('PROBE', 'COM', new Uint8Array(0));
    machine.mem[0x0200] = 0;
    await run(machine, countSearch([0x3e, 0x3f, 0x32, 0x5c, 0x00]), 'PROBE *.*'); // drive = '?'
    const entries = machine.disk.files.reduce((n, f) => n + Math.max(1, Math.ceil(f.data.length / 16384)), 0);
    expect(machine.mem[0x0200]).toBe(entries);
    expect(machine.disk.files.some((f) => f.user === 5)).toBe(true);
  });

  it('fills the default FCBs like the CP/M 2.2 CCP', async () => {
    const { machine } = boot();
    const fcb = (addr: number) => [machine.mem[addr], String.fromCharCode(...machine.mem.subarray(addr + 1, addr + 12))];
    await run(machine, [0xc9], 'PROBE B:FOO*.T* $R/O');
    expect(fcb(0x5c)).toEqual([2, 'FOO?????T??']);
    expect(fcb(0x6c)).toEqual([0, '$R/O       ']); // '/' is not a delimiter
    await run(machine, [0xc9], 'PROBE B:=A:X.TXT');
    expect(fcb(0x5c)).toEqual([2, '           ']); // stops at '='
    expect(fcb(0x6c)).toEqual([0, '           ']);
  });

  it('STAT sets file attributes', async () => {
    const { machine, con } = boot();
    machine.disk.put('NOTES', 'TXT', new Uint8Array(200));
    await machine.ccp.execute('STAT NOTES.TXT $R/O');
    expect(con.output).toContain('NOTES.TXT set to R/O');
    expect(machine.disk.find(0, 'NOTES   ', 'TXT')!.ro).toBe(true);
  });

  it('limits the Z80 clock when clockHz is set', async () => {
    const { machine } = boot();
    // 65536 iterations of DCX B / MOV A,B / ORA C / JNZ = 24 T-states each.
    const loop = [0x01, 0x00, 0x00, 0x0b, 0x78, 0xb1, 0xc2, 0x03, 0x01, 0xc9];
    machine.clockHz = 8_000_000;
    const t0 = performance.now();
    await run(machine, loop);
    const elapsed = performance.now() - t0;
    // 65536 * 24 T-states at 8 MHz is about 197 ms.
    expect(elapsed).toBeGreaterThan(150);
    expect(elapsed).toBeLessThan(1500);
  });

  it('does not reuse a cached file when the FCB names another file', async () => {
    const { machine } = boot();
    machine.disk.put('A', 'DAT', new Uint8Array(128));
    machine.disk.put('B', 'DAT', new Uint8Array(1024));
    await run(machine, [
      ...bdos(15, 0x5c),
      0x3e, 0x42, 0x32, 0x5d, 0x00, // FCB name -> B.DAT
      ...bdos(35, 0x5c),
      0xc9,
    ], 'PROBE A.DAT');
    expect(machine.mem[0x7d]).toBe(8);
  });
  it('BIOS READ and WRITE use the DMA address byte for byte', async () => {
    const { machine } = boot();
    const image = DiskImage.blank();
    image.writeSector(2, 0, new Uint8Array(128).fill(0xaa));
    expect(machine.drives[1].mountImage(image.toBytes())).toBe(true);
    await run(machine, [
      0x1e, 0x01, 0xcd, 0x1b, 0xfe, // SELDSK B:
      0x01, 0x02, 0x00, 0xcd, 0x1e, 0xfe, // SETTRK 2
      0x01, 0x00, 0x00, 0xcd, 0x21, 0xfe, // SETSEC 0
      0x01, 0x03, 0x20, 0xcd, 0x24, 0xfe, // SETDMA 2003h
      0xcd, 0x27, 0xfe, // READ
      0x3e, 0x55, 0x32, 0x03, 0x30, // (3003h) = 55h
      0x01, 0x03, 0x30, 0xcd, 0x24, 0xfe, // SETDMA 3003h
      0x01, 0x01, 0x00, 0xcd, 0x21, 0xfe, // SETSEC 1
      0xcd, 0x2a, 0xfe, // WRITE
      0xc9,
    ]);
    expect(machine.mem[0x2000]).toBe(0);
    expect(machine.mem[0x2003]).toBe(0xaa);
    expect(machine.mem[0x2082]).toBe(0xaa);
    expect(machine.mem[0x2083]).toBe(0);
    const written = machine.drives[1].image!.readSector(2, 1)!;
    expect(written[0]).toBe(0x55);
  });
  it('keeps S2 in the record number for files beyond 512K', async () => {
    const { machine } = boot();
    const big = new Uint8Array(1024 * 1024);
    big[5000 * 128] = 0x42;
    big[5001 * 128] = 0x43;
    machine.disk.put('BIG', 'DAT', big);
    await run(machine, [
      ...bdos(15, 0x5c),
      0x21, 0x88, 0x13, 0x22, 0x7d, 0x00, 0xaf, 0x32, 0x7f, 0x00, // r0-r2 = 5000
      ...bdos(33, 0x5c), // random read
      0x3a, 0x80, 0x00, 0x32, 0x00, 0x20, // (2000h) = first byte
      ...bdos(20, 0x5c), // sequential read rereads record 5000
      ...bdos(20, 0x5c), // then 5001
      0x3a, 0x80, 0x00, 0x32, 0x01, 0x20,
      ...bdos(36, 0x5c), // random record from the FCB position
      0xc9,
    ], 'PROBE BIG.DAT');
    const fcb = 0x5c;
    expect(machine.mem[0x2000]).toBe(0x42);
    expect(machine.mem[0x2001]).toBe(0x43);
    // After reading 5001 the FCB sits on 5002: EX 7, S2 1, CR 10.
    expect(machine.mem[fcb + 12]).toBe(7);
    expect(machine.mem[fcb + 14]).toBe(1);
    expect(machine.mem[fcb + 32]).toBe(10);
    expect(machine.mem[fcb + 33] | (machine.mem[fcb + 34] << 8)).toBe(5002);
  });

  it('F_OPEN keeps the requested extent and CR', async () => {
    const { machine } = boot();
    const data = new Uint8Array(40 * 1024);
    data[0] = 0x11;
    data[16384 + 3 * 128] = 0x77;
    machine.disk.put('BIG', 'DAT', data);
    await run(machine, [
      0x3e, 0x01, 0x32, 0x68, 0x00, // EX = 1
      0x3e, 0x03, 0x32, 0x7c, 0x00, // CR = 3
      ...bdos(15, 0x5c),
      0x32, 0x00, 0x20, // (2000h) = open result
      0x3a, 0x6b, 0x00, 0x32, 0x01, 0x20, // (2001h) = RC
      ...bdos(20, 0x5c),
      0x3a, 0x80, 0x00, 0x32, 0x02, 0x20, // (2002h) = data
      0x3e, 0x05, 0x32, 0x68, 0x00, // EX = 5: no such extent
      ...bdos(15, 0x5c),
      0x32, 0x03, 0x20,
      0xc9,
    ], 'PROBE BIG.DAT');
    expect(machine.mem[0x2000]).toBe(0);
    expect(machine.mem[0x2001]).toBe(128); // extent 1 is full: 40K spans extents 0-2
    expect(machine.mem[0x2002]).toBe(0x77);
    expect(machine.mem[0x2003]).toBe(0xff);
  });
  it('BDOS 13 resets the DMA address to 0080h', async () => {
    const { machine } = boot();
    await run(machine, [...bdos(26, 0x1000), ...bdos(13, 0), 0xc9]);
    expect(machine.bdos.dma).toBe(0x80);
  });

  it('^S pauses console output and ^C during the pause warm boots', async () => {
    const { machine, con } = boot();
    machine.mem.set([...'ABCDEFGH'].map((c) => c.charCodeAt(0)), 0x2000);
    machine.mem[0x2008] = 0x24;
    con.queue.push(0x13, 0x51, 0x58); // ^S, Q resumes, X stays for the program
    await run(machine, [...bdos(9, 0x2000), ...bdos(1, 0), 0x32, 0x00, 0x30, 0xc9]);
    expect(con.output).toContain('ABCDEFGH');
    expect(machine.mem[0x3000]).toBe(0x58);

    const second = boot();
    second.machine.mem.set([...'ABCDEFGH'].map((c) => c.charCodeAt(0)), 0x2000);
    second.machine.mem[0x2008] = 0x24;
    second.con.queue.push(0x13, 0x03);
    second.machine.mem[0x3000] = 0;
    await run(second.machine, [...bdos(9, 0x2000), 0x3e, 0x01, 0x32, 0x00, 0x30, 0xc9]);
    expect(second.con.output).not.toContain('ABCDEFGH');
    expect(second.machine.mem[0x3000]).toBe(0); // the program never ran on
  });

  it('BDOS 10 returns when the buffer is full and accepts LF and TAB', async () => {
    const { machine, con } = boot();
    con.feed('ABCDE\r');
    machine.mem[0x2000] = 3;
    await run(machine, [...bdos(10, 0x2000), 0xc9]);
    expect(machine.mem[0x2001]).toBe(3);
    expect(String.fromCharCode(...machine.mem.subarray(0x2002, 0x2005))).toBe('ABC');
    expect(con.queue.map((c) => String.fromCharCode(c)).join('')).toBe('DE\r');

    const second = boot();
    second.con.queue.push(0x41, 0x09, 0x42, 0x0a);
    second.machine.mem[0x2000] = 10;
    await run(second.machine, [...bdos(10, 0x2000), 0xc9]);
    expect(second.machine.mem[0x2001]).toBe(3);
    expect([...second.machine.mem.subarray(0x2002, 0x2005)]).toEqual([0x41, 0x09, 0x42]);
    expect(second.con.output).toContain('A       B');
  });

  it('COLOR prints the palette as SGR sequences', async () => {
    const { machine, con } = boot();
    await machine.ccp.execute('COLOR');
    expect(con.output).toContain('\x1b[31m');
    expect(con.output).toContain('\x1b[107m');
    expect(con.output).toContain('\x1b[48;5;16m');
    expect(con.output).toContain('\x1b[48;2;0;255;120m');
    expect(con.output).toContain('\x1b[0m');
  });

  it('TETRIS plays: pieces lock, full rows clear, Q quits', async () => {
    const { machine, con } = boot();
    const tetris = machine.disk.find(0, 'TETRIS  ', 'COM')!;
    // SEED (DW 4D2BH) is the last initialised byte pair; BOARD follows it.
    let seedAt = tetris.data.length - 2;
    while (seedAt > 0 && !(tetris.data[seedAt] === 0x2b && tetris.data[seedAt + 1] === 0x4d)) seedAt--;
    expect(seedAt).toBeGreaterThan(0);
    const board = 0x100 + seedAt + 2;
    // Deliver keys by poll count: start, fill the bottom four rows while the
    // first piece falls, hard drop, then quit.
    let polls = 0;
    con.pollByte = () => {
      polls++;
      if (polls === 5) return 0x20;
      if (polls === 9) machine.mem.fill(1, board + 160, board + 200);
      if (polls === 12) return 0x20;
      if (polls === 100) return 0x71;
      return undefined;
    };
    let reads = 0;
    machine.now = () => 1_700_000_000_000 + Math.floor(reads++ / 16) * 1000; // 16 ticks a second
    await machine.runCom(tetris, 'TETRIS');
    expect(con.output).toContain('T E T R I S');
    expect(con.output).toContain('\x1b[5;59H00004'); // Lines field after the tetris
    expect(con.output).toContain('Thanks for playing.');
    expect(machine.mem.subarray(board + 160, board + 200).every((v) => v === 0)).toBe(false); // piece shifted down
    expect(machine.mem.subarray(board, board + 160).every((v) => v === 0)).toBe(true);
  });

  it('T_GET returns the seconds in A as BCD, like CP/M 3', async () => {
    const { machine } = boot();
    machine.now = () => Date.UTC(2026, 9, 21, 12, 34, 56) + new Date().getTimezoneOffset() * 60_000;
    await run(machine, [...bdos(105, 0x2000), 0x32, 0x10, 0x20, 0xc9]);
    expect(machine.mem[0x2010]).toBe(0x56);
  });

  it('TETRIS re-tunes its tick loop to 16 ticks per clock second', async () => {
    // Each run plays 80 ticks; the fake clock advances one second every
    // `perSecond` ticks, so the game sees that many ticks per second and
    // scales its delay loop by perSecond/16 at every edge.
    async function play(perSecond: number): Promise<number> {
      const { machine, con } = boot();
      const tetris = machine.disk.find(0, 'TETRIS  ', 'COM')!;
      let reads = 0;
      machine.now = () => 1_700_000_000_000 + Math.floor(reads++ / perSecond) * 1000;
      let polls = 0;
      con.pollByte = () => {
        polls++;
        if (polls === 2) return 0x20;
        if (polls === 80) return 0x71;
        return undefined;
      };
      const before = machine.cpu.cycles;
      await machine.runCom(tetris, 'TETRIS');
      return machine.cpu.cycles - before;
    }
    const slow = await play(8); // only 8 ticks a second: the loop must halve
    const right = await play(16);
    const fast = await play(32); // 32 ticks a second: the loop must double
    expect(slow).toBeLessThan(right * 0.7);
    expect(fast).toBeGreaterThan(right * 1.4);
  });
});

describe('telnet modem', () => {
  async function run(machine: CpmMachine, code: number[]): Promise<void> {
    const f = machine.disk.put('PROBE', 'COM', new Uint8Array(code));
    await machine.runCom(f!, 'PROBE');
  }

  /** A line that answers at once and sends `greeting`. */
  function fakeLine(machine: CpmMachine, greeting: number[], afterGreeting?: () => void) {
    const line = { sent: [] as number[], closed: false, calls: [] as string[] };
    machine.modem.dialer = ({ host, port }, h) => {
      line.calls.push(`${host}:${port}`);
      queueMicrotask(() => {
        h.onOpen();
        h.onData(Uint8Array.from(greeting));
        afterGreeting?.();
      });
      return { send: (b) => line.sent.push(...b), close: () => { line.closed = true; } };
    };
    return line;
  }

  it('is a UART on ports 04h/05h; other ports read FFh', async () => {
    const { machine } = boot();
    await run(machine, [
      0x3e, 0x41, 0xd3, 0x05, 0x3e, 0x54, 0xd3, 0x05, 0x3e, 0x0d, 0xd3, 0x05, // "AT\r"
      0x21, 0x00, 0x02, // LXI H,0200h
      0xdb, 0x04, 0xe6, 0x01, 0xca, 0x1d, 0x01, // IN 04h / ANI 1 / JZ done
      0xdb, 0x05, 0x77, 0x23, 0xc3, 0x0f, 0x01, // IN 05h / MOV M,A / INX H / JMP
      0xdb, 0x07, 0x32, 0x00, 0x03, 0xc9, // done: IN 07h / STA 0300h / RET
    ]);
    const got = String.fromCharCode(...machine.mem.slice(0x200, 0x20a));
    expect(got).toBe('AT\r\n\r\nOK\r\n');
    expect(machine.mem[0x300]).toBe(0xff);
  });

  it('PUNCH and READER (BDOS 4 and 3) go through the modem', async () => {
    const { machine } = boot();
    const CALL5 = [0xcd, 0x05, 0x00];
    const punch = (c: number) => [0x0e, 0x04, 0x1e, c, ...CALL5];
    await run(machine, [
      ...punch(0x41), ...punch(0x54), ...punch(0x0d),
      0x0e, 0x03, ...CALL5, 0x32, 0x00, 0x02, // A_READ -> 0200h
      0x0e, 0x03, ...CALL5, 0x32, 0x01, 0x02, // A_READ -> 0201h
      0xc9,
    ]);
    expect(machine.mem[0x200]).toBe(0x41); // the modem echoed "AT"
    expect(machine.mem[0x201]).toBe(0x54);
    expect(machine.bdos.serialLog).toEqual([0x41, 0x54, 0x0d]);
  });

  it('READER returns ^Z with no carrier and nothing waiting', async () => {
    const { machine } = boot();
    await run(machine, [0x0e, 0x03, 0xcd, 0x05, 0x00, 0x32, 0x00, 0x02, 0xc9]);
    expect(machine.mem[0x200]).toBe(0x1a);
  });

  it('TERM.COM dials, shows the BBS, answers telnet and leaves the call up on ^]', async () => {
    const { machine, con } = boot();
    const line = fakeLine(
      machine,
      [...'Welcome!\r\n'].map((c) => c.charCodeAt(0)).concat([255, 253, 24, 0xfe]),
      () => con.feed('\x1d'),
    );
    con.feed('ATDT1\r');
    await machine.runCom(machine.disk.find(0, 'TERM    ', 'COM')!, 'TERM');
    expect(line.calls).toEqual(['vert.synchro.net:23']);
    expect(con.output).toContain('ATDT1');
    expect(con.output).toContain('CONNECT');
    expect(con.output).toContain('Welcome!');
    expect(con.output).toContain('TERM done. The call stays up');
    // BINARY both ways, then WILL TERMINAL-TYPE.
    expect(line.sent).toEqual([255, 251, 0, 255, 253, 0, 255, 251, 24]);
    expect(line.closed).toBe(false);
    expect(machine.modem.online).toBe(true);

    con.output = '';
    con.feed('\x1d');
    await machine.runCom(machine.disk.find(0, 'TERM    ', 'COM')!, 'TERM');
    expect(con.output).toContain('Still connected.');
  });

  it('TERM.COM says which command to run when the BBS starts ZMODEM', async () => {
    const zrqinit = [...'rz\r**\x18B00000000000000\r\x8a\x11'].map((c) => c.charCodeAt(0));
    for (const [bytes, hint] of [
      [zrqinit, 'ZMODEM download - press Ctrl-] then ZMODEM R'],
      [[...'**\x18B0100000023be50\r\x8a'].map((c) => c.charCodeAt(0)), 'ZMODEM upload'],
    ] as const) {
      const { machine, con } = boot();
      fakeLine(machine, [...bytes, ...bytes], () => con.feed('\x1d'));
      con.feed('ATDT1\r');
      await machine.runCom(machine.disk.find(0, 'TERM    ', 'COM')!, 'TERM');
      expect(con.output).toContain(hint);
      expect(con.output.split(hint).length).toBe(2); // once, not per header
    }
  });
});
