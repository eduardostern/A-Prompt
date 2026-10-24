# A-Prompt — notes for Claude

CP/M 2.2 emulator for the browser in TypeScript: Z80 core, host-side BDOS,
BIOS and CCP, xterm.js terminal. Static site; the only backend is the
Worker's telnet relay. The live demo runs on Cloudflare Workers
(`wrangler.toml`). Built by DeepSeek V4.1 Flash via OpenCode, reviewed and fixed with Claude Code (Opus 5.5), final touches by
Claude Fable 5.1, telnet modem by Opus 5.5 — keep the README and the
About card's provenance text accurate if that story changes.

## Commands

```bash
npm run dev                      # http://localhost:5173
npm test                         # vitest (zex tests skipped)
npx tsc --noEmit                 # typecheck (npm run build also runs it)
npx tsc -p worker                # typecheck the Worker
npm run build                    # static site in dist/
ZEX=1 npx vitest run tests/zex.test.ts   # zexdoc + zexall, ~2.5 min
npx vite-node scripts/assemble.ts COLOR TETRIS JOSHUA TERM XMODEM ZMODEM && npm run embed
                                 # rebuild the sample .COMs from programs/*.ASM
```

Run `npx tsc --noEmit` and `npm test` before every commit. Rerun the zex
exerciser after any change to `src/z80.ts`.

## Workflow

- Commit straight to `main` (single-developer repo). Push only when the user
  says so; `main` may feed the live demo. Check CI afterwards with
  `gh run list --limit 1`.
- Commit style: `feat:`, `fix:`, `docs:` with a body that says why.
- Every bug fix gets a regression test that fails on the old code. To check
  that, use a temporary worktree at HEAD — never `git stash` the fix while a
  test that might hang is running:
  `git worktree add --detach <scratch>/old-tree HEAD`, symlink
  `node_modules`, copy the new tests in, run, then `git worktree remove`.

## Layout

| Path | Role |
| --- | --- |
| `src/z80.ts` | Z80 interpreter, Zilog T-state tables (`timing()` in `step()`) |
| `src/cpm/layout.ts` | Memory map constants — change addresses only here |
| `src/cpm/machine.ts` | Run loop, BDOS/BIOS traps, clock limit, default FCBs |
| `src/cpm/bdos.ts` | BDOS functions, directory search, allocation vector |
| `src/cpm/ccp.ts` | Built-in commands, SUBMIT queue |
| `src/cpm/disk.ts` | File drive, `DriveFormat`, `FILE_DRIVE_FORMAT`, capacity |
| `src/cpm/image.ts` | Raw `.dsk` images: geometries, skew, extents, rebuild |
| `src/storage.ts` | localStorage encoding (deflate + base64, v3 records) |
| `src/main.ts` | UI wiring, persistence, uploads, toolbar |
| `src/cpm/modem.ts` | Hayes modem on ports 04h/05h, telnet options |
| `src/phonebook.ts` | BBSes the modem may dial (relay allowlist) |
| `worker/index.ts` | Cloudflare Worker: `/relay` WebSocket-to-telnet |
| `src/bell.ts` | VT100 bell, 786 Hz square wave for 250 ms |
| `src/display.ts` | Display settings, presets, phosphor themes (pure) |
| `src/display-ui.ts` | Display card; CRT effects are CSS classes on `#terminal-wrap` |
| `src/fonts/` | Period terminal fonts with their licences |
| `src/power.ts` | Power switch and CRT warm-up before the first boot |
| `src/drives.ts` | Drive kinds of the era and their timing (`DriveTiming`) |
| `src/drive-sound.ts` | Drive and key-click sounds; accesses come from `Bdos.onDisk`/`touch()` |
| `src/confirm.ts` | Styled yes/no dialog (use it, not `confirm()`) |

## I/O ports

One device, the telnet modem (`src/cpm/modem.ts`): IN 04h status (bit 0
byte ready, bit 1 can send, bit 7 carrier), OUT 04h bit 0 = DTR (0 hangs
up), IN/OUT 05h data. It is also READER/PUNCH (BDOS 3/4). Every other port
reads FFh and OUT is a sink. Programs that need real time use BDOS 105
(T_GET), which returns the seconds in A like CP/M 3.

The modem dials a board's own WebSocket gateway directly when the phone
book lists one (`ws`, subprotocol `binary`; the stream is telnet) or for
`ATDT wss://…`, and falls back to `worker/index.ts`, a WebSocket-to-TCP relay
that connects only to `src/phonebook.ts` entries. The relay sends one text
frame, `CONNECT`, then raw bytes in binary frames. The modem handles telnet
IAC and, once it sees telnet, asks for BINARY both ways (no CR NUL) so
XMODEM/ZMODEM data passes untouched; a peer that never sends IAC gets raw
bytes.
Binary frames reach the Worker as `Blob` with this compatibility date, not
`ArrayBuffer`. Test the relay with `npm run build && npx wrangler dev`
(port 8787); `npm run dev` proxies `/relay` there.

