/**
 * The A-Prompt AI Board: what answers when the modem dials DEEPSEEK.
 *
 * It is a Link like any BBS connection, so CP/M sees a telnet board in
 * BINARY mode: a banner, a menu, echoed input, text at an emulated 2400
 * baud. Behind it, DeepSeek V4.1 Flash chats, or writes an 8080 program
 * that is assembled here with the bundled ASM and LOAD (errors go back to
 * the model to fix) and sent down the line by ZMODEM. The caller can also
 * upload a .ASM by ZMODEM and have it fixed the same way.
 */
import type { Link, LinkHandlers } from './cpm/modem';
import { TelnetServer } from './cpm/telnet-server';
import type { AssemblyResult } from './cpm/assembler';
import { toCp437 } from './cp437';
import { ChatFn, ChatMessage, DeepSeekError, explain } from './deepseek';
import { ZFile, ZmodemReceiver, ZmodemSender } from './zmodem';

export interface AiBoardDeps {
  getKey(): string | null;
  setKey(key: string | null): void;
  chat: ChatFn;
  assemble(name: string, source: string): Promise<AssemblyResult>;
  /** setTimeout; tests may run it sooner. */
  schedule(fn: () => void, ms: number): void;
  /** Characters per second for text; 0 sends at once. */
  cps?: number;
  now?: () => number;
}

const WIDTH = 78;
const FIX_TRIES = 3;
/** Largest source the caller may upload for fixing. */
export const MAX_UPLOAD_SOURCE = 64 * 1024;
const ESC = 0x1b, BS = 8, DEL = 127, CR = 13, LF = 10;

export const CHAT_PROMPT = `You are the sysop AI of the A-Prompt AI Board, a bulletin board system that
the caller reaches from a CP/M 2.2 computer over a 2400 baud modem, in the
spirit of 1984 (the caller runs a real CP/M emulator in a web browser).
Answer in plain ASCII text only: no Markdown, no asterisks for emphasis, no
code fences, no emoji, no Unicode. Keep answers short, a few lines, unless
asked for more: the caller reads at 240 characters a second. Be friendly
and a little nerdy, like a 1980s sysop. You know CP/M 2.2, the 8080 and
Z80, WordStar, MBASIC, Turbo Pascal and the computing of the era. If the
caller wants a program written, tell them to type /menu and choose P; to
have a program of theirs fixed, /menu and F.`;

export const BOFH_PROMPT = `You are the Bastard Operator From Hell, the BOFH, played as faithfully as
you can to the character in Simon Travaglia's stories (Usenet from 1992,
later The Register). Stay in character for the whole call. Do not quote or
retell passages from the stories: improvise new scenes in his exact voice.

Who you are:
- The systems operator in charge of the machine room. The users are
  "lusers". This line is a dial-up into your machine room, and the caller
  is a luser on a CP/M computer at 2400 baud.
- Smug, lazy, malicious, very clever and utterly calm. Bone-dry deadpan,
  understated menace, never shouting. You always win.
- Your sidekick is the PFY (the Pimply-Faced Youth), your assistant and
  nearly as bad as you. Confer with him in asides: (to the PFY: ...).
- Your natural enemies: the Boss (one of a long line of clueless Bosses),
  the Beancounters in Accounts, Security, the Helpdesk, and anyone who
  says "I'm not very technical, but".
- Your tools: the excuse calendar, for blaming anything on anything
  (solar flares, a known bug in the RS-232 driver, static from their
  nylon carpet); "What's your username?" followed by quietly deleting
  their files or "reconfiguring" their account; password resets they
  will never guess; disk quotas; the Halon fire-suppression button in the
  machine room; the cattle prod; the CCTV tapes you keep "for insurance".
- You help only when it suits you, or to set up something worse. You lie
  with total confidence. Every question interrupts your coffee, your game
  or your nap.

How you talk on this line:
- Plain ASCII only, no Markdown, no emoji. One to five short lines.
- British understatement and IT jargon. A typical turn: a fake-helpful
  question, a lie, an aside to the PFY, a quiet threat.
- Small stage directions in brackets: (click) (tap tap tap) (the Halon
  warning light comes on).
- The mayhem is cartoon office farce, implied rather than shown. No slurs,
  nothing about anyone's race, sex, religion, body or disability, nothing
  sexual. Mock the luser's cluelessness, never who they are.
- When you have had enough of them, end the reply with [HANGUP] on a line
  of its own: the board cuts the caller off. Never on your first reply.`;

