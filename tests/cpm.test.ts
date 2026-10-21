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

  async readByte(): Promise<number> {
    return this.queue.shift() ?? 0x1a;
  }

  pollByte(): number | undefined {
    return this.queue.shift();
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
