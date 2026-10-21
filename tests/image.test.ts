import { describe, expect, it } from 'vitest';
import { DiskImage } from '../src/cpm/image';
import { Disk, padExt, padName } from '../src/cpm/disk';
import { CpmMachine } from '../src/cpm/machine';
import type { ConsoleIO } from '../src/console';

class TestConsole implements ConsoleIO {
  output = '';
  queue: number[] = [];
  lastByte = 10;
  readonly columns = 80;
  write(text: string): void { this.output += text; }
  writeByte(code: number): void {
    this.lastByte = code;
    if (code === 13) this.output += '\r';
    else if (code === 10) this.output += '\n';
    else if (code >= 32 && code < 127) this.output += String.fromCharCode(code);
  }
  async readByte(): Promise<number> { return this.queue.shift() ?? 0x1a; }
  pollByte(): number | undefined { return this.queue.shift(); }
  hasInput(): boolean { return this.queue.length > 0; }
}

function file(name: string, ext: string, bytes: number[]) {
  return {
    user: 0,
    name: padName(name),
    ext: padExt(ext),
    data: new Uint8Array(bytes),
    ro: false,
    sys: false,
  };
}

describe('CP/M disk images', () => {
  it('round-trips files through an 8" image', () => {
    const image = DiskImage.blank();
    const data = new Uint8Array(20000);
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
    expect(image.rebuild([
      file('HELLO', 'COM', [1, 2, 3, 4]),
      { ...file('BIG', 'BIN', []), data },
    ])).toBe(true);

    const mounted = DiskImage.fromBytes(image.toBytes());
    expect(mounted).toBeTruthy();
    const files = mounted!.extractFiles();
    expect(files).toHaveLength(2);
    const hello = files.find((f) => f.name.trim() === 'HELLO')!;
    expect([...hello.data.slice(0, 4)]).toEqual([1, 2, 3, 4]);
    expect(hello.data.length).toBe(128);
    const big = files.find((f) => f.name.trim() === 'BIG')!;
    expect(big.data.length).toBeGreaterThanOrEqual(data.length);
    expect([...big.data.slice(0, data.length)]).toEqual([...data]);
  });

  it('reads and writes raw sectors', () => {
    const image = DiskImage.blank();
    const sec = new Uint8Array(128);
    sec.fill(0x5a);
    expect(image.writeSector(0, 0, sec)).toBe(true);
    expect(image.readSector(0, 0)![0]).toBe(0x5a);
    expect(image.readSector(0, 26)).toBeNull();
    expect(image.readSector(77, 0)).toBeNull();
  });

  it('implements BIOS SELDSK/SETTRK/SETSEC/SETDMA/READ/WRITE', async () => {
    const con = new TestConsole();
    const machine = new CpmMachine(con);
    machine.yieldFn = () => Promise.resolve();
    const image = DiskImage.blank();
    image.data[0] = 0xab;
    const disk = new Disk('B');
    expect(disk.mountImage(image.toBytes())).toBe(true);
    machine.drives[1] = disk;

    const code = new Uint8Array([
      0x1e, 0x01,             // MVI E,1 (drive B)
      0xcd, 0x1b, 0xfe,       // CALL SELDSK
      0x01, 0x00, 0x00,       // LXI B,0
      0xcd, 0x1e, 0xfe,       // CALL SETTRK
      0x01, 0x00, 0x00,       // LXI B,0
      0xcd, 0x21, 0xfe,       // CALL SETSEC
      0x01, 0x00, 0x02,       // LXI B,0200h
      0xcd, 0x24, 0xfe,       // CALL SETDMA
      0xcd, 0x27, 0xfe,       // CALL READ
      0x32, 0x00, 0x03,       // STA 0300h
      0x3e, 0xcd,             // MVI A,CDh
      0x32, 0x00, 0x02,       // STA 0200h
      0x01, 0x01, 0x00,       // LXI B,1
      0xcd, 0x21, 0xfe,       // CALL SETSEC
      0x01, 0x00, 0x02,       // LXI B,0200h
      0xcd, 0x24, 0xfe,       // CALL SETDMA
      0xcd, 0x2a, 0xfe,       // CALL WRITE
      0x32, 0x01, 0x03,       // STA 0301h
      0xc9,                   // RET
    ]);
    machine.drives[1].put('BIOSTEST', 'COM', code);
    await machine.runCom(machine.drives[1].find(0, 'BIOSTEST', 'COM')!, 'BIOSTEST');

    expect(machine.mem[0x0300]).toBe(0);
    expect(machine.mem[0x0301]).toBe(0);
    expect(machine.mem[0x0200]).toBe(0xcd);
    expect(machine.drives[1].image?.data[0]).toBe(0xab);
    expect(machine.drives[1].image?.data[128]).toBe(0xcd);
  });

  it('exports a file drive as an 8" image', () => {
    const disk = new Disk('A');
    disk.put('HELLO', 'COM', new Uint8Array([0x0e, 0x09, 0xc9]));
    const bytes = disk.exportImage();
    expect(bytes).toBeTruthy();
    const image = DiskImage.fromBytes(bytes!)!;
    const files = image.extractFiles();
    expect(files.some((f) => f.name.trim() === 'HELLO')).toBe(true);
  });
});
