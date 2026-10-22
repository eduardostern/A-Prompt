/*! A-Prompt — © 2026 Eduardo Stern <eduardostern@icloud.com> — MIT License */
/*
 * Z80 CPU core.
 *
 * A complete, table-free interpreter covering the documented instruction set
 * plus the undocumented instructions used by real CP/M software (SLL, IXH/IXL,
 * DDCB/FDCB register copies, ED variants). T-states follow the Zilog timing
 * tables (taken/not-taken branches, block repeats); the host uses them for
 * the clock limit and the MHz display.
 */

export const CF = 0x01; // carry
export const NF = 0x02; // add/subtract
export const PF = 0x04; // parity / overflow
export const XF = 0x08; // undocumented bit 3
export const HF = 0x10; // half carry
export const YF = 0x20; // undocumented bit 5
export const ZF = 0x40; // zero
export const SF = 0x80; // sign

export interface Z80State {
  a: number; f: number;
  b: number; c: number; d: number; e: number; h: number; l: number;
  a2: number; f2: number; b2: number; c2: number; d2: number; e2: number; h2: number; l2: number;
  ix: number; iy: number; sp: number; pc: number; i: number; r: number;
  iff1: number; iff2: number; im: number; halted: boolean;
}

const PARITY = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let v = i, p = 0;
  while (v) { p ^= v & 1; v >>= 1; }
  PARITY[i] = p ? 0 : PF;
}

const SZP = new Uint8Array(256);
const SZ = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  SZ[i] = (i & (SF | XF | YF)) | (i === 0 ? ZF : 0);
  SZP[i] = SZ[i] | PARITY[i];
}

// T-states for unprefixed opcodes. Conditional JR/DJNZ/CALL/RET hold the
// not-taken value; TAKEN adds the difference when the branch is taken.
const BASE = new Uint8Array([
  4, 10, 7, 6, 4, 4, 7, 4, 4, 11, 7, 6, 4, 4, 7, 4,
  8, 10, 7, 6, 4, 4, 7, 4, 12, 11, 7, 6, 4, 4, 7, 4,
  7, 10, 16, 6, 4, 4, 7, 4, 7, 11, 16, 6, 4, 4, 7, 4,
  7, 10, 13, 6, 11, 11, 10, 4, 7, 11, 13, 6, 4, 4, 7, 4,
  4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
  4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
  4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
  7, 7, 7, 7, 7, 7, 4, 7, 4, 4, 4, 4, 4, 4, 7, 4,
  4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
  4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
  4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
  4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
  5, 10, 10, 10, 10, 11, 7, 11, 5, 10, 10, 0, 10, 17, 7, 11,
  5, 10, 10, 11, 10, 11, 7, 11, 5, 4, 10, 11, 10, 0, 7, 11,
  5, 10, 10, 19, 10, 11, 7, 11, 5, 4, 10, 4, 10, 0, 7, 11,
  5, 10, 10, 4, 10, 11, 7, 11, 5, 6, 10, 4, 10, 0, 7, 11,
]);

/** Extra T-states for a taken conditional branch, and the branch's length. */
const TAKEN = new Uint8Array(256);
const TAKEN_LEN = new Uint8Array(256);
for (const op of [0x10, 0x20, 0x28, 0x30, 0x38]) { TAKEN[op] = 5; TAKEN_LEN[op] = 2; }
for (let op = 0xc0; op <= 0xf8; op += 8) {
  TAKEN[op] = 6; TAKEN_LEN[op] = 1; // RET cc
  TAKEN[op + 4] = 7; TAKEN_LEN[op + 4] = 3; // CALL cc
}

/** Opcodes that address (HL); with a DD/FD prefix they become (IX+d)/(IY+d). */
const HL_MEM = new Uint8Array(256);
for (const op of [0x34, 0x35, 0x36, 0x46, 0x4e, 0x56, 0x5e, 0x66, 0x6e, 0x7e,
  0x70, 0x71, 0x72, 0x73, 0x74, 0x75, 0x77, 0x86, 0x8e, 0x96, 0x9e, 0xa6, 0xae, 0xb6, 0xbe]) {
  HL_MEM[op] = 1;
}

function edCycles(op: number): number {
  if (op >= 0x40 && op < 0x80) {
    switch (op & 7) {
      case 0: case 1: return 12; // IN r,(C) / OUT (C),r
      case 2: return 15; // SBC/ADC HL,rr
      case 3: return 20; // LD (nn),rr / LD rr,(nn)
      case 5: return 14; // RETN / RETI
      case 7: return op === 0x67 || op === 0x6f ? 18 : op === 0x77 || op === 0x7f ? 8 : 9;
      default: return 8; // NEG, IM
    }
  }
  if ((op & 0xe4) === 0xa0) return 16; // block transfer/compare/IO
  return 8;
}

/** True for LDIR/CPIR/INIR/OTIR and their decrementing forms. */
const isBlockRepeat = (op: number): boolean => (op & 0xf4) === 0xb0;

export class Z80 {
  mem = new Uint8Array(65536);

  a = 0; f = 0;
  b = 0; c = 0; d = 0; e = 0; h = 0; l = 0;
  a2 = 0; f2 = 0; b2 = 0; c2 = 0; d2 = 0; e2 = 0; h2 = 0; l2 = 0;
  ix = 0; iy = 0; sp = 0; pc = 0; i = 0; r = 0;
  iff1 = 0; iff2 = 0; im = 0;
  halted = false;

  /** Rough T-state counter, for host pacing only. */
  cycles = 0;

  /** I/O port handlers; the default is an empty bus (FFh) and a sink. */
  portIn: (port: number) => number = () => 0xff;
  portOut: (port: number, value: number) => void = () => {};

