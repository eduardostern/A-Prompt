import { describe, expect, it } from 'vitest';
import { DiskImage } from '../src/cpm/image';
import { Disk, displayName, padExt, padName } from '../src/cpm/disk';
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

/** IBM 3740 skew-6 table, 1-based as published (cpmtools ibm-3740, DRI 2.2 CBIOS). */
const XLT_3740 = [1, 7, 13, 19, 25, 5, 11, 17, 23, 3, 9, 15, 21, 2, 8, 14, 20, 26, 6, 12, 18, 24, 4, 10, 16, 22];
const SECTOR = 128;
const EIGHT_INCH = 77 * 26 * SECTOR;

/** Byte offset of logical sector `n` of the data area (track 2 on) of an 8" disk. */
function skewedOffset(n: number, skew = true): number {
  const track = 2 + Math.floor(n / 26);
  const sec = n % 26;
  return (track * 26 + (skew ? XLT_3740[sec] - 1 : sec)) * SECTOR;
}

/** Builds an 8" image by hand: one file HI.TXT in block 2, directory in blocks 0-1. */
function handMadeImage(skew: boolean): Uint8Array {
  const img = new Uint8Array(EIGHT_INCH);
  for (let n = 0; n < 16; n++) img.fill(0xe5, skewedOffset(n, skew), skewedOffset(n, skew) + SECTOR);
  const e = skewedOffset(0, skew);
  img.fill(0, e, e + 32);
  img.set([...'HI      TXT'].map((c) => c.charCodeAt(0)), e + 1);
  img[e + 15] = 2; // RC: two records
  img[e + 16] = 2; // block 2 = logical sectors 16-23
  img.set(new TextEncoder().encode('HELLO FROM SECTOR 16'), skewedOffset(16, skew));
  img.set(new TextEncoder().encode('AND 17'), skewedOffset(17, skew));
  return img;
}

function bytesOf(size: number, seed = 1): Uint8Array {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = (i * 7 + seed) & 0xff;
  return data;
}