## Memory map

TPA `0100h–FBFFh`; BDOS entry `FC06h` (at `0006h`); CCP stack below
`FD00h`; ALV `FD00h` (256 bytes); BIOS jump table `FE00h`, host traps
`FE40h`; DPH `FE80h`, DPB `FE90h`, dirbuf `FF00h`. Everything the system owns
sits above the BDOS entry so programs can use the whole TPA. `0004h` holds
user/drive; the CCP restores both from it after each program.

## CP/M behaviour that is easy to get wrong

- BDOS 6 with E=FFh must not block; `ConsoleIO.hasInput()` peeks without
  consuming, `pollByte()` consumes.
- Random read/write leave the FCB on the same record (no `+1`).
- The FCB record number is S2:EX:CR (`((S2 & 3Fh) << 12) | (EX << 7) | CR`);
  EX never exceeds 31, the overflow goes to S2.
- F_OPEN keeps the EX/S2 the program asked for and never touches CR; it
  fails with FFh when the file has no such extent. RC describes that extent.
- BIOS READ/WRITE copy to the exact DMA address; it need not be aligned.
- BDOS console output (1, 2, 6, 9) pauses on ^S and warm boots on ^C typed
  during the pause, via `ConsoleIO.peekByte()`; BIOS CONOUT is raw.
- BDOS 10 returns when the buffer is full, on CR or on LF; ^C reboots only
  at the start of the line.
- DMA resets to `0080h` and open files are forgotten before each program.
- Search first (BDOS 17) returns only the extent named in EX/S2 unless EX is
  `?`; `?` in the drive byte searches all user areas.
- Default FCBs follow the CCP's fillfcb: names end only at
  `space = _ . : ; < >`, so `$R/O` reaches STAT intact.
- `$$$.SUB` is written by SUBMIT.COM to the current drive and user; the
  lookup searches A:, then the current drive, then the rest.
- Real CP/M text files end with `^Z` (1Ah); SUBMIT rejects `.SUB` files
  without it.

## Disk formats

- 8" SSSD (256,256 bytes): IBM 3740 skew 6, as cpmtools `ibm-3740` and
  z80pack. Unskewed images from older A-Prompt versions are detected by
  directory validity. BIOS sector numbers are logical; skew is applied in
  `DiskImage.sectorOffset`.
- 512K (EXM 1), 4MB (EXM 15), z80pack 4MB hard disk (4,177,920 bytes,
  DSM 2039, 16-bit block pointers, OFF 0 — z80pack's `HDBLK`).
- File drives report the z80pack hard disk format (`FILE_DRIVE_FORMAT`), so
  STAT and SURVEY agree with what they show on z80pack.
- Images written before EXM was honoured put one 16K extent per entry;
  `extractFiles` detects the collision and still reads them.
- Real test disks: z80pack's `cpmsim/disks/library` (`cpm22-1.dsk`,
  `hd-tools.dsk`, …) via raw.githubusercontent.com — download to the
  scratchpad, never into the repo.

## Modem speaker