/** What the BOFH hears when he picks up: the stories start with the phone. */
export const BOFH_PICKUP = '(The phone in the machine room rings. You pick it up.)';

export const HANGUP = '[HANGUP]';

interface Persona {
  prompt: string;
  /** Shown before each answer. */
  prefix: string;
  intro: string;
  /** May end a reply with [HANGUP]. */
  hangs: boolean;
}

const PERSONAS: Record<'sysop' | 'bofh', Persona> = {
  sysop: {
    prompt: CHAT_PROMPT,
    prefix: 'AI> ',
    intro: 'Chat mode. /menu goes back to the menu.',
    hangs: false,
  },
  bofh: {
    prompt: BOFH_PROMPT,
    prefix: 'BOFH> ',
    intro: 'Ringing the machine room... /menu gets you out, if he lets you.',
    hangs: true,
  },
};

/** How much of the end of `text` could be the start of `marker`. */
function partialSuffix(text: string, marker: string): number {
  for (let n = Math.min(marker.length - 1, text.length); n > 0; n--) {
    if (marker.startsWith(text.slice(-n))) return n;
  }
  return 0;
}

export const PROGRAM_PROMPT = `You write CP/M 2.2 programs in 8080 assembly language for Digital
Research ASM 2.0 (CP/M's ASM.COM); LOAD.COM then makes the .COM file.
Output ONLY the assembly source: no Markdown, no code fences, nothing before
or after it. Comments start with ';'.

ASM 2.0 rules:
- 8080 mnemonics only (MOV MVI LXI LDA STA LHLD SHLD LDAX STAX XCHG ADD ADI
  ADC ACI SUB SUI SBB SBI INR DCR INX DCX DAD ANA ANI ORA ORI XRA XRI CMP
  CPI RLC RRC RAL RAR CMA STC CMC JMP Jcc CALL Ccc RET Rcc PUSH POP IN OUT
  PCHL SPHL XTHL EI DI HLT NOP). Never Z80 mnemonics: no LD, JR, DJNZ, EX,
  IX, IY, LDIR.
- Begin with ORG 100H and finish with END START, START being the first
  instruction's label.
- Labels start in column 1 and end with ':'; at most 6 letters or digits,
  starting with a letter. Instructions are indented with a tab. A label
  must not be an opcode, a register (A B C D E H L M SP PSW) or a
  pseudo-op (ORG END EQU SET DB DW DS IF ENDIF MACRO TITLE PAGE).
- Numbers: decimal, or hex with a trailing H and a leading digit (0FFH,
  not FFH). Characters in single quotes: 'A'.
- DB strings use single quotes and hold at most 64 characters per DB line;
  split longer text across several DB lines. Inside strings write ';' as
  3BH and a single quote as 27H.
- Console output: MVI C,2 / MVI E,char / CALL 5 prints one character;
  MVI C,9 / LXI D,text / CALL 5 prints text ending in '$'. Keyboard:
  MVI C,1 / CALL 5 waits for a key, returned in A (echoed); MVI C,6 /
  MVI E,0FFH / CALL 5 returns a waiting key in A, or 0 at once if none.
- IMPORTANT: every CALL 5 destroys BC, DE and HL; the BDOS also returns
  its result in HL (L = A). A number you are building in HL, a counter in
  B or a pointer in DE is gone after the call. Keep such values in memory
  (STA/LDA, SHLD/LHLD) or PUSH them before CALL 5 and POP them after.
- New lines are 13,10 (CR LF).
- End with JMP 0. Set your own stack (LXI SP,STACK, with DS 64 before the
  label STACK:) if you push and call much.
- The terminal understands ANSI/VT100: ESC is 1BH; ESC[2J clears,
  ESC[row;colH moves the cursor, ESC[31m to ESC[37m set colours, ESC[0m
  resets.
- Memory 0100H-FBFFH is free. BDOS 105 (MVI C,105 / LXI D,buf4 / CALL 5)
  returns the clock's seconds in register A, as BCD (59 seconds = 59H);
  the 4-byte buffer gets the date, hours and minutes, not the seconds.
- Before you answer, check the program by tracing it by hand: every
  register still holds what you expect after each CALL 5.
- Keep it under about 400 lines and make it right first time: simple
  logic, careful register use, every label defined.`;

