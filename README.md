# A-Prompt

[![Live demo](https://img.shields.io/badge/live-a--prompt.stern.workers.dev-5ee08f?style=flat-square)](https://a-prompt.stern.workers.dev)
[![CI](https://github.com/eduardostern/A-Prompt/actions/workflows/ci.yml/badge.svg)](https://github.com/eduardostern/A-Prompt/actions/workflows/ci.yml)
[![GitHub](https://img.shields.io/badge/source-GitHub-181717?style=flat-square)](https://github.com/eduardostern/A-Prompt)
[![Games](https://img.shields.io/badge/games-RetroArchive-e3d27c?style=flat-square)](http://www.retroarchive.org/cpm/games/games.htm)
[![License: MIT](https://img.shields.io/badge/license-MIT-5ee08f?style=flat-square)](LICENSE)

**A-Prompt** is a CP/M 2.2 emulator for the browser, written from scratch in
TypeScript. Under the hood: a complete **Z80 CPU**, a BDOS with 8.3 files,
FCBs and user areas, a console, and a CCP with the classic commands. It runs
the original Digital Research binaries distributed at
[cpm.z80.de](http://www.cpm.z80.de).

> **No Former-OpenAI tokens were harmed during the creation of this piece of software.**
>
> Built with [OpenCode](https://opencode.ai) + DeepSeek V4.1 Flash. No Claude,
> GPT, or Grok was consulted, prompted, or otherwise awakened. The only
> transformer involved is the one in the power supply.

**Live demo:** <https://a-prompt.stern.workers.dev>

**Created by [Eduardo Stern](mailto:eduardostern@icloud.com)** · [GitHub](https://github.com/eduardostern)

The name comes from CP/M's unmistakable `A>` prompt.

![A-Prompt terminal](docs/screenshot.png)

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/
npm run preview  # serve the build
```

There is no backend and no WebAssembly: `dist/` is a plain static site.

The terminal fills the viewport. Use **Panels** in the console toolbar to hide or show the right rail; its sections collapse and scroll independently (on mobile the rail becomes a drawer).

## What works

- **Z80 CPU**: documented and undocumented instructions (SLL, IXH/IXL, DDCB,
  ED block ops, etc.). Passes `zexdoc` and `zexall` (all groups OK).
- **CP/M 2.2**: console, FCBs, sequential and random files, directory search,
  rename, attributes, user areas 0–15, DMA and DPB.
- **CCP**: `DIR`, `ERA`, `TYPE`, `REN`, `USER`, `SAVE`, `CLS`, `HELP`, drive
  selection (A:–D:), and `.COM` execution with command tail and default FCBs.
- **Real `SUBMIT`**: the CCP consumes `$$$.SUB` one record at a time;
  **`XSUB`** feeds the remaining lines to programs that read the console.
- **Terminal profiles**: ANSI/VT100, ADM-3A and VT52 escape-sequence
  translation, with CP437 character mapping.
- **Disk images**: mount/export raw 8" SSSD (77×26), 512K and 4MB
  `.dsk`/`.img` images. BIOS sector I/O (`SELDSK`, `SETTRK`, `SETSEC`,
  `SETDMA`, `READ`, `WRITE`, `SECTRAN`) and a CP/M 2.2 filesystem are
  implemented, so tools like FORMAT and DSKMAINT can work on mounted images.
- **Clock and devices**: virtual clock via CP/M 3-style `T_GET`/`T_SET`
  (BDOS 104/105) and `DATE`; printer/serial bytes captured to downloadable
  logs (BDOS 4/5 and BIOS LIST/PUNCH).
- **Upload/download** from the drive panel; drives A:–D: (4 MB each, 16K
  blocks) are persisted in the browser's `localStorage`.

Bundled programs: **PIP**, **STAT**, **DDT**, **ED**, **ASM**, **LOAD**,
**SUBMIT**, **DUMP**, **HELLO.COM**, **INPUT.COM**, plus **DEMO.SUB** and
**XSUB.SUB**.

```text
A>DIR
A>HELLO
A>STAT
A>ED HELLO.ASM
A>ASM HELLO.ASM
A>LOAD HELLO
A>SUBMIT DEMO
A>SUBMIT XSUB
A>DATE
```

## Running games

**Archive:** <http://www.retroarchive.org/cpm/games/games.htm>

Direct downloads:
[Sargon 2.1](http://www.retroarchive.org/cpm/games/sargon.zip) ·
[Nemesis](http://www.retroarchive.org/cpm/games/nemesis.zip) ·
[Zork I–III](http://www.retroarchive.org/cpm/games/zork123_80.zip) ·
[Adventure + many games](http://www.retroarchive.org/cpm/games/manygame.zip)

Most CP/M `.COM` games work if you upload the program and any data files with
their exact 8.3 names. The **Install game .zip** button accepts a downloaded
zip, installs its files on the selected drive, and runs the game when the
main `.COM` is unambiguous. You can also drop a zip on the drive panel.

### Sargon 2.1

1. Click **Sargon ↓** and save `sargon.zip`.
2. Keep drive **A:** selected and click **Install game .zip**; choose the zip.
3. It installs `SARGON.COM` and starts it automatically.
4. Answer the prompts: error bell `N`, `G` for a new game, printer `N`,
   color `W`, level `1`, display board `Y`.

### Nemesis

1. Click **Nemesis ↓** (the zip includes a scanned manual and is ~6 MB).
2. **Install game .zip** → `nemesis.zip`. It installs 36 files and starts
   `NEMESIS`.
3. Nemesis needs `TERM.DEF`. Run `TERMDEF` once:

   ```text
   A>TERMDEF
   ```

   - Answer `N` to “exit and change disks?”
   - Choose `2` (define terminal), then `9` (DEC VT-52/VT-100)
   - Use `6` to test, `7` to install, `8` to exit
   - Select **ANSI / VT100** (or VT52) in the A-Prompt toolbar to match
4. Create a character with `PERSON` (follow its prompts).
5. Start the game:

   ```text
   A>NEMESIS ALICE
   ```

### Zork I–III

The Zork archive uses the old **Implode** compression, which the in-app
installer cannot decode (it shows a “legacy Implode” message).

1. Click **Zork I–III ↓** and download `zork123_80.zip`.
2. Extract it with your OS (double-click on macOS, “Extract All” on Windows,
   `unzip` on Linux).
3. Drag `ZORK1.COM` and `ZORK1.DAT` onto the Drive A: panel. For the sequels,
   also add `ZORK2.COM`/`ZORK2.DAT` and `ZORK3.COM`/`ZORK3.DAT`.
4. Start it:

   ```text
   A>ZORK1
   ```

   (Use `ZORK2` / `ZORK3` for the others.)

### Adventure (manygame.zip)

`manygame.zip` contains several games. Installing the whole zip works, but it
is cleaner to upload only the Adventure files.

1. Click **Adventure + more ↓** and extract `manygame.zip`.
2. Upload these files from `ADVENT~2/` to drive A:
   `ADVENTUR.COM`, `ATAB.DAT`, `COMMON.DAT`, `KTAB.DAT`, `LTEXT.DAT`,
   `RTEXT.DAT`, `STEXT.DAT`, `TRAVEL.DAT`, `USQ.COM`, `ADVENTUR.MQG`.
3. If `COMMON.DAT` already exists as 0 bytes, delete it first.
4. Decode the squeezed message file:

   ```text
   A>USQ ADVENTUR.MQG
   ```

   Press Enter to accept `ADVENTUR.MSG`.
5. Run it and enter any three digits when asked:

   ```text
   A>ADVENTUR
   ```

Select ADM-3A or VT52 in the console toolbar if a game assumes one of those
terminals.

**Copyright:** old does not mean public domain. Zork, Sargon and most 1980s
titles are still protected (in the US, works published after 1978 are commonly
protected for 95 years). A-Prompt does not bundle or redistribute these games;
the links point to RetroArchive, which hosts them for preservation. Check the
terms of each archive and your local law before downloading.

**Legacy zips:** the built-in installer handles standard ZIPs (Sargon,
manygame). The Zork archive uses the old Implode method; extract it with your
OS unzip tool and drop the `.COM`/`.DAT` files on a drive (or re-zip it with
Deflate).

## Deploy on Cloudflare

A-Prompt is a static site: no server code, no environment variables, no
database. The whole CP/M disk image is embedded in the JavaScript bundle.

### Workers (current dashboard flow)

1. **Workers & Pages → Create → Connect to Git** and select the repo.
2. Build command: `npm run build`
3. Deploy command: `npx wrangler deploy`
4. Node version: 22 (the repo includes `.nvmrc`).
5. Deploy.

`wrangler.toml` publishes `./dist` as **Workers Static Assets**; no Worker
script is needed.

From the CLI:

```bash
npm run build
npx wrangler deploy
```

### Pages (legacy flow)

If you prefer the Pages workflow, click **“Continue to Pages”** on the create
screen and use:

- Build command: `npm run build`
- Build output directory: `dist`
- Node version: 22

Or deploy from the CLI:

```bash
npm run build
npx wrangler pages deploy dist
```

In both cases, uploads and files created inside CP/M are stored in the
visitor's browser (`localStorage`), so every visitor has their own drive A:.

## Software

These are the CP/M classics. A-Prompt does not bundle them; download the
original files from RetroArchive and install them with **Install .zip** (or
**Import files** for a single `.COM`).

### WordStar 3.3

1. Download [WS330.zip](http://www.retroarchive.org/cpm/text/WS330.zip).
2. **Install .zip** → `WS330.zip`.
3. Run `WINSTALL` and choose your terminal (ANSI Standard).
4. Start the editor with `WS` (or `WSU` after installation).

### MBASIC / BASIC-80 5.21

1. Download [Mbasic.com](http://www.retroarchive.org/cpm/lang/Mbasic.com).
2. Drag the `.COM` onto drive A (or **Import files**).
3. Run `MBASIC`; you should see `BASIC-80 Rev. 5.21` and an `Ok` prompt.
4. Leave BASIC with `SYSTEM`.

### dBASE II 2.3B (works)

The Kaypro 2.43 build and the 2.4 build install but stall in a blank overlay
loop. The **2.3B generic build works**:

1. Download [ASHTONPAK.ZIP](http://www.retroarchive.org/cpm/dbase/ashtonpak.zip)
   (1.2 MB; it contains several Ashton-Tate programs).
2. Extract only `DBASE-II/CPM80/V2-3B/` from the zip.
3. Upload all files from that folder to a drive (or zip just that folder and
   use **Install .zip**).
4. Run `DBASE`; press **Enter** at `ENTER TODAYS DATE AS MM/DD/YY` and you get
   the dot prompt.

Tested: `dBASE II Ver 2.3B 22 FEB 82`, `. ? 2+2` → `4`. The Kaypro-specific
2.43 build still has the blank-screen problem and is not recommended.

### Turbo Pascal 3

1. Download [tpas30.zip](http://www.retroarchive.org/cpm/lang/tpas30.zip).
2. **Install .zip** → `tpas30.zip`.
3. Run `TINST` once to set your terminal, then `TURBO`.

Tested: it boots into the Turbo Pascal 3.00A IDE (default “Kaypro with
hi-lite” terminal); use `TINST` to switch to ANSI.

### SuperCalc 1.x / 2

1. Download [Suprcalc.zip](http://www.retroarchive.org/cpm/business/Suprcalc.zip)
   or [sc2.zip](http://www.retroarchive.org/cpm/business/sc2.zip).
2. **Install .zip**.
3. Run `INSTALL` → `M` (ANSI Standard) → confirm → `A` save → `X` quit.
4. Start with `SC` (or `SC2`).

`INSTALL` works and saves the ANSI configuration; `SC` 1.x still did not draw
the spreadsheet in testing. Try `SC2`, and select the matching terminal
profile.

All of these are still copyrighted; the links point to the original archive.
The emulator only installs files you download.

## Disk images

Drives A:–D: are host-folder drives by default. Use **Export .dsk** to turn
one into a raw 8" image, then **Mount .dsk** on any drive to work with raw
sectors. The image panel supports 8" SSSD (77 tracks × 26 sectors), 512K and
4MB images; the CP/M filesystem is decoded and rebuilt automatically.

With an image mounted, `FORMAT`, `DSKMAINT` and other BIOS-level tools can
read and write sectors. **Eject** converts the image back into the in-memory
file list (use **Export .dsk** to keep it).

## Limitations

- Drive A: is a host-folder drive by default. Raw-sector tools (FORMAT,
  DSKMAINT) need a mounted image; export A: as `.dsk` and mount it first.
- CP/M 2.2 only (not CP/M 3). The clock is available through CP/M 3-style
  `T_GET`/`T_SET` calls; serial is output-only (captured to a log).
- Terminal profiles cover ANSI/VT100, ADM-3A and VT52; software that requires
  another terminal (Hazeltine, Televideo, Wyse, etc.) may render oddly.

## What is CP/M?

CP/M — **Control Program for Microcomputers** — was the first widely
standard operating system for microcomputers. Gary Kildall wrote it at Digital
Research in 1974; CP/M 2.2, the version this emulator implements, arrived in
1979. It became the default OS for 8080/Z80 business machines: Altair,
Osborne, Kaypro, Xerox, North Star, Epson and many others.

**Why the Z80?** CP/M was written for the Intel 8080. The Z80 is
binary-compatible with the 8080, cheaper, and adds instructions and registers.
Most CP/M software is plain 8080 code and runs on a Z80 unchanged.

**The standardization trick** was splitting the machine into three layers:

- **BIOS** — the hardware-specific part (console, disk controller)
- **BDOS** — files, directory, console and the API reached through `CALL 5`
- **CCP** — the `A>` prompt and built-in commands

Programs never touched the hardware directly. Add shared conventions — 8.3
filenames, 128-byte records, FCBs, user areas, the TPA, `.COM` files — and the
same binary could run on completely different machines.

**What ran on it:** WordStar, dBASE II, SuperCalc, MultiPlan, Turbo Pascal,
MBASIC, FORTRAN, COBOL, assemblers, and games such as Sargon, Zork, Adventure
and Nemesis.

### VisiCalc and SuperCalc

VisiCalc (1979, Dan Bricklin and Bob Frankston) was the first spreadsheet and
the “killer app” of personal computing. It did have CP/M ports, but they were
niche: the **HP 125** and **Sony SMC-70** versions are the CP/M releases. The
mass-market VisiCalc ran on the Apple II, Atari, TRS-80 and IBM PC.

The spreadsheet that actually shipped with CP/M business machines was
**SuperCalc** (Sorcim, 1980; bundled with the Osborne 1). A-Prompt links to it
from the **Software** card:

- [SuperCalc 1.x](http://www.retroarchive.org/cpm/business/Suprcalc.zip)
- [SuperCalc 2](http://www.retroarchive.org/cpm/business/sc2.zip)

Install the zip, then configure the terminal once:

```text
A>INSTALL
```

Answer `Y`, choose `M` (ANSI Standard), confirm, then `A` to save and `X` to
quit. Start it with `SC` (or `SC2` for version 2). Neither program is bundled;
both are still copyrighted.

A-Prompt does not bundle VisiCalc or SuperCalc. If you have a CP/M `.COM`,
upload it to a drive and run it.

- [CP/M on Wikipedia](https://en.wikipedia.org/wiki/CP/M)
- [VisiCalc on Wikipedia](https://en.wikipedia.org/wiki/VisiCalc)
- [SuperCalc on Wikipedia](https://en.wikipedia.org/wiki/SuperCalc)

## Architecture

| File | Role |
| --- | --- |
| `src/z80.ts` | Z80 interpreter: flags, prefixes, approximate cycles |
| `src/cpm/disk.ts` | In-memory drive, 8.3 names, wildcards, user areas |
| `src/cpm/image.ts` | Raw `.dsk` images, CP/M 2.2 directory and block allocation |
| `src/cpm/bdos.ts` | BDOS calls (`CALL 5`) and CP/M directory |
| `src/cpm/ccp.ts` | Shell, FCB parsing, `SUBMIT` |
| `src/cpm/machine.ts` | Memory map, BDOS/BIOS traps, execution loop |
| `src/terminal.ts` | xterm.js + CP437 + keyboard |

The memory map is the classic one: `0000h` jumps to the BIOS, `0005h` to the
BDOS at `FE00h`, and the BIOS jump table lives at `F000h`. Calls are
intercepted on the host, which lets the BDOS wait for keyboard input without
blocking the UI.

## Tests

```bash
npm test                   # CP/M + Z80 tests (fast)
ZEX=1 npm test             # adds the zexdoc/zexall exercisers (long)
```

`zexdoc`/`zexall` are Frank Cringle's Z80 instruction exercisers (public
domain) and live in `tests/fixtures/`.

## AI provenance

This project was built with [OpenCode](https://opencode.ai) and **DeepSeek
V4.1 Flash**. No Claude, GPT, Grok, or other OpenAI/Anthropic/xAI model was
involved — so no former-OpenAI tokens were harmed. The only transformer here
is the one in the power supply.

## Author

**Eduardo Stern** — <eduardostern@icloud.com> — [github.com/eduardostern](https://github.com/eduardostern)

A-Prompt was designed and built by Eduardo Stern. See `AUTHORS`.

## Credits and license

- A-Prompt source, UI, tests and original documentation: **MIT**, © 2026
  Eduardo Stern (`LICENSE`).
- CP/M binaries: © Digital Research, redistributed under the license granted
  by DRDOS, Inc. / Bryan Sparks, available at
  [cpm.z80.de/license.html](http://www.cpm.z80.de/license.html).
- `HELLO.COM`, `HELLO.ASM` and `DEMO.SUB` are original examples for this
  project.
- xterm.js, fflate and other dependencies retain their own MIT licenses.
- `zexdoc`/`zexall` are Frank Cringle's public-domain Z80 exercisers.