  reset(): void {
    this.a = this.f = 0;
    this.b = this.c = this.d = this.e = this.h = this.l = 0;
    this.a2 = this.f2 = this.b2 = this.c2 = this.d2 = this.e2 = this.h2 = this.l2 = 0;
    this.ix = this.iy = 0;
    this.sp = 0xffff;
    this.pc = 0;
    this.i = 0;
    this.r = 0;
    this.iff1 = this.iff2 = 0;
    this.im = 0;
    this.halted = false;
    this.cycles = 0;
  }

  get af(): number { return (this.a << 8) | this.f; }
  set af(v: number) { this.a = (v >> 8) & 0xff; this.f = v & 0xff; }
  get bc(): number { return (this.b << 8) | this.c; }
  set bc(v: number) { this.b = (v >> 8) & 0xff; this.c = v & 0xff; }
  get de(): number { return (this.d << 8) | this.e; }
  set de(v: number) { this.d = (v >> 8) & 0xff; this.e = v & 0xff; }
  get hl(): number { return (this.h << 8) | this.l; }
  set hl(v: number) { this.h = (v >> 8) & 0xff; this.l = v & 0xff; }

  private imm8(): number { return this.mem[this.pc++ & 0xffff]; }
  private imm16(): number {
    const lo = this.mem[this.pc & 0xffff];
    const hi = this.mem[(this.pc + 1) & 0xffff];
    this.pc = (this.pc + 2) & 0xffff;
    return lo | (hi << 8);
  }
  private rd16(addr: number): number {
    return this.mem[addr & 0xffff] | (this.mem[(addr + 1) & 0xffff] << 8);
  }
  private wr16(addr: number, v: number): void {
    this.mem[addr & 0xffff] = v & 0xff;
    this.mem[(addr + 1) & 0xffff] = (v >> 8) & 0xff;
  }
  private push16(v: number): void {
    this.sp = (this.sp - 1) & 0xffff;
    this.mem[this.sp] = (v >> 8) & 0xff;
    this.sp = (this.sp - 1) & 0xffff;
    this.mem[this.sp] = v & 0xff;
  }
  private pop16(): number {
    const lo = this.mem[this.sp];
    this.sp = (this.sp + 1) & 0xffff;
    const hi = this.mem[this.sp];
    this.sp = (this.sp + 1) & 0xffff;
    return lo | (hi << 8);
  }

  private getR(i: number, idx = 0): number {
    switch (i) {
      case 0: return this.b;
      case 1: return this.c;
      case 2: return this.d;
      case 3: return this.e;
      case 4: return idx === 1 ? (this.ix >> 8) & 0xff : idx === 2 ? (this.iy >> 8) & 0xff : this.h;
      case 5: return idx === 1 ? this.ix & 0xff : idx === 2 ? this.iy & 0xff : this.l;
      case 7: return this.a;
      default: return 0;
    }
  }

  private setR(i: number, v: number, idx = 0): void {
    v &= 0xff;
    switch (i) {
      case 0: this.b = v; break;
      case 1: this.c = v; break;
      case 2: this.d = v; break;
      case 3: this.e = v; break;
      case 4:
        if (idx === 1) this.ix = (this.ix & 0x00ff) | (v << 8);
        else if (idx === 2) this.iy = (this.iy & 0x00ff) | (v << 8);
        else this.h = v;
        break;
      case 5:
        if (idx === 1) this.ix = (this.ix & 0xff00) | v;
        else if (idx === 2) this.iy = (this.iy & 0xff00) | v;
        else this.l = v;
        break;
      case 7: this.a = v; break;
    }
  }

  private getHL(idx: number): number {
    return idx === 1 ? this.ix : idx === 2 ? this.iy : this.hl;
  }
  private setHL(idx: number, v: number): void {
    v &= 0xffff;
    if (idx === 1) this.ix = v;
    else if (idx === 2) this.iy = v;
    else this.hl = v;
  }

  /** Reads the signed displacement that follows a DD/FD opcode. */
  private idxAddr(idx: number): number {
    const raw = this.mem[this.pc++ & 0xffff];
    const d = (raw << 24) >> 24;
    return (this.getHL(idx) + d) & 0xffff;
  }

  // ---- flag helpers -----------------------------------------------------

  private add8(v: number, withCarry: boolean): number {
    const a = this.a;
    const carry = withCarry && (this.f & CF) ? 1 : 0;
    const sum = a + v + carry;
    const r = sum & 0xff;
    let f = SZ[r];
    f |= (sum & 0x100) ? CF : 0;
    f |= ((a ^ v ^ r) & HF);
    f |= ((a ^ r) & (v ^ r) & 0x80) >> 5;
    this.f = f;
    return r;
  }

  private sub8(v: number, withCarry: boolean, store = true): number {
    const a = this.a;
    const carry = withCarry && (this.f & CF) ? 1 : 0;
    const diff = a - v - carry;
    const r = diff & 0xff;
    let f = SZ[r] | NF;
    f |= (diff & 0x100) ? CF : 0;
    f |= ((a ^ v ^ r) & HF);
    f |= ((a ^ v) & (a ^ r) & 0x80) >> 5;
    // CP puts the undocumented bits 3/5 of the operand in F, not the result.
    if (!store) f = (f & ~(XF | YF)) | (v & (XF | YF));
    this.f = f;
    if (store) this.a = r;
    return r;
  }

  private and8(v: number): void { this.a &= v; this.f = SZP[this.a] | HF; }
  private xor8(v: number): void { this.a = (this.a ^ v) & 0xff; this.f = SZP[this.a]; }
  private or8(v: number): void { this.a |= v; this.f = SZP[this.a]; }

  private inc8(v: number): number {
    const r = (v + 1) & 0xff;
    this.f = (this.f & CF) | (r & (SF | XF | YF)) | (r === 0 ? ZF : 0) |
      (r === 0x80 ? PF : 0) | ((v & 0x0f) === 0x0f ? HF : 0);
    return r;
  }