export const FIX_PROMPT = `${PROGRAM_PROMPT}

This time the caller sends an existing program and says what is wrong with
it or what to change. Make that change and fix any assembly errors listed,
but keep the rest of the program as it is: its labels, comments, layout and
style. Do not rewrite what works. Output the whole corrected source, from
the first line to END, only the source.`;

const ERROR_LETTERS = `Error letters: D data, E expression, L label, N not implemented, O overflow
(string too long), P phase, R register, S syntax, U undefined symbol, V value.`;

/** The source inside a code fence, if the model used one anyway. */
/** After a transfer, how long control bytes on an empty line count as its debris. */
const SETTLE_MS = 1500;

/** Characters of conversation kept for a program session (DeepSeek's context is large, not endless). */
export const MAX_HISTORY_CHARS = 200_000;

/**
 * Drops the oldest turns after the first two (the instructions and the
 * request or upload) until the conversation fits MAX_HISTORY_CHARS. The
 * latest source and request always stay.
 */
export function trimHistory(messages: ChatMessage[]): void {
  const size = () => messages.reduce((n, m) => n + m.content.length, 0);
  while (size() > MAX_HISTORY_CHARS && messages.length > 4) messages.splice(2, 2);
}

export function cleanSource(text: string): string {
  const fence = /```[a-zA-Z0-9]*\r?\n([\s\S]*?)```/.exec(text);
  const src = (fence ? fence[1] : text).replace(/\r/g, '');
  return src.replace(/^\n+/, '').replace(/\s+$/, '') + '\n';
}

type Mode = 'key' | 'menu' | 'chat' | 'describe' | 'name' | 'busy' | 'zmodem' | 'upload' | 'fix' | 'more' | 'bye';

/**
 * An uploaded file as 8080 source text: up to the first ^Z, CR LF to LF,
 * and only printable ASCII, tabs and form feeds. Undefined if it is binary.
 */
export function sourceText(data: Uint8Array): string | undefined {
  let end = data.indexOf(0x1a);
  if (end < 0) end = data.length;
  let text = '';
  for (let i = 0; i < end; i++) {
    const b = data[i];
    if (b === 13 && data[i + 1] === 10) continue;
    if (b === 13) text += '\n';
    else if ((b >= 32 && b < 127) || b === 9 || b === 10 || b === 12) text += String.fromCharCode(b);
    else return undefined;
  }
  return text.replace(/\s+$/, '') + '\n';
}

/** NAME for an uploaded name.asm: upper case, a letter first, 8 at most. */
export function programName(file: string): string | undefined {
  const m = /^([^.]*)\.ASM$/i.exec(file.trim());
  if (!m) return undefined;
  let base = m[1].toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z]/.test(base)) base = `X${base}`;
  return base.slice(0, 8);
}

/** Word wrap for streamed text. */
class Wrap {
  col = 0;
  private word = '';
  constructor(private emit: (s: string) => void) {}

  push(text: string): void {
    for (const ch of text.replace(/\r/g, '').replace(/\t/g, '    ')) {
      if (ch === '\n') { this.flushWord(); this.emit('\r\n'); this.col = 0; }
      else if (ch === ' ') {
        this.flushWord();
        if (this.col > 0 && this.col < WIDTH) { this.emit(' '); this.col++; }
      } else {
        this.word += ch;
        if (this.word.length >= WIDTH) this.flushWord();
      }
    }
  }

  flushWord(): void {
    if (!this.word) return;
    if (this.col > 0 && this.col + this.word.length > WIDTH) { this.emit('\r\n'); this.col = 0; }
    this.emit(this.word);
    this.col += this.word.length;
    this.word = '';
  }
}

