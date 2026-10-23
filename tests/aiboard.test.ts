// The AI board end to end with a fake DeepSeek: key prompt, chat, and a
// program whose first version fails to assemble, gets fixed, arrives by
// ZMODEM in the emulator and runs.
import { describe, expect, it } from 'vitest';
import { CpmMachine } from '../src/cpm/machine';
import { BUILTIN_FILES } from '../src/assets/builtin-programs';
import type { ConsoleIO } from '../src/console';
import { BOFH_PICKUP, FIX_PROMPT, createAiBoard, programName, sourceText } from '../src/aiboard';
import { assemble } from '../src/cpm/assembler';
import type { ChatOptions, ChatChunk } from '../src/deepseek';

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

const BROKEN = '```asm\n\tORG\t100H\nSTART:\tLD\tA,1\n\tEND\tSTART\n```';
const FIXED = [
  '\tORG\t100H',
  'START:\tMVI\tC,9',
  '\tLXI\tD,MSG',
  '\tCALL\t5',
  '\tJMP\t0',
  "MSG:\tDB\t'Hello from the AI board',13,10,'$'",
  '\tEND\tSTART',
].join('\n');

function setup(initialKey: string | null) {
  const con = new Con();
  const machine = new CpmMachine(con);
  machine.yieldFn = () => new Promise((r) => setImmediate(r));
  for (const f of BUILTIN_FILES) machine.disk.put(f.name, f.ext, Uint8Array.from(Buffer.from(f.data, 'base64')));
  let key = initialKey;
  const calls: ChatOptions[] = [];
  const answers: ChatChunk[][] = [];
  machine.modem.dialer = (_t, handlers) => createAiBoard(handlers, {
    getKey: () => key,
    setKey: (k) => { key = k; },
    chat: (opts) => {
      calls.push(opts);
      const reply = answers.shift() ?? [{ kind: 'text', text: '(no answer)' }];
      return (async function* () { for (const c of reply) yield c; })();
    },
    assemble: (name, source) => assemble(name, source),
    schedule: (fn) => { setTimeout(fn, 0); },
    cps: 0,
  });
  let screen = '';
  const drain = () => { while (machine.modem.available) screen += String.fromCharCode(machine.modem.read()); return screen; };
  const type = (s: string) => { for (const c of s) machine.modem.write(c.charCodeAt(0)); };
  const waitFor = async (text: string) => {
    for (let i = 0; i < 400; i++) {
      if (drain().includes(text)) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`timed out waiting for ${JSON.stringify(text)}; screen:\n${screen}`);
  };
  return { machine, con, type, waitFor, calls, answers, getKey: () => key, screen: () => drain() };
}