describe('standard CP/M disk formats', () => {
  it('reads a standard skewed 8" image', () => {
    const image = DiskImage.fromBytes(handMadeImage(true))!;
    expect(image.xlt).not.toBeNull();
    const [hi] = image.extractFiles();
    expect(displayName(hi)).toBe('HI.TXT');
    expect(new TextDecoder().decode(hi.data.subarray(0, 20))).toBe('HELLO FROM SECTOR 16');
    expect(new TextDecoder().decode(hi.data.subarray(128, 134))).toBe('AND 17');
  });

  it('still reads unskewed 8" images saved by older versions', () => {
    const image = DiskImage.fromBytes(handMadeImage(false))!;
    expect(image.xlt).toBeNull();
    const [hi] = image.extractFiles();
    expect(new TextDecoder().decode(hi.data.subarray(0, 20))).toBe('HELLO FROM SECTOR 16');
  });

  it('writes new 8" images with the standard skew', () => {
    const image = DiskImage.blank();
    expect(image.rebuild([file('HI', 'TXT', [0x41, 0x42])])).toBe(true);
    const raw = image.toBytes();
    // Directory entry 0 sits in logical sector 0; the data in block 2 (logical 16).
    expect(String.fromCharCode(...raw.subarray(skewedOffset(0) + 1, skewedOffset(0) + 3))).toBe('HI');
    expect([...raw.subarray(skewedOffset(16), skewedOffset(16) + 2)]).toEqual([0x41, 0x42]);
  });

  it('uses EXM = 1 on 512K images (two 16K extents per directory entry)', () => {
    const image = DiskImage.fromBytes(new Uint8Array(512 * 1024))!;
    image.format();
    expect(image.dpb()[4]).toBe(1);
    const data = bytesOf(40000);
    expect(image.rebuild([{ ...file('BIG', 'BIN', []), data }])).toBe(true);
    const dir = image.dirStart;
    const raw = image.data;
    // Entry 0: 32K in 16 2K blocks, last extent 1 full. Entry 1: extent 2, 57 records.
    expect([raw[dir + 12], raw[dir + 15], raw[dir + 16 + 15] !== 0]).toEqual([1, 128, true]);
    expect([raw[dir + 32 + 12], raw[dir + 32 + 15]]).toEqual([2, Math.ceil((40000 - 32768) / 128)]);
    const [big] = DiskImage.fromBytes(image.toBytes())!.extractFiles();
    expect([...big.data.subarray(0, 40000)]).toEqual([...data]);
  });

  it('still reads 512K images saved with one extent per entry', () => {
    const raw = new Uint8Array(512 * 1024);
    const dir = 2 * 64 * SECTOR;
    raw.fill(0xe5, dir, dir + 512 * 32);
    const data = bytesOf(20000);
    // Old layout: entry per 16K (EX 0 then 1), eight 2K blocks each, from block 16.
    for (let ex = 0; ex < 2; ex++) {
      const e = dir + ex * 32;
      raw.fill(0, e, e + 32);
      raw.set([...'OLD     BIN'].map((c) => c.charCodeAt(0)), e + 1);
      raw[e + 12] = ex;
      const len = Math.min(16384, data.length - ex * 16384);
      raw[e + 15] = Math.ceil(len / 128);
      for (let i = 0; i < Math.ceil(len / 2048); i++) {
        const block = 16 + ex * 8 + i;
        raw[e + 16 + i] = block;
        raw.set(data.subarray(ex * 16384 + i * 2048, ex * 16384 + (i + 1) * 2048), dir + block * 2048);
      }
    }
    const [old] = DiskImage.fromBytes(raw)!.extractFiles();
    expect([...old.data.subarray(0, 20000)]).toEqual([...data]);
  });

  it('stores files over 512K on 4MB images using S2', () => {
    const image = DiskImage.fromBytes(new Uint8Array(4 * 1024 * 1024))!;
    image.format();
    expect(image.dpb()[4]).toBe(15);
    const data = bytesOf(700000);
    expect(image.rebuild([{ ...file('HUGE', 'BIN', []), data }])).toBe(true);
    // Third entry ends in logical extent 42: EX = 42 & 31 = 10, S2 = 1.
    const e = image.dirStart + 2 * 32;
    expect([image.data[e + 12], image.data[e + 14]]).toEqual([10, 1]);
    const [huge] = DiskImage.fromBytes(image.toBytes())!.extractFiles();
    expect([...huge.data.subarray(0, 700000)]).toEqual([...data]);
  });

  it('mounts z80pack 4MB hard disks with 16-bit block pointers', () => {
    const size = 255 * 128 * SECTOR;
    const raw = new Uint8Array(size);
    // z80pack HDBLK: no system tracks, so the directory starts at byte 0.
    raw.fill(0xe5, 0, 1024 * 32);
    raw.fill(0, 0, 32);
    raw.set([...'HD      TXT'].map((c) => c.charCodeAt(0)), 1);
    raw[15] = 1; // one record
    raw[16] = 1144 & 0xff; // first pointer, 16-bit little endian
    raw[17] = 1144 >> 8;
    raw.set(new TextEncoder().encode('BLOCK 1144'), 1144 * 2048);
    const image = DiskImage.fromBytes(raw)!;
    expect(image).toBeTruthy();
    expect(image.dpb()).toEqual([128, 0, 4, 15, 0, 2039 & 0xff, 2039 >> 8, 0xff, 0x03, 0xff, 0xff, 0, 0, 0, 0]);
    const [hd] = image.extractFiles();
    expect(displayName(hd)).toBe('HD.TXT');
    expect(new TextDecoder().decode(hd.data.subarray(0, 10))).toBe('BLOCK 1144');
  });

  it('writes z80pack hard disks with blocks above 255', () => {
    const image = DiskImage.fromBytes(new Uint8Array(255 * 128 * SECTOR))!;
    image.format();
    const first = bytesOf(600_000, 3); // 293 blocks, so the next file starts past 255
    const second = bytesOf(5000, 4);
    expect(image.rebuild([{ ...file('A', 'BIN', []), data: first }, { ...file('B', 'BIN', []), data: second }])).toBe(true);
    // Entries 0-36 hold A (37 x 16K); entry 37 is B, first block 16 + 293 = 309.
    const e = 37 * 32;
    expect(String.fromCharCode(image.data[e + 1])).toBe('B');
    expect(image.data[e + 16] | (image.data[e + 17] << 8)).toBe(309);
    const files = DiskImage.fromBytes(image.toBytes())!.extractFiles();
    expect([...files.find((f) => f.name.trim() === 'A')!.data.subarray(0, 600_000)]).toEqual([...first]);
    expect([...files.find((f) => f.name.trim() === 'B')!.data.subarray(0, 5000)]).toEqual([...second]);
  });

  it('leaves the image unchanged when a rebuild does not fit', () => {
    const image = DiskImage.blank();
    expect(image.rebuild([file('KEEP', 'TXT', [1, 2, 3])])).toBe(true);
    const before = image.toBytes();
    expect(image.rebuild([{ ...file('BIG', 'BIN', []), data: new Uint8Array(300_000) }])).toBe(false);
    expect([...image.toBytes()]).toEqual([...before]);
  });

  it('reports disk full to programs writing to a full image', async () => {
    const con = new TestConsole();
    const machine = new CpmMachine(con);
    machine.yieldFn = () => Promise.resolve();
    expect(machine.drives[1].mountImage(DiskImage.blank().toBytes())).toBe(true);
    // F_MAKE B:BIG.DAT, then F_WRITE until it fails; store the error at 0200h.
    const code = [
      0x0e, 0x16, 0x11, 0x5c, 0x00, 0xcd, 0x05, 0x00,
      0x0e, 0x15, 0x11, 0x5c, 0x00, 0xcd, 0x05, 0x00,
      0xb7, 0xca, 0x08, 0x01,
      0x32, 0x00, 0x02, 0xc9,
    ];
    machine.disk.put('FILL', 'COM', new Uint8Array(code));
    await machine.runCom(machine.disk.find(0, 'FILL    ', 'COM')!, 'FILL B:BIG.DAT');
    expect(machine.mem[0x0200]).toBe(2); // disk full
    // 243 blocks minus 2 for the directory, 1K each.
    const big = DiskImage.fromBytes(machine.drives[1].exportImage()!)!.extractFiles()[0];
    expect(big.data.length).toBe(241 * 1024);
  });
});
