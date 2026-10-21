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