  private dec8(v: number): number {
    const r = (v - 1) & 0xff;
    this.f = (this.f & CF) | NF | (r & (SF | XF | YF)) | (r === 0 ? ZF : 0) |
      (r === 0x7f ? PF : 0) | ((v & 0x0f) === 0 ? HF : 0);
    return r;
  }

  private addHL(v: number, idx = 0): void {
    const a = this.getHL(idx);
    const sum = a + v;
    const r = sum & 0xffff;
    this.f = (this.f & (SF | ZF | PF)) |
      (((a ^ v ^ r) >> 8) & HF) |
      ((r >> 8) & (XF | YF)) |
      (sum > 0xffff ? CF : 0);
    this.setHL(idx, r);
  }

  private adcHL(v: number): void {
    const a = this.hl;
    const carry = (this.f & CF) ? 1 : 0;
    const sum = a + v + carry;
    const r = sum & 0xffff;
    let f = ((r >> 8) & (SF | XF | YF)) | (r === 0 ? ZF : 0) |
      (((a ^ v ^ r) >> 8) & HF) | (sum > 0xffff ? CF : 0);
    f |= ((a ^ r) & (v ^ r) & 0x8000) >> 13;
    this.f = f;
    this.hl = r;
  }

  private sbcHL(v: number): void {
    const a = this.hl;
    const carry = (this.f & CF) ? 1 : 0;
    const diff = a - v - carry;
    const r = diff & 0xffff;
    let f = NF | ((r >> 8) & (SF | XF | YF)) | (r === 0 ? ZF : 0) |
      (((a ^ v ^ r) >> 8) & HF) | (diff < 0 ? CF : 0);
    f |= ((a ^ v) & (a ^ r) & 0x8000) >> 13;
    this.f = f;
    this.hl = r;
  }

  private alu(op: number, v: number): void {
    switch (op) {
      case 0: this.a = this.add8(v, false); break;
      case 1: this.a = this.add8(v, true); break;
      case 2: this.sub8(v, false); break;
      case 3: this.sub8(v, true); break;
      case 4: this.and8(v); break;
      case 5: this.xor8(v); break;
      case 6: this.or8(v); break;
      case 7: this.sub8(v, false, false); break;
    }
  }

  private daa(): void {
    const old = this.a;
    let correction = 0;
    let carry = 0;
    if (old > 0x99 || (this.f & CF)) {
      carry = CF;
      correction = 0x60;
    }
    if ((old & 0x0f) > 9 || (this.f & HF)) correction += 0x06;
    this.a = (old + ((this.f & NF) ? -correction : correction)) & 0xff;
    this.f = SZP[this.a] | ((this.a ^ old) & HF) | (this.f & NF) | carry;
  }

  private rlc(v: number): number {
    const c = (v >> 7) & 1;
    const r = ((v << 1) | c) & 0xff;
    this.f = SZP[r] | (c ? CF : 0);
    return r;
  }
  private rrc(v: number): number {
    const c = v & 1;
    const r = ((v >> 1) | (c << 7)) & 0xff;
    this.f = SZP[r] | (c ? CF : 0);
    return r;
  }
  private rl(v: number): number {
    const c = (v >> 7) & 1;
    const r = ((v << 1) | ((this.f & CF) ? 1 : 0)) & 0xff;
    this.f = SZP[r] | (c ? CF : 0);
    return r;
  }
  private rr(v: number): number {
    const c = v & 1;
    const r = ((v >> 1) | ((this.f & CF) ? 0x80 : 0)) & 0xff;
    this.f = SZP[r] | (c ? CF : 0);
    return r;
  }
  private sla(v: number): number {
    const c = (v >> 7) & 1;
    const r = (v << 1) & 0xff;
    this.f = SZP[r] | (c ? CF : 0);
    return r;
  }
  private sra(v: number): number {
    const c = v & 1;
    const r = ((v >> 1) | (v & 0x80)) & 0xff;
    this.f = SZP[r] | (c ? CF : 0);
    return r;
  }
  private sll(v: number): number {
    const c = (v >> 7) & 1;
    const r = ((v << 1) | 1) & 0xff;
    this.f = SZP[r] | (c ? CF : 0);
    return r;
  }
  private srl(v: number): number {
    const c = v & 1;
    const r = (v >> 1) & 0xff;
    this.f = SZP[r] | (c ? CF : 0);
    return r;
  }
  private rot(kind: number, v: number): number {
    switch (kind) {
      case 0: return this.rlc(v);
      case 1: return this.rrc(v);
      case 2: return this.rl(v);
      case 3: return this.rr(v);
      case 4: return this.sla(v);
      case 5: return this.sra(v);
      case 6: return this.sll(v);
      default: return this.srl(v);
    }
  }

  private bitTest(v: number, bit: number, f53: number): void {
    const set = v & (1 << bit);
    this.f = (this.f & CF) | HF | (set ? 0 : ZF) | (set ? 0 : PF) |
      (bit === 7 && set ? SF : 0) | (f53 & (XF | YF));
  }

  // ---- main loop --------------------------------------------------------

  /** R counts opcode fetches: once per instruction and once per prefix byte. */
  private bumpR(): void {
    this.r = (this.r & 0x80) | ((this.r + 1) & 0x7f);
  }

  step(): void {
    if (this.halted) { this.bumpR(); this.cycles += 4; return; }
    this.bumpR();
    const start = this.pc & 0xffff;
    const op = this.mem[start];
    this.pc = (start + 1) & 0xffff;
    this.execBase(op);
    this.cycles += this.timing(op, start);
  }