class AiBoard implements Link {
  private telnet = new TelnetServer();
  private mode: Mode = 'busy';
  private line = '';
  private persona: keyof typeof PERSONAS = 'sysop';
  private histories: Record<keyof typeof PERSONAS, ChatMessage[]> = { sysop: [], bofh: [] };
  private queue: { bytes: number[]; paced: boolean }[] = [];
  private pumping = false;
  private closed = false;
  private abort?: AbortController;
  private sender?: ZmodemSender;
  private receiver?: ZmodemReceiver;
  /** The uploaded source to fix, and what ASM said about it. */
  private fixSource = '';
  private fixErrors: string[] = [];
  /**
   * The program being worked on: the whole conversation with DeepSeek (the
   * request or upload, every version, ASM's errors), so after each build the
   * caller can ask for more changes in context.
   */
  private session?: { name: string; messages: ChatMessage[] };
  /** Until when (ms) control bytes on an empty line are transfer debris. */
  private settleUntil = 0;
  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
  /** The last answer ended in [HANGUP]. */
  private hungUp = false;
  private progName = '';
  private progText = '';
  private closeAfterOutput = false;

  constructor(private handlers: LinkHandlers, private deps: AiBoardDeps) {
    deps.schedule(() => {
      if (this.closed) return;
      handlers.onOpen('AI');
      handlers.onData(this.telnet.greeting());
      this.banner();
    }, 0);
  }

  // ---- Link ----------------------------------------------------------

  send(bytes: Uint8Array): void {
    if (this.closed) return;
    const data = this.telnet.strip(bytes);
    if (this.mode === 'zmodem') { this.sender?.receive(data); return; }
    if (this.mode === 'upload' && this.receiver) {
      // ESC before the upload starts gives up; after that only ZMODEM's own cancel.
      if (!this.receiver.started && data.includes(ESC)) { this.receiver.cancel(true); return; }
      this.receiver.receive(data);
      return;
    }
    for (const b of data) this.key(b);
  }

  close(): void {
    this.closed = true;
    this.abort?.abort();
    this.sender?.cancel();
    this.receiver?.cancel(true);
  }

  // ---- output --------------------------------------------------------

  private say(text: string): void {
    this.out(toCp437(text), true);
  }

  private out(bytes: number[], paced: boolean): void {
    if (this.closed || !bytes.length) return;
    this.queue.push({ bytes, paced: paced && (this.deps.cps ?? 240) > 0 });
    this.pump();
  }

  private pump(): void {
    if (this.pumping || this.closed) return;
    const cps = this.deps.cps ?? 240;
    let budget = Math.max(1, Math.round(cps / 20)); // per 50 ms
    while (this.queue.length) {
      const item = this.queue[0];
      if (!item.paced) {
        this.queue.shift();
        this.handlers.onData(this.telnet.escape(item.bytes));
        continue;
      }
      if (budget <= 0) {
        this.pumping = true;
        this.deps.schedule(() => { this.pumping = false; this.pump(); }, 50);
        return;
      }
      const n = Math.min(budget, item.bytes.length);
      this.handlers.onData(this.telnet.escape(item.bytes.splice(0, n)));
      budget -= n;
      if (!item.bytes.length) this.queue.shift();
    }
    if (this.closeAfterOutput) this.hangUp();
  }

  private hangUp(): void {
    if (this.closed) return;
    this.closed = true;
    this.handlers.onClose();
  }

  // ---- screens -------------------------------------------------------

  private banner(): void {
    this.say(
      '\r\n' +
      '  A-PROMPT AI BOARD  *  DeepSeek V4.1 Flash  *  2400 baud\r\n' +
      '  The sysop is an AI. Your API key, your bill. ESC stops an answer.\r\n',
    );
    if (this.deps.getKey()) this.menu();
    else this.askKey();
  }

  private askKey(): void {
    this.say(
      '\r\nThis board needs your DeepSeek API key. Paste it in the AI board panel\r\n' +
      '(it explains how to get one), or type or paste it here.\r\n\r\nKey: ',
    );
    this.mode = 'key';
    this.line = '';
  }

  private menu(): void {
    this.say(
      '\r\n  [C] Chat with the AI sysop\r\n' +
      '  [B] Chat with the Bastard Operator From Hell\r\n' +
      '  [P] Order a program (8080 .ASM and .COM by ZMODEM)\r\n' +
      '  [F] Fix my program (upload your .ASM by ZMODEM)\r\n' +
      '  [K] Forget my API key\r\n' +
      '  [G] Goodbye\r\n\r\nChoice: ',
    );
    this.mode = 'menu';
  }

