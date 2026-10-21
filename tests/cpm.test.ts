import { describe, expect, it } from 'vitest';
import { CpmMachine } from '../src/cpm/machine';
import { BUILTIN_FILES } from '../src/assets/builtin-programs';
import type { ConsoleIO } from '../src/console';
import { displayName } from '../src/cpm/disk';

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
});