  /** T-states of the instruction that started at `start` and just ran. */
  private timing(op: number, start: number): number {
    const m = this.mem;
    if (op === 0xcb) {
      const o = m[(start + 1) & 0xffff];
      if ((o & 7) !== 6) return 8;
      return (o & 0xc0) === 0x40 ? 12 : 15; // BIT b,(HL) : other (HL) ops
    }
    if (op === 0xed) {
      const o = m[(start + 1) & 0xffff];
      return edCycles(o) + (isBlockRepeat(o) && this.pc === start ? 5 : 0);
    }
    if (op === 0xdd || op === 0xfd) {
      // Each extra DD/FD prefix costs 4 T-states and acts as a NOP.
      let p = (start + 1) & 0xffff;
      let t = 0;
      while (m[p] === 0xdd || m[p] === 0xfd) { t += 4; p = (p + 1) & 0xffff; }
      const o = m[p];
      if (o === 0xcb) return t + ((m[(p + 2) & 0xffff] & 0xc0) === 0x40 ? 20 : 23);
      if (o === 0xed) {
        const e = m[(p + 1) & 0xffff];
        return t + 4 + edCycles(e) + (isBlockRepeat(e) && this.pc === p ? 5 : 0);
      }
      if (HL_MEM[o]) return t + (o === 0x36 ? 19 : BASE[o] + 12);
      let base = t + 4 + BASE[o];
      if (TAKEN[o] && this.pc !== ((p + TAKEN_LEN[o]) & 0xffff)) base += TAKEN[o];
      return base;
    }
    let t = BASE[op];
    if (TAKEN[op] && this.pc !== ((start + TAKEN_LEN[op]) & 0xffff)) t += TAKEN[op];
    return t;
  }