describe('AI board', () => {
  it('asks for a key, then chats', async () => {
    const b = setup(null);
    b.type('ATDT DEEPSEEK\r');
    await b.waitFor('CONNECT AI');
    await b.waitFor('Key: ');
    b.type('sk-test-123456\r');
    await b.waitFor('Choice: ');
    expect(b.getKey()).toBe('sk-test-123456');
    expect(b.screen()).toContain('**************'); // the key is not echoed
    expect(b.screen()).toContain('sk-...3456');

    b.answers.push([{ kind: 'text', text: 'Hi there, caller! Welcome to the board.' }]);
    b.type('C');
    await b.waitFor('You> ');
    b.type('hello\r');
    await b.waitFor('AI> Hi there, caller! Welcome to the board.');
    expect(b.calls[0].thinking).toBe(false);
    expect(b.calls[0].messages.at(-1)).toEqual({ role: 'user', content: 'hello' });
    expect(b.calls[0].key).toBe('sk-test-123456');
    b.type('/menu\r');
    await b.waitFor('[G] Goodbye');
    b.type('G');
    await b.waitFor('NO CARRIER');
  });

  it('puts you through to the BOFH, who may hang up on you', async () => {
    const b = setup('sk-test');
    b.type('ATDT DEEPSEEK\r');
    await b.waitFor('Choice: ');
    expect(b.screen()).toContain('[B] Chat with the Bastard Operator From Hell');
    b.answers.push([{ kind: 'text', text: '(click) Machine room. What.' }]);
    b.answers.push([{ kind: 'text', text: 'Your password? Of course. Spell it slowly.' }]);
    b.answers.push([
      { kind: 'text', text: 'Solar flares on your RS-232 line. Goodbye.\n[HAN' },
      { kind: 'text', text: 'GUP]' },
    ]);
    b.type('B');
    // He picks up before the caller says anything.
    await b.waitFor('BOFH> (click) Machine room. What.');
    expect(b.calls[0].messages[0].content).toContain('Bastard Operator From Hell');
    expect(b.calls[0].messages[0].content).toContain('PFY');
    expect(b.calls[0].messages.at(-1)).toEqual({ role: 'user', content: BOFH_PICKUP });
    await b.waitFor('You> ');
    b.type('I forgot my password\r');
    await b.waitFor('BOFH> Your password? Of course. Spell it slowly.');
    b.type('it still does not work\r');
    await b.waitFor('NO CARRIER');
    const screen = b.screen();
    expect(screen).toContain('BOFH> Solar flares on your RS-232 line. Goodbye.');
    expect(screen).toContain('*click*');
    expect(screen).not.toContain('HANGUP');
    expect(screen).not.toContain('[HAN');
    expect(b.machine.modem.online).toBe(false);
  });

  it('the friendly sysop cannot hang up, and has a separate history', async () => {
    const b = setup('sk-test');
    b.type('ATDT DEEPSEEK\r');
    await b.waitFor('Choice: ');
    b.answers.push([{ kind: 'text', text: 'Grr.' }]);
    b.answers.push([{ kind: 'text', text: 'Hello! [HANGUP] is just text here.' }]);
    b.type('B');
    await b.waitFor('BOFH> Grr.');
    await b.waitFor('You> ');
    b.type('/menu\r');
    await b.waitFor('[G] Goodbye');
    b.type('C');
    await b.waitFor('Chat mode');
    b.type('hello\r');
    await b.waitFor('AI> Hello! [HANGUP] is just text here.');
    expect(b.machine.modem.online).toBe(true);
    expect(b.calls.length).toBe(2);
    expect(b.calls[1].messages).toEqual([
      expect.objectContaining({ role: 'system' }),
      { role: 'user', content: 'hello' },
    ]);
  });

  it('writes a program, fixes its assembly errors and sends it by ZMODEM', async () => {
    const b = setup('sk-test');
    b.type('ATDT AI\r');
    await b.waitFor('Choice: ');
    b.answers.push([{ kind: 'thinking', text: 'plan' }, { kind: 'text', text: BROKEN }]);
    b.answers.push([{ kind: 'text', text: FIXED }]);
    b.type('P');
    await b.waitFor('Program: ');
    b.type('say hello\r');
    await b.waitFor('Name');
    b.type('hello2\r');
    await b.waitFor('by ZMODEM now');
    expect(b.screen()).toContain('Sending them back for a fix (try 2 of 3)');
    expect(b.calls[0].thinking).toBe(true);
    expect(b.calls[1].messages.at(-1)!.content).toMatch(/^ASM 2\.0 reported these errors/);
    expect(b.screen()).toContain('Sending HELLO2.ASM and HELLO2.COM');

    await b.machine.runCom(b.machine.disk.find(0, 'ZMODEM  ', 'COM')!, 'ZMODEM R');
    expect(b.con.output).toContain('Transfer complete');
    const asm = b.machine.disk.find(0, 'HELLO2  ', 'ASM')!;
    expect(String.fromCharCode(...asm.data)).toContain("DB\t'Hello from the AI board'");

    b.con.output = '';
    await b.machine.runCom(b.machine.disk.find(0, 'HELLO2  ', 'COM')!, 'HELLO2');
    expect(b.con.output).toContain('Hello from the AI board');
    await b.waitFor('Run HELLO2 at the A> prompt.');
  }, 30_000);

  it('treats an answer with no source (all thinking) as a failed try', async () => {
    const b = setup('sk-test');
    b.type('ATDT AI\r');
    await b.waitFor('Choice: ');
    b.answers.push([{ kind: 'thinking', text: 'a very long think' }]); // no text at all
    b.answers.push([{ kind: 'text', text: FIXED }]);
    b.type('P');
    await b.waitFor('Program: ');
    b.type('say hello\r');
    await b.waitFor('Name');
    b.type('hello3\r');
    await b.waitFor('by ZMODEM now');
    expect(b.screen()).toContain('No source came back');
    expect(b.calls.length).toBe(2);
    expect(b.screen()).not.toContain('is 0 bytes');
    expect(b.screen()).toContain('Sending HELLO3.ASM and HELLO3.COM');
  }, 30_000);

  it('takes an uploaded .ASM by ZMODEM, has it fixed and sends it back', async () => {
    const b = setup('sk-test');
    // The caller's program, as CP/M stores it: CR LF, ^Z, padded to a record.
    const mine = "; my greeting\r\n\tORG\t100H\r\nSTART:\tLD\tC,9\r\n\tLXI\tD,MSG\r\n\tCALL\t5\r\n\tJMP\t0\r\nMSG:\tDB\t'Hi$'\r\n\tEND\tSTART\r\n\x1a";
    const padded = new Uint8Array(Math.ceil(mine.length / 128) * 128).fill(0x1a);
    padded.set(Uint8Array.from(mine, (c) => c.charCodeAt(0)));
    b.machine.disk.put('GREET', 'ASM', padded);

    b.type('ATDT AI\r');
    await b.waitFor('Choice: ');
    expect(b.screen()).toContain('[F] Fix my program');
    b.type('F');
    await b.waitFor('ZMODEM S NAME.ASM');
    await b.waitFor('**\x18B01'); // ZRINIT: TERM would say "ZMODEM upload"
    await b.machine.runCom(b.machine.disk.find(0, 'ZMODEM  ', 'COM')!, 'ZMODEM S GREET.ASM');
    expect(b.con.output).toContain('Transfer complete');
    await b.waitFor('Fix: ');
    expect(b.screen()).toContain('Got GREET.ASM, 8 lines. Assembling it as it is... 1 error:');
    expect(b.screen()).toMatch(/ {2}[A-Z]\s.*LD\tC,9/); // ASM's error line, shown

    b.answers.push([{ kind: 'text', text: FIXED }]);
    b.type('make it say Hello from the AI board\r');
    await b.waitFor('by ZMODEM now');
    expect(b.calls.length).toBe(1);
    expect(b.calls[0].thinking).toBe(true);
    expect(b.calls[0].messages[0]).toEqual({ role: 'system', content: FIX_PROMPT });
    expect(FIX_PROMPT).toContain('Never Z80 mnemonics'); // the ASM rules stay
    const ask = b.calls[0].messages[1].content;
    expect(ask).toContain("Here is GREET.ASM:\n\n; my greeting\n\tORG\t100H\nSTART:\tLD\tC,9\n");
    expect(ask).not.toMatch(/[\r\x1a]/);
    expect(ask).toMatch(/ASM 2\.0 reported these errors.*\n[A-Z] .*LD\tC,9/s);
    expect(ask).toContain('The caller says: make it say Hello from the AI board');
    expect(b.screen()).toContain('Sending GREET.ASM and GREET.COM');
    expect(b.screen()).toContain('REN it first');

    await b.machine.runCom(b.machine.disk.find(0, 'ZMODEM  ', 'COM')!, 'ZMODEM R');
    const asm = String.fromCharCode(...b.machine.disk.find(0, 'GREET   ', 'ASM')!.data);
    expect(asm).toContain("DB\t'Hello from the AI board'");
    b.con.output = '';
    await b.machine.runCom(b.machine.disk.find(0, 'GREET   ', 'COM')!, 'GREET');
    expect(b.con.output).toContain('Hello from the AI board');
    await b.waitFor('Run GREET at the A> prompt.');
  }, 30_000);

  it('refuses uploads that are not .ASM text, and ESC gives up waiting', async () => {
    const b = setup('sk-test');
    b.type('ATDT AI\r');
    await b.waitFor('Choice: ');
    b.type('F');
    await b.waitFor('**\x18B01');
    b.type('\x1b');
    await b.waitFor('No upload: cancelled.');
    await b.waitFor('Choice: ');

    b.machine.disk.put('PIC', 'BIN', Uint8Array.from([1, 2, 3]));
    b.machine.disk.put('BIN', 'ASM', Uint8Array.from([0x09, 0x4f, 0x52, 0x47, 0x00, 0xc3, 0x1a]));
    b.type('F');
    await b.waitFor('**\x18B01');
    await b.machine.runCom(b.machine.disk.find(0, 'ZMODEM  ', 'COM')!, 'ZMODEM S PIC.BIN');
    await b.waitFor('PIC.BIN is not a .ASM file.');
    await b.waitFor('Choice: ');
    b.type('F');
    await b.waitFor('ESC gives up');
    await b.machine.runCom(b.machine.disk.find(0, 'ZMODEM  ', 'COM')!, 'ZMODEM S BIN.ASM');
    await b.waitFor('BIN.ASM is not a text file.');
    expect(b.calls.length).toBe(0);
    expect(b.machine.modem.online).toBe(true);
  }, 30_000);

  it('reads uploaded sources as CP/M text', () => {
    expect(sourceText(Uint8Array.from('A\r\nB\r\n\x1aJUNK\x00', (c) => c.charCodeAt(0)))).toBe('A\nB\n');
    expect(sourceText(Uint8Array.from([0x41, 0x00, 0x42]))).toBeUndefined();
    expect(programName('greet.asm')).toBe('GREET');
    expect(programName('my-prog.asm')).toBe('MYPROG');
    expect(programName('1st.ASM')).toBe('X1ST');
    expect(programName('notes.txt')).toBeUndefined();
  });
});