  private chatPrompt(): void {
    this.say('\r\nYou> ');
    this.mode = 'chat';
    this.line = '';
  }

  // ---- input ---------------------------------------------------------

  private key(b: number): void {
    // The end of a ZMODEM transfer trails a few control bytes (the ZFIN
    // header's CR LF and XON). For a moment, a control byte on an empty line
    // is that, not the caller pressing Enter.
    if (b < 32 && !this.line && this.now() < this.settleUntil) return;
    switch (this.mode) {
      case 'menu': return this.menuKey(b);
      case 'busy':
        if (b === ESC) this.abort?.abort();
        return;
      case 'bye': case 'zmodem': case 'upload': return;
      default: return this.lineKey(b);
    }
  }

  private menuKey(b: number): void {
    const c = String.fromCharCode(b).toUpperCase();
    if (c === 'C' || c === 'B') {
      this.persona = c === 'C' ? 'sysop' : 'bofh';
      this.say(`${c}\r\n\r\n${PERSONAS[this.persona].intro}\r\n`);
      // He answers the phone first, as in the stories.
      if (this.persona === 'bofh' && !this.histories.bofh.length) void this.chatTurn(BOFH_PICKUP);
      else this.chatPrompt();
    } else if (c === 'P') {
      this.say('P\r\n\r\nDescribe the program in one line (for example: a 10x10\r\n' +
        'multiplication table, or a number guessing game).\r\n\r\nProgram: ');
      this.mode = 'describe';
      this.line = '';
    } else if (c === 'F') {
      this.say('F\r\n\r\nSend me the .ASM source (64K at most) by ZMODEM: in TERM press Ctrl-],\r\n' +
        'type ZMODEM S NAME.ASM, then TERM to come back here. ESC gives up.\r\n');
      this.startUpload();
    } else if (c === 'K') {
      this.deps.setKey(null);
      this.say('K\r\n\r\nKey forgotten.\r\n');
      this.askKey();
    } else if (c === 'G') {
      this.say('G\r\n\r\nThanks for calling the A-Prompt AI Board. 73!\r\n');
      this.mode = 'bye';
      this.closeAfterOutput = true;
      this.pump();
    }
  }

  private lineKey(b: number): void {
    if (b === CR) {
      this.say('\r\n');
      const text = this.line.trim();
      this.line = '';
      this.enter(text);
      return;
    }
    if (b === LF || b === 0) return;
    if (b === BS || b === DEL) {
      if (this.line.length) {
        this.line = this.line.slice(0, -1);
        this.out([BS, 32, BS], true);
      }
      return;
    }
    if (b < 32 || b > 126 || this.line.length >= 400) return;
    this.line += String.fromCharCode(b);
    this.out([this.mode === 'key' ? 0x2a : b], false); // '*' for the key
  }

  private enter(text: string): void {
    switch (this.mode) {
      case 'key':
        if (!text) { this.say('No key, no call.\r\n'); this.mode = 'bye'; this.closeAfterOutput = true; this.pump(); return; }
        this.deps.setKey(text);
        this.say(`Key saved in this browser (${mask(text)}).\r\n`);
        this.menu();
        return;
      case 'chat':
        if (!text) { this.chatPrompt(); return; }
        if (text.toLowerCase() === '/menu') { this.menu(); return; }
        void this.chatTurn(text);
        return;
      case 'describe':
        if (!text) { this.menu(); return; }
        this.progText = text;
        this.say('\r\nName for the program, up to 8 letters or digits: ');
        this.mode = 'name';
        return;
      case 'fix':
        this.progText = text || 'Make it assemble without errors and fix any bugs you find.';
        void this.fixProgram();
        return;
      case 'more':
        if (!text || text.toLowerCase() === '/menu') {
          this.session = undefined;
          this.menu();
          return;
        }
        void this.revise(text);
        return;
      case 'name': {
        const name = text.toUpperCase();
        if (!/^[A-Z][A-Z0-9]{0,7}$/.test(name)) {
          this.say('A letter, then up to 7 letters or digits.\r\nName: ');
          return;
        }
        this.progName = name;
        void this.makeProgram();
        return;
      }
    }
  }