  private execBase(op: number): void {
    if (op >= 0x40 && op <= 0x7f) {
      if (op === 0x76) { this.halted = true; return; }
      const dst = (op >> 3) & 7;
      const src = op & 7;
      if (src === 6) this.setR(dst, this.mem[this.hl]);
      else if (dst === 6) this.mem[this.hl] = this.getR(src);
      else this.setR(dst, this.getR(src));
      return;
    }
    if (op >= 0x80 && op <= 0xbf) {
      const src = op & 7;
      this.alu((op >> 3) & 7, src === 6 ? this.mem[this.hl] : this.getR(src));
      return;
    }

    switch (op) {
      case 0x00: break; // NOP
      case 0x01: this.bc = this.imm16(); break;
      case 0x02: this.mem[this.bc] = this.a; break;
      case 0x03: this.bc = (this.bc + 1) & 0xffff; break;
      case 0x04: this.b = this.inc8(this.b); break;
      case 0x05: this.b = this.dec8(this.b); break;
      case 0x06: this.b = this.imm8(); break;
      case 0x07: { const c = (this.a >> 7) & 1; this.a = ((this.a << 1) | c) & 0xff; this.f = (this.f & (SF | ZF | PF)) | (this.a & (XF | YF)) | (c ? CF : 0); break; }
      case 0x08: { const a = this.a, f = this.f; this.a = this.a2; this.f = this.f2; this.a2 = a; this.f2 = f; break; }
      case 0x09: this.addHL(this.bc); break;
      case 0x0a: this.a = this.mem[this.bc]; break;
      case 0x0b: this.bc = (this.bc - 1) & 0xffff; break;
      case 0x0c: this.c = this.inc8(this.c); break;
      case 0x0d: this.c = this.dec8(this.c); break;
      case 0x0e: this.c = this.imm8(); break;
      case 0x0f: { const c = this.a & 1; this.a = ((this.a >> 1) | (c << 7)) & 0xff; this.f = (this.f & (SF | ZF | PF)) | (this.a & (XF | YF)) | (c ? CF : 0); break; }
      case 0x10: { const d = (this.mem[this.pc++ & 0xffff] << 24) >> 24; this.b = (this.b - 1) & 0xff; if (this.b !== 0) this.pc = (this.pc + d) & 0xffff; break; }
      case 0x11: this.de = this.imm16(); break;
      case 0x12: this.mem[this.de] = this.a; break;
      case 0x13: this.de = (this.de + 1) & 0xffff; break;
      case 0x14: this.d = this.inc8(this.d); break;
      case 0x15: this.d = this.dec8(this.d); break;
      case 0x16: this.d = this.imm8(); break;
      case 0x17: { const c = (this.a >> 7) & 1; this.a = ((this.a << 1) | ((this.f & CF) ? 1 : 0)) & 0xff; this.f = (this.f & (SF | ZF | PF)) | (this.a & (XF | YF)) | (c ? CF : 0); break; }
      case 0x18: { const d = (this.mem[this.pc++ & 0xffff] << 24) >> 24; this.pc = (this.pc + d) & 0xffff; break; }
      case 0x19: this.addHL(this.de); break;
      case 0x1a: this.a = this.mem[this.de]; break;
      case 0x1b: this.de = (this.de - 1) & 0xffff; break;
      case 0x1c: this.e = this.inc8(this.e); break;
      case 0x1d: this.e = this.dec8(this.e); break;
      case 0x1e: this.e = this.imm8(); break;
      case 0x1f: { const c = this.a & 1; this.a = ((this.a >> 1) | ((this.f & CF) ? 0x80 : 0)) & 0xff; this.f = (this.f & (SF | ZF | PF)) | (this.a & (XF | YF)) | (c ? CF : 0); break; }
      case 0x20: { const d = (this.mem[this.pc++ & 0xffff] << 24) >> 24; if (!(this.f & ZF)) this.pc = (this.pc + d) & 0xffff; break; }
      case 0x21: this.hl = this.imm16(); break;
      case 0x22: this.wr16(this.imm16(), this.hl); break;
      case 0x23: this.hl = (this.hl + 1) & 0xffff; break;
      case 0x24: this.h = this.inc8(this.h); break;
      case 0x25: this.h = this.dec8(this.h); break;
      case 0x26: this.h = this.imm8(); break;
      case 0x27: this.daa(); break;
      case 0x28: { const d = (this.mem[this.pc++ & 0xffff] << 24) >> 24; if (this.f & ZF) this.pc = (this.pc + d) & 0xffff; break; }
      case 0x29: this.addHL(this.hl); break;
      case 0x2a: this.hl = this.rd16(this.imm16()); break;
      case 0x2b: this.hl = (this.hl - 1) & 0xffff; break;
      case 0x2c: this.l = this.inc8(this.l); break;
      case 0x2d: this.l = this.dec8(this.l); break;
      case 0x2e: this.l = this.imm8(); break;
      case 0x2f: this.a = (~this.a) & 0xff; this.f |= NF | HF; this.f = (this.f & ~(XF | YF)) | (this.a & (XF | YF)); break;
      case 0x30: { const d = (this.mem[this.pc++ & 0xffff] << 24) >> 24; if (!(this.f & CF)) this.pc = (this.pc + d) & 0xffff; break; }
      case 0x31: this.sp = this.imm16(); break;
      case 0x32: this.mem[this.imm16()] = this.a; break;
      case 0x33: this.sp = (this.sp + 1) & 0xffff; break;
      case 0x34: this.mem[this.hl] = this.inc8(this.mem[this.hl]); break;
      case 0x35: this.mem[this.hl] = this.dec8(this.mem[this.hl]); break;
      case 0x36: this.mem[this.hl] = this.imm8(); break;
      case 0x37: this.f = (this.f & (SF | ZF | PF)) | (this.a & (XF | YF)) | CF; break;
      case 0x38: { const d = (this.mem[this.pc++ & 0xffff] << 24) >> 24; if (this.f & CF) this.pc = (this.pc + d) & 0xffff; break; }
      case 0x39: this.addHL(this.sp); break;
      case 0x3a: this.a = this.mem[this.imm16()]; break;
      case 0x3b: this.sp = (this.sp - 1) & 0xffff; break;
      case 0x3c: this.a = this.inc8(this.a); break;
      case 0x3d: this.a = this.dec8(this.a); break;
      case 0x3e: this.a = this.imm8(); break;
      case 0x3f: this.f = (this.f & (SF | ZF | PF)) | (this.a & (XF | YF)) | ((this.f & CF) ? HF : CF); break;

      case 0xc0: if (!(this.f & ZF)) this.pc = this.pop16(); break;
      case 0xc1: this.bc = this.pop16(); break;
      case 0xc2: { const a = this.imm16(); if (!(this.f & ZF)) this.pc = a; break; }
      case 0xc3: this.pc = this.imm16(); break;
      case 0xc4: { const a = this.imm16(); if (!(this.f & ZF)) { this.push16(this.pc); this.pc = a; } break; }
      case 0xc5: this.push16(this.bc); break;
      case 0xc6: this.a = this.add8(this.imm8(), false); break;
      case 0xc7: this.push16(this.pc); this.pc = 0x00; break;
      case 0xc8: if (this.f & ZF) this.pc = this.pop16(); break;
      case 0xc9: this.pc = this.pop16(); break;
      case 0xca: { const a = this.imm16(); if (this.f & ZF) this.pc = a; break; }
      case 0xcb: this.execCb(); break;
      case 0xcc: { const a = this.imm16(); if (this.f & ZF) { this.push16(this.pc); this.pc = a; } break; }
      case 0xcd: { const a = this.imm16(); this.push16(this.pc); this.pc = a; break; }
      case 0xce: this.a = this.add8(this.imm8(), true); break;
      case 0xcf: this.push16(this.pc); this.pc = 0x08; break;

      case 0xd0: if (!(this.f & CF)) this.pc = this.pop16(); break;
      case 0xd1: this.de = this.pop16(); break;
      case 0xd2: { const a = this.imm16(); if (!(this.f & CF)) this.pc = a; break; }
      case 0xd3: this.portOut((this.a << 8) | this.imm8(), this.a); break; // OUT (n),A
      case 0xd4: { const a = this.imm16(); if (!(this.f & CF)) { this.push16(this.pc); this.pc = a; } break; }
      case 0xd5: this.push16(this.de); break;
      case 0xd6: this.sub8(this.imm8(), false); break;
      case 0xd7: this.push16(this.pc); this.pc = 0x10; break;
      case 0xd8: if (this.f & CF) this.pc = this.pop16(); break;
      case 0xd9: { const b = this.b, c = this.c, d = this.d, e = this.e, h = this.h, l = this.l; this.b = this.b2; this.c = this.c2; this.d = this.d2; this.e = this.e2; this.h = this.h2; this.l = this.l2; this.b2 = b; this.c2 = c; this.d2 = d; this.e2 = e; this.h2 = h; this.l2 = l; break; }
      case 0xda: { const a = this.imm16(); if (this.f & CF) this.pc = a; break; }
      case 0xdb: this.a = this.portIn((this.a << 8) | this.imm8()) & 0xff; break; // IN A,(n)
      case 0xdc: { const a = this.imm16(); if (this.f & CF) { this.push16(this.pc); this.pc = a; } break; }
      case 0xdd: this.execIndexed(1); break;
      case 0xde: this.sub8(this.imm8(), true); break;
      case 0xdf: this.push16(this.pc); this.pc = 0x18; break;

      case 0xe0: if (!(this.f & PF)) this.pc = this.pop16(); break;
      case 0xe1: this.hl = this.pop16(); break;
      case 0xe2: { const a = this.imm16(); if (!(this.f & PF)) this.pc = a; break; }
      case 0xe3: { const lo = this.mem[this.sp], hi = this.mem[(this.sp + 1) & 0xffff]; this.mem[this.sp] = this.hl & 0xff; this.mem[(this.sp + 1) & 0xffff] = (this.hl >> 8) & 0xff; this.hl = lo | (hi << 8); break; }
      case 0xe4: { const a = this.imm16(); if (!(this.f & PF)) { this.push16(this.pc); this.pc = a; } break; }
      case 0xe5: this.push16(this.hl); break;
      case 0xe6: this.and8(this.imm8()); break;
      case 0xe7: this.push16(this.pc); this.pc = 0x20; break;
      case 0xe8: if (this.f & PF) this.pc = this.pop16(); break;
      case 0xe9: this.pc = this.hl; break;
      case 0xea: { const a = this.imm16(); if (this.f & PF) this.pc = a; break; }
      case 0xeb: { const d = this.d, e = this.e; this.d = this.h; this.e = this.l; this.h = d; this.l = e; break; }
      case 0xec: { const a = this.imm16(); if (this.f & PF) { this.push16(this.pc); this.pc = a; } break; }
      case 0xed: this.execEd(); break;
      case 0xee: this.xor8(this.imm8()); break;
      case 0xef: this.push16(this.pc); this.pc = 0x28; break;

      case 0xf0: if (!(this.f & SF)) this.pc = this.pop16(); break;
      case 0xf1: this.af = this.pop16(); break;
      case 0xf2: { const a = this.imm16(); if (!(this.f & SF)) this.pc = a; break; }
      case 0xf3: this.iff1 = this.iff2 = 0; break;
      case 0xf4: { const a = this.imm16(); if (!(this.f & SF)) { this.push16(this.pc); this.pc = a; } break; }
      case 0xf5: this.push16(this.af); break;
      case 0xf6: this.or8(this.imm8()); break;
      case 0xf7: this.push16(this.pc); this.pc = 0x30; break;
      case 0xf8: if (this.f & SF) this.pc = this.pop16(); break;
      case 0xf9: this.sp = this.hl; break;
      case 0xfa: { const a = this.imm16(); if (this.f & SF) this.pc = a; break; }
      case 0xfb: this.iff1 = this.iff2 = 1; break;
      case 0xfc: { const a = this.imm16(); if (this.f & SF) { this.push16(this.pc); this.pc = a; } break; }
      case 0xfd: this.execIndexed(2); break;
      case 0xfe: this.sub8(this.imm8(), false, false); break;
      case 0xff: this.push16(this.pc); this.pc = 0x38; break;
    }
  }

