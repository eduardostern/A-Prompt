import { describe, expect, it } from 'vitest';
import { Z80, CF, HF, NF, PF, ZF, SF } from '../src/z80';

function run(cpu: Z80, ...bytes: number[]): void {
  cpu.mem.set(bytes, cpu.pc);
  cpu.step();
}

describe('Z80 details', () => {
  it('DAA follows the documented BCD correction', () => {
    const cases: Array<[number, number, number, number]> = [
      // a, flags, expected a, expected carry
      [0x00, 0, 0x00, 0],
      [0x09, 0, 0x09, 0],
      [0x0a, 0, 0x10, 0],
      [0x0f, 0, 0x15, 0],
      [0x99, 0, 0x99, 0],
      [0x9a, 0, 0x00, 1],
      [0x9f, 0, 0x05, 1],
      [0xa0, 0, 0x00, 1],
      [0x00, HF, 0x06, 0],
      [0x00, CF, 0x60, 1],
      [0x00, CF | NF, 0xa0, 1],
      [0x1a, NF, 0x14, 0],
    ];
    for (const [a, f, ea, ec] of cases) {
      const cpu = new Z80();
      cpu.a = a;
      cpu.f = f;
      run(cpu, 0x27);
      expect(cpu.a, `DAA ${a.toString(16)}/${f.toString(16)}`).toBe(ea);
      expect((cpu.f & CF) ? 1 : 0).toBe(ec);
    }
  });

  it('CP takes undocumented bits 3/5 from the operand', () => {
    const cpu = new Z80();
    cpu.a = 0x00;
    cpu.f = 0;
    run(cpu, 0xfe, 0x28); // CP 28h
    expect(cpu.f & 0x28).toBe(0x28);
    expect(cpu.f & CF).toBe(CF);
    expect(cpu.f & ZF).toBe(0);
  });

  it('LD A,I/R uses IFF2 as parity/overflow, not parity', () => {
    const cpu = new Z80();
    cpu.i = 0x00;
    cpu.iff2 = 0;
    cpu.f = CF;
    run(cpu, 0xed, 0x57);
    expect(cpu.a).toBe(0);
    expect(cpu.f & ZF).toBe(ZF);
    expect(cpu.f & PF).toBe(0);
    expect(cpu.f & CF).toBe(CF);

    cpu.iff2 = 1;
    cpu.pc = 0;
    run(cpu, 0xed, 0x57);
    expect(cpu.f & PF).toBe(PF);
  });

  it('DAA after a BCD addition', () => {
    const cpu = new Z80();
    cpu.a = 0x45;
    cpu.f = 0;
    run(cpu, 0xc6, 0x38); // ADD A,38h -> 7D
    run(cpu, 0x27); // DAA -> 83
    expect(cpu.a).toBe(0x83);
    expect(cpu.f & CF).toBe(0);
    expect(cpu.f & SF).toBe(SF);
  });
});

describe('Z80 T-states', () => {
  /** Runs one instruction at 1000h and returns the T-states it took. */
  function tstates(bytes: number[], setup: (cpu: Z80) => void = () => {}): number {
    const cpu = new Z80();
    cpu.pc = 0x1000;
    cpu.sp = 0x8000;
    setup(cpu);
    cpu.mem.set(bytes, 0x1000);
    const before = cpu.cycles;
    cpu.step();
    return cpu.cycles - before;
  }

  it('matches the Zilog tables for common instructions', () => {
    expect(tstates([0x00])).toBe(4); // NOP
    expect(tstates([0x01, 0, 0])).toBe(10); // LD BC,nn
    expect(tstates([0x7e])).toBe(7); // LD A,(HL)
    expect(tstates([0x34])).toBe(11); // INC (HL)
    expect(tstates([0xcd, 0, 0x20])).toBe(17); // CALL nn
    expect(tstates([0xc9])).toBe(10); // RET
    expect(tstates([0xe3])).toBe(19); // EX (SP),HL
    expect(tstates([0xcb, 0x46])).toBe(12); // BIT 0,(HL)
    expect(tstates([0xcb, 0x06])).toBe(15); // RLC (HL)
    expect(tstates([0xcb, 0x00])).toBe(8); // RLC B
    expect(tstates([0xed, 0x52])).toBe(15); // SBC HL,DE
    expect(tstates([0xed, 0x6f])).toBe(18); // RLD
    expect(tstates([0xdd, 0x21, 0, 0])).toBe(14); // LD IX,nn
    expect(tstates([0xdd, 0x7e, 1])).toBe(19); // LD A,(IX+1)
    expect(tstates([0xdd, 0x34, 1])).toBe(23); // INC (IX+1)
    expect(tstates([0xdd, 0x36, 1, 2])).toBe(19); // LD (IX+1),n
    expect(tstates([0xfd, 0xcb, 1, 0x46])).toBe(20); // BIT 0,(IY+1)
    expect(tstates([0xfd, 0xcb, 1, 0xc6])).toBe(23); // SET 0,(IY+1)
  });

  it('charges taken and not-taken branches differently', () => {
    expect(tstates([0x20, 0x10], (c) => { c.f = 0; })).toBe(12); // JR NZ taken
    expect(tstates([0x20, 0x10], (c) => { c.f = ZF; })).toBe(7); // JR NZ not taken
    expect(tstates([0x10, 0x10], (c) => { c.b = 2; })).toBe(13); // DJNZ taken
    expect(tstates([0x10, 0x10], (c) => { c.b = 1; })).toBe(8); // DJNZ falls through
    expect(tstates([0xcc, 0, 0x20], (c) => { c.f = ZF; })).toBe(17); // CALL Z taken
    expect(tstates([0xcc, 0, 0x20], (c) => { c.f = 0; })).toBe(10); // CALL Z not taken
    expect(tstates([0xc8], (c) => { c.f = ZF; })).toBe(11); // RET Z taken
    expect(tstates([0xc8], (c) => { c.f = 0; })).toBe(5); // RET Z not taken
    expect(tstates([0xca, 0, 0x20], (c) => { c.f = 0; })).toBe(10); // JP Z either way
  });

  it('charges 21 T-states per LDIR repeat and 16 for the last', () => {
    const cpu = new Z80();
    cpu.pc = 0x1000;
    cpu.hl = 0x2000;
    cpu.de = 0x3000;
    cpu.bc = 3;
    cpu.mem.set([0xed, 0xb0], 0x1000);
    while (cpu.pc === 0x1000) cpu.step();
    expect(cpu.cycles).toBe(21 + 21 + 16);
  });
});