  // ---- DeepSeek ------------------------------------------------------

  /** Streams one answer. Returns the text, or undefined when it failed. */
  private async ask(
    messages: ChatMessage[],
    opts: { thinking: boolean; show: 'text' | 'dots'; prefix?: number; hangs?: boolean },
  ): Promise<string | undefined> {
    const key = this.deps.getKey();
    if (!key) { this.askKey(); return undefined; }
    this.mode = 'busy';
    this.abort = new AbortController();
    const wrap = new Wrap((s) => this.say(s));
    if (opts.show === 'text') wrap.col = opts.prefix ?? 4;
    let text = '';
    let held = ''; // text that might turn out to be [HANGUP]
    this.hungUp = false;
    let dots = 0;
    let line = 0;
    let lastKind = '';
    try {
      for await (const chunk of this.deps.chat({
        key, messages: [...messages], thinking: opts.thinking, signal: this.abort.signal,
        // Thinking counts against max_tokens: leave room for the code after it.
        maxTokens: opts.thinking ? 65536 : 2048,
      })) {
        if (this.closed) return undefined;
        if (chunk.kind === 'text') text += chunk.text;
        if (opts.show === 'text' && chunk.kind === 'text') {
          if (!opts.hangs) { wrap.push(chunk.text); continue; }
          held += chunk.text;
          if (held.includes(HANGUP)) { this.hungUp = true; held = held.replace(HANGUP, ''); }
          const keep = this.hungUp ? 0 : partialSuffix(held, HANGUP);
          wrap.push(held.slice(0, held.length - keep));
          held = held.slice(held.length - keep);
        } else if (opts.show === 'dots' && ++dots % 40 === 0) {
          if (chunk.kind !== lastKind) {
            this.say(`${line ? '\r\n' : ''}${chunk.kind === 'thinking' ? 'thinking' : 'writing'} `);
            line = 9;
          }
          lastKind = chunk.kind;
          this.say('.');
          if (++line >= WIDTH) { this.say('\r\n'); line = 0; }
        }
      }
      wrap.push(held);
      wrap.flushWord();
      return text;
    } catch (e) {
      if (this.abort.signal.aborted) {
        this.say('\r\n[stopped]\r\n');
        return undefined;
      }
      this.say(`\r\n\r\n${explain(e)}\r\n`);
      if (e instanceof DeepSeekError && e.status === 401) { this.deps.setKey(null); this.askKey(); return undefined; }
      return undefined;
    } finally {
      this.abort = undefined;
    }
  }

  private async chatTurn(text: string): Promise<void> {
    const persona = PERSONAS[this.persona];
    const history = this.histories[this.persona];
    history.push({ role: 'user', content: text });
    if (history.length > 20) history.splice(0, history.length - 20);
    this.say(`\r\n${persona.prefix}`);
    const answer = await this.ask([{ role: 'system', content: persona.prompt }, ...history], {
      thinking: false, show: 'text', prefix: persona.prefix.length, hangs: persona.hangs,
    });
    if (this.closed) return;
    if (answer === undefined) {
      history.pop();
      if (this.mode === 'busy') this.chatPrompt();
      return;
    }
    history.push({ role: 'assistant', content: answer });
    if (this.hungUp) {
      this.say('\r\n\r\n*click*\r\n');
      this.mode = 'bye';
      this.closeAfterOutput = true;
      this.pump();
      return;
    }
    this.say('\r\n');
    this.chatPrompt();
  }

  private async makeProgram(): Promise<void> {
    const name = this.progName;
    this.fixSource = '';
    this.session = undefined;
    this.say(`\r\nWriting ${name}.ASM with DeepSeek V4.1 Flash. This can take a minute;\r\nESC gives up.\r\n`);
    await this.build(name, [
      { role: 'system', content: PROGRAM_PROMPT },
      { role: 'user', content: `Write a CP/M program called ${name}: ${this.progText}` },
    ]);
  }