  private execCb(): void {
    this.bumpR();
    const op = this.mem[this.pc++ & 0xffff];
    const reg = op & 7;
    const group = op >> 6;
    if (group === 0) {
      const v = reg === 6 ? this.mem[this.hl] : this.getR(reg);
      const r = this.rot((op >> 3) & 7, v);
      if (reg === 6) this.mem[this.hl] = r; else this.setR(reg, r);
    } else if (group === 1) {
      const bit = (op >> 3) & 7;
      const v = reg === 6 ? this.mem[this.hl] : this.getR(reg);
      this.bitTest(v, bit, reg === 6 ? (this.hl >> 8) : v);
    } else if (group === 2) {
      const bit = (op >> 3) & 7;
      if (reg === 6) this.mem[this.hl] &= ~(1 << bit);
      else this.setR(reg, this.getR(reg) & ~(1 << bit));
    } else {
      const bit = (op >> 3) & 7;
      if (reg === 6) this.mem[this.hl] |= (1 << bit);
      else this.setR(reg, this.getR(reg) | (1 << bit));
    }
  }

  private execIndexed(idx: 1 | 2): void {
    this.bumpR();
    const op = this.mem[this.pc++ & 0xffff];
    if (op === 0xdd || op === 0xfd) { this.execIndexed(op === 0xdd ? 1 : 2); return; }
    if (op === 0xcb) {
      const disp = (this.mem[this.pc++ & 0xffff] << 24) >> 24;
      const cb = this.mem[this.pc++ & 0xffff];
      const addr = (this.getHL(idx) + disp) & 0xffff;
      const reg = cb & 7;
      const group = cb >> 6;
      if (group === 0) {
        const r = this.rot((cb >> 3) & 7, this.mem[addr]);
        this.mem[addr] = r;
        if (reg !== 6) this.setR(reg, r, idx);
      } else if (group === 1) {
        this.bitTest(this.mem[addr], (cb >> 3) & 7, addr >> 8);
      } else if (group === 2) {
        this.mem[addr] &= ~(1 << ((cb >> 3) & 7));
        if (reg !== 6) this.setR(reg, this.mem[addr], idx);
      } else {
        this.mem[addr] |= 1 << ((cb >> 3) & 7);
        if (reg !== 6) this.setR(reg, this.mem[addr], idx);
      }
      return;
    }
    if (op === 0x76) { this.halted = true; return; }
    if (op >= 0x40 && op <= 0x7f) {
      const dst = (op >> 3) & 7;
      const src = op & 7;
      if (dst === 6) {
        const addr = this.idxAddr(idx);
        const v = src === 6 ? 0 : src === 4 ? this.h : src === 5 ? this.l : this.getR(src, idx);
        this.mem[addr] = v;
      } else if (src === 6) {
        const v = this.mem[this.idxAddr(idx)];
        if (dst === 4) this.h = v; else if (dst === 5) this.l = v; else this.setR(dst, v, idx);
      } else {
        this.setR(dst, this.getR(src, idx), idx);
      }
      return;
    }
    if (op >= 0x80 && op <= 0xbf) {
      const src = op & 7;
      const v = src === 6 ? this.mem[this.idxAddr(idx)] : this.getR(src, idx);
      this.alu((op >> 3) & 7, v);
      return;
    }
    switch (op) {
      case 0x09: this.addHL(this.bc, idx); break;
      case 0x19: this.addHL(this.de, idx); break;
      case 0x29: this.addHL(this.getHL(idx), idx); break;
      case 0x39: this.addHL(this.sp, idx); break;
      case 0x21: this.setHL(idx, this.imm16()); break;
      case 0x22: this.wr16(this.imm16(), this.getHL(idx)); break;
      case 0x2a: this.setHL(idx, this.rd16(this.imm16())); break;
      case 0x23: this.setHL(idx, (this.getHL(idx) + 1) & 0xffff); break;
      case 0x2b: this.setHL(idx, (this.getHL(idx) - 1) & 0xffff); break;
      case 0x24: this.setR(4, this.inc8(this.getR(4, idx)), idx); break;
      case 0x25: this.setR(4, this.dec8(this.getR(4, idx)), idx); break;
      case 0x26: this.setR(4, this.imm8(), idx); break;
      case 0x2c: this.setR(5, this.inc8(this.getR(5, idx)), idx); break;
      case 0x2d: this.setR(5, this.dec8(this.getR(5, idx)), idx); break;
      case 0x2e: this.setR(5, this.imm8(), idx); break;
      case 0x34: { const a = this.idxAddr(idx); this.mem[a] = this.inc8(this.mem[a]); break; }
      case 0x35: { const a = this.idxAddr(idx); this.mem[a] = this.dec8(this.mem[a]); break; }
      case 0x36: { const a = this.idxAddr(idx); this.mem[a] = this.imm8(); break; }
      case 0xe1: this.setHL(idx, this.pop16()); break;
      case 0xe5: this.push16(this.getHL(idx)); break;
      case 0xe3: {
        const lo = this.mem[this.sp], hi = this.mem[(this.sp + 1) & 0xffff];
        const v = this.getHL(idx);
        this.mem[this.sp] = v & 0xff;
        this.mem[(this.sp + 1) & 0xffff] = (v >> 8) & 0xff;
        this.setHL(idx, lo | (hi << 8));
        break;
      }
      case 0xe9: this.pc = this.getHL(idx); break;
      case 0xf9: this.sp = this.getHL(idx); break;
      default: this.execBase(op); break;
    }
  }

