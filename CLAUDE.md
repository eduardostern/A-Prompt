# A-Prompt — notes for Claude

CP/M 2.2 emulator for the browser in TypeScript: Z80 core, host-side BDOS,
BIOS and CCP, xterm.js terminal. Static site, no backend. The live demo
runs on Cloudflare Workers (`wrangler.toml`). Built by DeepSeek V4.1 Flash via
OpenCode, then reviewed and fixed with Claude Code — keep the README and the
About card's provenance text accurate if that story changes.

## Commands

```bash
npm run dev                      # http://localhost:5173
npm test                         # vitest (zex tests skipped)
npx tsc --noEmit                 # typecheck (npm run build also runs it)
npm run build                    # static site in dist/
ZEX=1 npx vitest run tests/zex.test.ts   # zexdoc + zexall, ~2.5 min
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
- Imports through the UI are capped at 512 KB per file (`MAX_UPLOAD`).
- Check the toolbar at 320, 375 and 430 px widths after UI changes.