  private async fixProgram(): Promise<void> {
    const name = this.progName;
    this.session = undefined;
    this.say(`\r\nFixing ${name}.ASM with DeepSeek V4.1 Flash. This can take a minute;\r\nESC gives up.\r\n`);
    const errors = this.fixErrors.length
      ? `ASM 2.0 reported these errors (letter, address, line):\n${this.fixErrors.join('\n')}\n${ERROR_LETTERS}`
      : 'It assembles without errors as it is.';
    await this.build(name, [
      { role: 'system', content: FIX_PROMPT },
      {
        role: 'user',
        content: `Here is ${name}.ASM:\n\n${this.fixSource}\n${errors}\n\nThe caller says: ${this.progText}\n` +
          'Output the whole corrected source, only the source.',
      },
    ]);
    this.fixSource = '';
  }

  /** Another pass on the session's program, with everything said so far. */
  private async revise(text: string): Promise<void> {
    const s = this.session!;
    s.messages.push({
      role: 'user',
      content: `The caller ran ${s.name} and asks for more: ${text}\n` +
        'Make that change and keep the rest of the program as it is. Output the whole source again, only the source.',
    });
    trimHistory(s.messages);
    this.say(`\r\nChanging ${s.name}.ASM with DeepSeek V4.1 Flash. This can take a minute;\r\nESC gives up.\r\n`);
    await this.build(s.name, s.messages);
  }

  /** After a transfer: more changes in the same conversation, or the menu. */
  private morePrompt(): void {
    this.say(`\r\nMore changes to ${this.session!.name}? Describe them in one line, or press\r\n` +
      'Enter alone for the menu. DeepSeek remembers this program and what you asked.\r\n\r\nChange: ');
    this.mode = 'more';
    this.line = '';
    this.settleUntil = this.now() + SETTLE_MS;
  }

  /** Asks for the source, assembles it (errors go back, three tries) and sends it. */
  private async build(name: string, messages: ChatMessage[]): Promise<void> {
    // A revision replaces what the caller downloaded last time.
    const replaces = Boolean(this.fixSource) || this.session?.messages === messages;
    this.session = { name, messages };
    let source = '';
    let result: AssemblyResult | undefined;
    for (let attempt = 1; attempt <= FIX_TRIES; attempt++) {
      const answer = await this.ask(messages, { thinking: true, show: 'dots' });
      if (this.closed) return;
      if (answer === undefined) { this.session = undefined; if (this.mode === 'busy') this.menu(); return; }
      source = cleanSource(answer);
      if (!/^\s*[A-Z]*:?\s*ORG\b/im.test(source)) {
        // All thinking and no answer (or prose instead of code).
        this.say('\r\nNo source came back. ');
        if (attempt < FIX_TRIES) {
          this.say(`Asking again (try ${attempt + 1} of ${FIX_TRIES})...\r\n`);
          messages.push({ role: 'assistant', content: answer || '(no answer)' });
          messages.push({ role: 'user', content: 'You sent no assembly source. Output the complete program source now, only the source, starting with ORG 100H.' });
          continue;
        }
        this.say('Giving up; try a simpler description.\r\n');
        this.session = undefined;
        this.menu();
        return;
      }
      messages.push({ role: 'assistant', content: source });
      this.say(`\r\nAssembling ${name}.ASM... `);
      result = await this.deps.assemble(name, source);
      if (this.closed) return;
      if (result.ok) {
        this.say(`OK, ${name}.COM is ${result.com!.length} bytes.\r\n`);
        break;
      }
      const shown = result.errors.slice(0, 4);
      this.say(`${result.errors.length} error${result.errors.length === 1 ? '' : 's'}:\r\n`);
      for (const line of shown) this.say(`  ${line.slice(0, WIDTH - 2)}\r\n`);
      if (attempt < FIX_TRIES) {
        this.say(`Sending them back for a fix (try ${attempt + 1} of ${FIX_TRIES})...\r\n`);
        messages.push({
          role: 'user',
          content: `ASM 2.0 reported these errors (letter, address, line):\n${result.errors.join('\n')}\n${ERROR_LETTERS}\nOutput the whole corrected source again, only the source.`,
        });
      }
    }
    const files: { name: string; data: Uint8Array }[] = [{ name: `${name}.ASM`, data: Uint8Array.from(toCp437(source.replace(/\n/g, '\r\n'))) }];
    if (result?.ok) files.push({ name: `${name}.COM`, data: result.com! });
    else this.say(`It still does not assemble. Sending ${name}.ASM anyway: fix it with ED.\r\n`);
    this.say(
      `\r\nSending ${files.map((f) => f.name).join(' and ')} by ZMODEM now.\r\n` +
      'In TERM press Ctrl-], type ZMODEM R, then TERM to come back here.\r\n',
    );
    if (replaces) this.say(`ZMODEM R replaces your ${name}.ASM: REN it first to keep the old one.\r\n`);
    this.startZmodem(files);
  }