  private execEd(): void {
    this.bumpR();
    const op = this.mem[this.pc++ & 0xffff];
    switch (op) {
      case 0x40: case 0x48: case 0x50: case 0x58: case 0x60: case 0x68: case 0x70: case 0x78: {
        const v = this.portIn(this.bc) & 0xff;
        this.f = (this.f & CF) | SZP[v];
        if (op !== 0x70) this.setR((op >> 3) & 7, v);
        break;
      }
      case 0x41: case 0x49: case 0x51: case 0x59: case 0x61: case 0x69: case 0x71: case 0x79:
        this.portOut(this.bc, op === 0x71 ? 0 : this.getR((op >> 3) & 7)); // OUT (C),r
        break;
      case 0x42: this.sbcHL(this.bc); break;
      case 0x4a: this.adcHL(this.bc); break;
      case 0x52: this.sbcHL(this.de); break;
      case 0x5a: this.adcHL(this.de); break;
      case 0x62: this.sbcHL(this.hl); break;
      case 0x6a: this.adcHL(this.hl); break;
      case 0x72: this.sbcHL(this.sp); break;
      case 0x7a: this.adcHL(this.sp); break;
      case 0x43: this.wr16(this.imm16(), this.bc); break;
      case 0x4b: this.bc = this.rd16(this.imm16()); break;
      case 0x53: this.wr16(this.imm16(), this.de); break;
      case 0x5b: this.de = this.rd16(this.imm16()); break;
      case 0x63: this.wr16(this.imm16(), this.hl); break;
      case 0x6b: this.hl = this.rd16(this.imm16()); break;
      case 0x73: this.wr16(this.imm16(), this.sp); break;
      case 0x7b: this.sp = this.rd16(this.imm16()); break;
      case 0x44: case 0x4c: case 0x54: case 0x5c: case 0x64: case 0x6c: case 0x74: case 0x7c: {
        const old = this.a;
        this.a = 0;
        this.a = this.sub8(old, false);
        break;
      }
      case 0x45: case 0x55: case 0x65: case 0x75: this.pc = this.pop16(); this.iff1 = this.iff2; break;
      case 0x4d: case 0x5d: case 0x6d: case 0x7d: this.pc = this.pop16(); this.iff1 = this.iff2; break;
      case 0x46: case 0x4e: case 0x66: case 0x6e: this.im = 0; break;
      case 0x56: case 0x76: this.im = 1; break;
      case 0x5e: case 0x7e: this.im = 2; break;
      case 0x47: this.i = this.a; break;
      case 0x4f: this.r = this.a; break;
      case 0x57: case 0x5f: {
        const v = op === 0x57 ? this.i : this.r;
        this.a = v;
        this.f = (this.f & CF) | SZ[v] | (this.iff2 ? PF : 0);
        break;
      }
      case 0x67: { // RRD
        const v = this.mem[this.hl];
        this.mem[this.hl] = ((this.a << 4) & 0xf0) | (v >> 4);
        this.a = (this.a & 0xf0) | (v & 0x0f);
        this.f = (this.f & CF) | SZP[this.a];
        break;
      }
      case 0x6f: { // RLD
        const v = this.mem[this.hl];
        this.mem[this.hl] = ((v << 4) & 0xf0) | (this.a & 0x0f);
        this.a = (this.a & 0xf0) | ((v >> 4) & 0x0f);
        this.f = (this.f & CF) | SZP[this.a];
        break;
      }
      case 0xa0: case 0xa8: { // LDI / LDD
        const v = this.mem[this.hl];
        this.mem[this.de] = v;
        const step = op === 0xa0 ? 1 : -1;
        this.hl = (this.hl + step) & 0xffff;
        this.de = (this.de + step) & 0xffff;
        this.bc = (this.bc - 1) & 0xffff;
        const sum = this.a + v;
        this.f = (this.f & (SF | ZF | CF)) | (this.bc ? PF : 0) |
          (sum & XF) | ((sum & 0x02) ? YF : 0);
        break;
      }
      case 0xb0: case 0xb8: { // LDIR / LDDR
        const v = this.mem[this.hl];
        this.mem[this.de] = v;
        const step = op === 0xb0 ? 1 : -1;
        this.hl = (this.hl + step) & 0xffff;
        this.de = (this.de + step) & 0xffff;
        this.bc = (this.bc - 1) & 0xffff;
        const sum = this.a + v;
        this.f = (this.f & (SF | ZF | CF)) | (this.bc ? PF : 0) |
          (sum & XF) | ((sum & 0x02) ? YF : 0);
        if (this.bc !== 0) this.pc = (this.pc - 2) & 0xffff;
        break;
      }
      case 0xa1: case 0xa9: { // CPI / CPD
        const v = this.mem[this.hl];
        const r = (this.a - v) & 0xff;
        const half = (this.a ^ v ^ r) & HF;
        const diff = this.a - v - (half ? 1 : 0);
        const step = op === 0xa1 ? 1 : -1;
        this.hl = (this.hl + step) & 0xffff;
        this.bc = (this.bc - 1) & 0xffff;
        this.f = (this.f & CF) | NF | half | (r & SF) | (r === 0 ? ZF : 0) | (this.bc ? PF : 0) |
          (diff & XF) | ((diff & 0x02) ? YF : 0);
        break;
      }
      case 0xb1: case 0xb9: { // CPIR / CPDR
        const v = this.mem[this.hl];
        const r = (this.a - v) & 0xff;
        const half = (this.a ^ v ^ r) & HF;
        const diff = this.a - v - (half ? 1 : 0);
        const step = op === 0xb1 ? 1 : -1;
        this.hl = (this.hl + step) & 0xffff;
        this.bc = (this.bc - 1) & 0xffff;
        this.f = (this.f & CF) | NF | half | (r & SF) | (r === 0 ? ZF : 0) | (this.bc ? PF : 0) |
          (diff & XF) | ((diff & 0x02) ? YF : 0);
        if (this.bc !== 0 && r !== 0) this.pc = (this.pc - 2) & 0xffff;
        break;
      }
      case 0xa2: case 0xaa: { // INI / IND
        const v = this.portIn(this.bc) & 0xff;
        this.mem[this.hl] = v;
        const step = op === 0xa2 ? 1 : -1;
        this.hl = (this.hl + step) & 0xffff;
        this.b = (this.b - 1) & 0xff;
        this.f = (this.f & CF) | SZP[this.b] | NF | (v & 0x80 ? NF : 0);
        break;
      }
      case 0xa3: case 0xab: { // OUTI / OUTD
        const v = this.mem[this.hl];
        this.portOut(((this.b - 1) & 0xff) << 8 | this.c, v);
        const step = op === 0xa3 ? 1 : -1;
        this.hl = (this.hl + step) & 0xffff;
        this.b = (this.b - 1) & 0xff;
        this.f = (this.f & CF) | SZP[this.b] | NF | (v & 0x80 ? NF : 0);
        break;
      }
      case 0xb2: case 0xba: { // INIR / INDR
        const v = this.portIn(this.bc) & 0xff;
        this.mem[this.hl] = v;
        const step = op === 0xb2 ? 1 : -1;
        this.hl = (this.hl + step) & 0xffff;
        this.b = (this.b - 1) & 0xff;
        this.f = (this.f & CF) | SZP[this.b] | NF;
        if (this.b !== 0) this.pc = (this.pc - 2) & 0xffff;
        break;
      }
      case 0xb3: case 0xbb: { // OTIR / OTDR
        const v = this.mem[this.hl];
        this.portOut(((this.b - 1) & 0xff) << 8 | this.c, v);
        const step = op === 0xb3 ? 1 : -1;
        this.hl = (this.hl + step) & 0xffff;
        this.b = (this.b - 1) & 0xff;
        this.f = (this.f & CF) | SZP[this.b] | NF;
        if (this.b !== 0) this.pc = (this.pc - 2) & 0xffff;
        break;
      }
      default:
        break; // undefined ED opcodes behave as NOP
    }
  }

