// The AI board end to end with a fake DeepSeek: key prompt, chat, and a
// program whose first version fails to assemble, gets fixed, arrives by
// ZMODEM in the emulator and runs.
import { describe, expect, it } from 'vitest';
import { CpmMachine } from '../src/cpm/machine';
import { BUILTIN_FILES } from '../src/assets/builtin-programs';
import type { ConsoleIO } from '../src/console';
import { createAiBoard } from '../src/aiboard';
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
});