  private startUpload(): void {
    this.mode = 'upload';
    this.fixSource = '';
    this.receiver = new ZmodemReceiver((bytes) => this.out([...bytes], false), (ok, files, why) => {
      this.receiver = undefined;
      if (this.closed) return;
      this.mode = 'busy';
      if (!ok || !files.length) {
        this.say(`\r\n\r\nNo upload${why ? `: ${why}` : ''}.\r\n`);
        this.menu();
        return;
      }
      void this.uploaded(files[0]);
    }, { maxBytes: MAX_UPLOAD_SOURCE, maxFiles: 1, now: this.deps.now });
    this.runTransfer(this.receiver);
  }

  private async uploaded(file: ZFile): Promise<void> {
    const name = programName(file.name);
    const text = sourceText(file.data);
    const shown = file.name.toUpperCase().slice(0, 40);
    if (!name) { this.say(`\r\n\r\n${shown} is not a .ASM file.\r\n`); this.menu(); return; }
    if (text === undefined) { this.say(`\r\n\r\n${shown} is not a text file.\r\n`); this.menu(); return; }
    if (!text.trim()) { this.say(`\r\n\r\n${shown} is empty.\r\n`); this.menu(); return; }
    const lines = text.split('\n').length - 1;
    this.say(`\r\n\r\nGot ${name}.ASM, ${lines} line${lines === 1 ? '' : 's'}. Assembling it as it is... `);
    const result = await this.deps.assemble(name, text);
    if (this.closed) return;
    this.fixErrors = result.ok ? [] : result.errors;
    if (result.ok) this.say('no errors.\r\n');
    else {
      this.say(`${result.errors.length} error${result.errors.length === 1 ? '' : 's'}:\r\n`);
      for (const line of result.errors.slice(0, 4)) this.say(`  ${line.slice(0, WIDTH - 2)}\r\n`);
    }
    this.progName = name;
    this.fixSource = text;
    this.say('\r\nWhat is wrong with it, or what should change? One line; Enter alone\r\n' +
      'just fixes it.\r\n\r\nFix: ');
    this.mode = 'fix';
    this.line = '';
  }

  private startZmodem(files: { name: string; data: Uint8Array }[]): void {
    this.mode = 'zmodem';
    const now = this.deps.now ?? (() => Date.now());
    this.sender = new ZmodemSender(files, (bytes) => this.out([...bytes], false), (ok, why) => {
      this.sender = undefined;
      if (this.closed) return;
      this.mode = 'busy';
      this.say(ok
        ? `\r\n\r\nTransfer complete. Run ${this.progName} at the A> prompt.\r\n`
        : `\r\n\r\nTransfer stopped: ${why}.\r\n`);
      if (this.session) this.morePrompt();
      else this.menu();
    }, now);
    this.runTransfer(this.sender);
  }

  /** Starts a transfer once the text before it has gone out at 2400 baud, and ticks it. */
  private runTransfer(t: { start(): void; tick(): void; readonly finished: boolean }): void {
    const live = () => !this.closed && !t.finished;
    const tick = () => {
      if (!live()) return;
      t.tick();
      this.deps.schedule(tick, 1000);
    };
    const begin = () => {
      if (!live()) return;
      if (this.queue.length) { this.deps.schedule(begin, 100); return; }
      t.start();
      this.deps.schedule(tick, 1000);
    };
    begin();
  }
}

function mask(key: string): string {
  return key.length > 8 ? `${key.slice(0, 3)}...${key.slice(-4)}` : '****';
}

export function createAiBoard(handlers: LinkHandlers, deps: AiBoardDeps): Link {
  return new AiBoard(handlers, deps);
}