  /** Non-maskable interrupt. */
  nmi(): void {
    this.iff2 = this.iff1;
    this.iff1 = 0;
    this.halted = false;
    this.push16(this.pc);
    this.pc = 0x0066;
  }

  /** Maskable interrupt (mode 0/1/2). No peripheral generates one in CP/M. */
  interrupt(data = 0xff): void {
    if (!this.iff1) return;
    this.iff1 = this.iff2 = 0;
    this.halted = false;
    if (this.im === 0) {
      // The data byte is executed as an instruction; an RST pushes PC itself.
      this.execBase(data);
    } else if (this.im === 1) {
      this.push16(this.pc);
      this.pc = 0x0038;
    } else {
      // The vector is I:data as supplied; the Z80 does not clear bit 0.
      this.push16(this.pc);
      const addr = (this.i << 8) | (data & 0xff);
      this.pc = this.mem[addr] | (this.mem[(addr + 1) & 0xffff] << 8);
    }
  }

  getState(): Z80State {
    return {
      a: this.a, f: this.f, b: this.b, c: this.c, d: this.d, e: this.e, h: this.h, l: this.l,
      a2: this.a2, f2: this.f2, b2: this.b2, c2: this.c2, d2: this.d2, e2: this.e2, h2: this.h2, l2: this.l2,
      ix: this.ix, iy: this.iy, sp: this.sp, pc: this.pc, i: this.i, r: this.r,
      iff1: this.iff1, iff2: this.iff2, im: this.im, halted: this.halted,
    };
  }
}