- `withCallSound` (`src/call-sound.ts`) wraps the dialer: `startCallSound`
  (`src/modem-audio.ts`) plays dial tone, DTMF for a made-up number
  (`digitsFor`), ringback, then the handshake, and only then opens the
  connection; after that nothing is held. BBSes probe the terminal
  (ESC[6n, telnet options) as soon as the connection opens and give up on
  late answers, so the line must not wait for the sound. Failure plays
  busy; the modem's own close after a remote hang-up must not stop that.
  The same call-sound and modem-audio code is in Ok-Prompt and K-Prompt.
- `ATM0` (no sound, no delay), `ATL0-3`, `AT&W` saves to localStorage
  `a-prompt.modem`, `ATZ` restores, `AT&F` resets. The bell and the modem
  share one AudioContext (`src/audio.ts`).
- The `Synth` schedule functions take any BaseAudioContext: render them in
  an OfflineAudioContext (browser) and check frequencies with Goertzel.

## AI board

- `ATDT DEEPSEEK` / `ATDT AI`: `modemDialer` in `src/main.ts` returns
  `createAiBoard` (`src/aiboard.ts`), a Link that acts as a telnet server in
  BINARY mode (`src/cpm/telnet-server.ts`) so ZMODEM data passes the modem.
- DeepSeek is called from the browser (`src/deepseek.ts`, model
  `deepseek-flash` = V4.1 Flash, SSE, `reasoning_effort` none for chat and
  high for code); CORS allows our origin. The key is the visitor's own, in
  localStorage `a-prompt.deepseek-key`, set from the AI board card or the
  board's key prompt. Never route it through the Worker.
- Programs: `PROGRAM_PROMPT` holds the DRI ASM rules; `assemble()` in
  `src/cpm/assembler.ts` (also used by `scripts/assemble.ts`) runs ASM and
  LOAD headless; error lines go back to the model, three tries; files go
  out with `ZmodemSender` (`src/zmodem.ts`).
- `[F]` fixes an uploaded program: `ZmodemReceiver` (same file; CRC-16,
  CRC-32 when offered, ZRPOS from the last good byte) takes one `.ASM` up
  to 64K from `ZMODEM S`; `sourceText` cuts it at ^Z; the board assembles
  it, asks what to change, and runs `FIX_PROMPT` (PROGRAM_PROMPT plus "keep
  the rest") through the same `build()` loop and sender.
- Builds show live (`LiveView`): reasoning indented and word-wrapped,
  then the source. Over 2 s of backlog at the board's baud rate, it
  finishes the sentence or line, skips until the backlog is under a
  quarter of that, and resumes at the next one after `...`.
- `build()` keeps the conversation in `session`; after the transfer the
  board asks for more changes (`'more'` mode), appends them and builds
  again, `trimHistory` capping it at `MAX_HISTORY_CHARS`. For 1.5 s after
  a transfer, control bytes on an empty line are ZMODEM debris (the ZFIN
  header's CR LF XON), not Enter.
- Chat personas live in `PERSONAS` (`[C]` sysop, `[B]` BOFH, each with its
  own history). The BOFH may end a reply with `[HANGUP]`: the board strips
  it, even split across chunks, and drops the line.
- Tests use a fake `chat` and `cps: 0` (`tests/aiboard.test.ts`); no test
  calls DeepSeek.

## Sample programs

- `programs/*.ASM` are 8080 sources for DRI ASM 2.0: no Z80 mnemonics, and
  `TITLE`/`PAGE` are pseudo-ops, not usable as labels. `;` inside a string
  is safest as a `3BH` byte. `scripts/assemble.ts` runs ASM and LOAD inside
  the emulator; a line starting with an error letter means a failed assembly.
- `DB` strings are at most 64 characters in DRI ASM (error `O`); write
  lower-case hex digits and other case-sensitive bytes as numbers.
- TERM, XMODEM and ZMODEM talk to the modem ports directly. Ctrl-] leaves
  TERM with the call up so XMODEM/ZMODEM can run; their timeouts count
  T_GET seconds. `tests/transfer.test.ts` runs them against lrzsz (Homebrew
  `lsz`/`lrz`, Debian `sz`/`rz`; CI installs it, elsewhere the tests skip):
  a telnet BINARY peer in front of the child process, with optional
  one-byte corruption each way.
- TETRIS paces itself with a busy loop that it re-tunes every clock second
  from the T_GET seconds to 16 ticks a second (so any MHz setting plays
  the same); without the call it keeps the 4 MHz default. Tests replace
  `machine.now` (ms since the epoch, feeds the BDOS clock) with a fake.

## Testing tips

- `tests/cpm.test.ts` has `boot()`, `run(machine, code, line)` and
  `bdos(fn, de)` for hand-assembled probe programs.
- The test console fails after 10,000 reads with no input, so a test that
  waits for input it never feeds fails instead of hanging.
- Quick experiments: write a `.ts` script in the scratchpad importing from
  `/Users/eduardo/cpm/src/...` and run it with `npx vite-node <script>`.
- Browser checks: `npm run build`, `npx vite preview --port 4179`, then
  `playwright-cli` (`run-code` with an inline `async page => {...}`; this
  version has no `--raw` or `--filename`). Run it from the scratchpad so
  `.playwright-cli/` snapshots stay out of the repo.
- A fresh page waits at the power switch: press a key (it never reaches
  CP/M) or set localStorage `a-prompt.autopower` to `1` before loading.
  Reset sets sessionStorage `a-prompt.warm-reboot` and skips the switch.
- Drive speed of the era: `onDisk` prices each access with `DriveTiming`,
  `machine.owe(ms)` adds it, and the run loop, `runCom` and the CCP
  built-ins `await machine.payDisk()`. Tests replace `machine.sleepFn`.
- Imports through the UI are capped at 512 KB per file (`MAX_UPLOAD`).
- Check the toolbar at 320, 375 and 430 px widths after UI changes.
