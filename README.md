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
their exact 8.3 names. Tested from that archive:

- **Sargon 2.1** (`SARGON.COM`) — plays normally; the zip installer runs it
  automatically.
- **Nemesis** (`NEMESIS.COM` + data files) — installs and starts; it needs a
  `TERM.DEF`, so run `TERMDEF` first, then `NEMESIS <character>` (characters
  are created with `PERSON.COM`).
- **Zork I** (`ZORK1.COM` + `ZORK1.DAT`) — intro, movement and parser work.
- **Adventure** (`ADVENTUR.COM` + the `.DAT` files) — needs the message file
  unsqueezed first: run `USQ ADVENTUR.MQG`, accept `ADVENTUR.MSG`, then start
  the game.

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

## Credits and license

- Emulator code: MIT (`LICENSE`).
- CP/M binaries: © Digital Research, redistributed under the license granted
  by DRDOS, Inc. / Bryan Sparks, available at
  [cpm.z80.de/license.html](http://www.cpm.z80.de/license.html).
- `HELLO.COM`, `HELLO.ASM` and `DEMO.SUB` are original examples for this
  project.
- xterm.js is © its authors, MIT license.
