import './style.css';
import { unzip } from './zip';
import { XtermConsole } from './terminal';
import type { TerminalType } from './terminal-translator';
import { CpmMachine } from './cpm/machine';
import { BUILTIN_FILES } from './assets/builtin-programs';
import type { Disk } from './cpm/disk';
import { CpmFile, MAX_BYTES, displayName, padExt, padName, trimName } from './cpm/disk';

const LS_PREFIX = 'a-prompt.drive.';
const LEGACY_LS_KEY = 'a-prompt.drive.v1';
const TERM_KEY = 'a-prompt.terminal';
const MAX_UPLOAD = 512 * 1024;

const letterFor = (index: number): string => String.fromCharCode(65 + index);
const driveKey = (index: number): string => `${LS_PREFIX}${letterFor(index)}.v2`;

// ---- helpers ----------------------------------------------------------

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToB64(data: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    s += String.fromCharCode(...data.subarray(i, i + chunk));
  }
  return btoa(s);
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function toCpmName(filename: string): { name: string; ext: string } {
  const base0 = filename.replace(/\\/g, '/').split('/').pop() ?? filename;
  const dot = base0.lastIndexOf('.');
  const rawBase = dot > 0 ? base0.slice(0, dot) : base0;
  const rawExt = dot > 0 ? base0.slice(dot + 1) : '';
  const clean = (s: string, len: number) =>
    s
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9$#@!%&'()\-_{}~`]/g, '')
      .slice(0, len);
  return { name: padName(clean(rawBase, 8) || 'FILE'), ext: padExt(clean(rawExt, 3)) };
}

// ---- boot the disks ---------------------------------------------------

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
};

const con = new XtermConsole(el('terminal'));
const machine = new CpmMachine(con);
const drives = machine.drives;
let activeDrive = 0;
let lastMachineDrive = 0;

const builtinData = new Map<string, string>();
for (const f of BUILTIN_FILES) builtinData.set(`${f.name}.${f.ext}`, f.data);

function loadBuiltins(): void {
  for (const f of BUILTIN_FILES) {
    drives[0].put(f.name, f.ext, b64ToBytes(f.data));
  }
}

interface StoredFile {
  n: string;
  e: string;
  u: number;
  d: string;
}

interface StoredDrive {
  v?: number;
  files?: StoredFile[];
  image?: string;
}

function saveDrive(index: number): void {
  const disk = drives[index];
  if (disk.image) {
    try {
      disk.syncImage();
      const bytes = disk.exportImage();
      if (bytes) localStorage.setItem(driveKey(index), JSON.stringify({ v: 2, image: bytesToB64(bytes) }));
    } catch {
      /* quota exceeded: keep the image in memory */
    }
    return;
  }
  const files: StoredFile[] = [];
  for (const f of disk.files) {
    if (trimName(f.name) === '$$$') continue; // transient SUBMIT queue
    const key = `${trimName(f.name)}.${trimName(f.ext)}`;
    const pristine = index === 0 && f.user === 0 && builtinData.get(key) === bytesToB64(f.data);
    if (pristine) continue;
    files.push({ n: trimName(f.name), e: trimName(f.ext), u: f.user, d: bytesToB64(f.data) });
  }
  try {
    if (files.length) localStorage.setItem(driveKey(index), JSON.stringify({ v: 2, files }));
    else localStorage.removeItem(driveKey(index));
  } catch {
    /* quota exceeded: keep running in memory */
  }
}

function saveAllDrives(): void {
  for (let i = 0; i < drives.length; i++) saveDrive(i);
}

function restoreDrive(index: number): void {
  try {
    let raw = localStorage.getItem(driveKey(index));
    let legacy = false;
    if (!raw && index === 0) {
      raw = localStorage.getItem(LEGACY_LS_KEY);
      legacy = !!raw;
    }
    if (!raw) return;
    const parsed = JSON.parse(raw) as StoredDrive;
    if (typeof parsed.image === 'string') {
      const bytes = b64ToBytes(parsed.image);
      if (bytes.length <= MAX_BYTES * 2) drives[index].mountImage(bytes);
      return;
    }
    if (!parsed.files) return;
    for (const f of parsed.files) {
      if (typeof f.n !== 'string' || typeof f.d !== 'string') continue;
      const data = b64ToBytes(f.d);
      if (data.length > MAX_BYTES) continue;
      drives[index].put(f.n, f.e, data, f.u & 0x0f);
    }
    if (legacy) localStorage.removeItem(LEGACY_LS_KEY);
  } catch {
    /* corrupted storage is ignored */
  }
}

// ---- UI ---------------------------------------------------------------

const fileList = el<HTMLUListElement>('file-list');
const driveTabs = el<HTMLDivElement>('drive-tabs');
const driveTitle = el('drive-title');
const imageBadge = el('image-badge');
const imageInput = el<HTMLInputElement>('image-input');
const mountImageBtn = el<HTMLButtonElement>('mount-image-btn');
const exportImageBtn = el<HTMLButtonElement>('export-image-btn');
const ejectImageBtn = el<HTMLButtonElement>('eject-image-btn');
const consoleDrive = el('console-drive');
const terminalSelect = el<HTMLSelectElement>('terminal-type');
const usage = el('usage');
const usageBar = el<HTMLDivElement>('usage-bar');
const led = el('led');
const statusText = el('status-text');
const dropzone = el('dropzone');
const fileInput = el<HTMLInputElement>('file-input');
const uploadBtn = el<HTMLButtonElement>('upload-btn');
const resetBtn = el<HTMLButtonElement>('reset-btn');
const gameZipInput = el<HTMLInputElement>('game-zip-input');
const gameZipBtn = el<HTMLButtonElement>('game-zip-btn');
const softwareZipBtn = el<HTMLButtonElement>('software-zip-btn');
const clockEl = el('clock');
const printerCount = el('printer-count');
const serialCount = el('serial-count');
const printerDownload = el<HTMLButtonElement>('printer-download');
const printerClear = el<HTMLButtonElement>('printer-clear');
const serialDownload = el<HTMLButtonElement>('serial-download');
const serialClear = el<HTMLButtonElement>('serial-clear');
const consolePanel = document.querySelector<HTMLElement>('.console-panel')!;
const infoDialog = el<HTMLDialogElement>('cpm-info');

document.querySelectorAll<HTMLAnchorElement>('.info-open').forEach((link) => {
  link.addEventListener('click', (ev) => {
    ev.preventDefault();
    infoDialog.showModal();
  });
});
infoDialog.querySelector<HTMLButtonElement>('.info-close')?.addEventListener('click', () => infoDialog.close());
infoDialog.addEventListener('click', (ev) => {
  if (ev.target === infoDialog) infoDialog.close();
});


const activeDisk = (): Disk => drives[activeDrive];

let saveTimer: number | undefined;
function scheduleSave(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveAllDrives, 400);
}

function iconButton(label: string, title: string, action: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'icon-btn';
  b.textContent = label;
  b.title = title;
  b.dataset.act = action;
  return b;
}

function renderFiles(): void {
  const disk = activeDisk();
  const letter = letterFor(activeDrive);
  driveTitle.textContent = `Drive ${letter}:`;
  imageBadge.hidden = !disk.image;
  ejectImageBtn.disabled = !disk.image;
  fileList.setAttribute('aria-label', `Files on drive ${letter}`);
  consoleDrive.textContent = `Console · ${letterFor(machine.bdos.drive)}:`;

  for (const tab of driveTabs.querySelectorAll<HTMLButtonElement>('.drive-tab')) {
    const active = Number(tab.dataset.drive) === activeDrive;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  }

  const files = [...disk.files].sort((a, b) => {
    if (a.user !== b.user) return a.user - b.user;
    return (a.name + a.ext).localeCompare(b.name + b.ext);
  });

  fileList.replaceChildren();
  if (!files.length) {
    const li = document.createElement('li');
    li.className = 'file-empty';
    li.textContent = 'Drive is empty.';
    fileList.append(li);
  }

  for (const f of files) {
    const li = document.createElement('li');
    li.className = 'file-row';

    const name = document.createElement('span');
    name.className = 'file-name';
    const drive = document.createElement('span');
    drive.className = 'drive';
    drive.textContent = `${letter}:`;
    name.append(drive, document.createTextNode(' ' + trimName(f.name)));
    const ext = trimName(f.ext);
    if (ext) {
      const e = document.createElement('span');
      e.className = 'ext';
      e.textContent = '.' + ext;
      name.append(e);
    }
    name.title = displayName(f);

    const size = document.createElement('span');
    size.className = 'file-size';
    size.textContent = formatSize(f.data.length);

    li.append(name, size);

    if (f.user !== 0) {
      const badge = document.createElement('span');
      badge.className = 'user-badge';
      badge.textContent = `U${f.user}`;
      li.append(badge);
    }

    const dl = iconButton('↓', 'Download file', 'download');
    const rm = iconButton('×', 'Delete file', 'delete');
    li.append(dl, rm);
    li.dataset.drive = String(activeDrive);
    li.dataset.user = String(f.user);
    li.dataset.name = trimName(f.name);
    li.dataset.ext = trimName(f.ext);
    fileList.append(li);
  }

  const used = disk.usedBytes();
  usage.textContent = `${formatSize(used)} / ${formatSize(MAX_BYTES)}`;
  usageBar.style.width = `${Math.min(100, (used / MAX_BYTES) * 100).toFixed(1)}%`;
  fileList.scrollTop = 0;
  scheduleSave();
}

function findFromRow(row: HTMLElement): { file: CpmFile; disk: Disk } | undefined {
  const index = Number(row.dataset.drive);
  const disk = drives[index];
  if (!disk) return undefined;
  const file = disk.find(
    Number(row.dataset.user),
    padName(row.dataset.name ?? ''),
    padExt(row.dataset.ext ?? ''),
  );
  return file ? { file, disk } : undefined;
}

fileList.addEventListener('click', (ev) => {
  const target = ev.target as HTMLElement;
  const btn = target.closest<HTMLButtonElement>('.icon-btn');
  if (!btn) return;
  const row = btn.closest<HTMLElement>('.file-row');
  if (!row) return;
  const found = findFromRow(row);
  if (!found) return;

  if (btn.dataset.act === 'download') {
    downloadFile(found.file);
  } else if (btn.dataset.act === 'delete') {
    const letter = letterFor(Number(row.dataset.drive));
    if (!confirm(`Delete ${displayName(found.file)} from drive ${letter}:?`)) return;
    found.disk.remove(found.file);
    machine.forgetFile(found.file);
    renderFiles();
  }
});

function downloadBytes(name: string, data: Uint8Array | number[]): void {
  const blob = new Blob([new Uint8Array(data)], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadFile(file: CpmFile): void {
  downloadBytes(displayName(file), file.data);
}

function downloadLog(name: string, bytes: number[]): void {
  downloadBytes(name, bytes);
}

function renderDevices(): void {
  printerCount.textContent = formatSize(machine.bdos.printerLog.length);
  serialCount.textContent = formatSize(machine.bdos.serialLog.length);
}

function updateClock(): void {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  clockEl.textContent = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

printerDownload.addEventListener('click', () => downloadLog('printer.txt', machine.bdos.printerLog));
serialDownload.addEventListener('click', () => downloadLog('serial.txt', machine.bdos.serialLog));
printerClear.addEventListener('click', () => {
  machine.bdos.printerLog.length = 0;
  renderDevices();
});
serialClear.addEventListener('click', () => {
  machine.bdos.serialLog.length = 0;
  renderDevices();
});

function uniqueName(disk: Disk, user: number, name: string, ext: string): { name: string; ext: string } {
  const exists = disk.find(user, name, ext);
  if (!exists) return { name, ext };
  const builtin = disk === drives[0] && builtinData.get(`${trimName(name)}.${trimName(ext)}`);
  if (builtin) return { name, ext }; // an upload may deliberately replace a bundled tool
  for (let i = 1; i < 10; i++) {
    const n = padName(trimName(name).slice(0, 7) + i);
    if (!disk.find(user, n, ext)) return { name: n, ext };
  }
  return { name: padName('FILE' + Math.floor(Math.random() * 9)), ext };
}

async function importFiles(list: FileList | File[]): Promise<void> {
  if (machine.busy) {
    con.write('\r\n* Wait for the running program to finish before importing files.\r\n');
    return;
  }
  const targetDrive = activeDrive;
  const disk = drives[targetDrive];
  const letter = letterFor(targetDrive);
  const files = Array.from(list);
  let imported = 0;
  for (const file of files) {
    if (file.name.toLowerCase().endsWith('.zip')) {
      await installGameZip(file);
      continue;
    }
    if (file.size > MAX_UPLOAD) {
      con.write(`\r\n* ${file.name}: too large (512 KB maximum).\r\n`);
      continue;
    }
    const data = new Uint8Array(await file.arrayBuffer());
    const cpm = toCpmName(file.name);
    const target = uniqueName(disk, machine.bdos.user, cpm.name, cpm.ext);
    const stored = disk.put(target.name, target.ext, data, machine.bdos.user);
    if (!stored) {
      con.write(`\r\n* Disk full; ${file.name} was not imported.\r\n`);
      continue;
    }
    imported++;
  }
  if (imported) {
    con.write(`\r\n* Imported ${imported} file${imported === 1 ? '' : 's'} to ${letter}: user ${machine.bdos.user}.\r\n`);
    con.write(`* Type DIR ${letter}: to see the list.\r\n`);
    con.send('\r');
  }
  renderFiles();
  fileList.scrollTop = fileList.scrollHeight;
  con.focus();
}

const SKIP_EXTENSIONS = new Set([
  'ZIP', 'JPG', 'JPEG', 'PNG', 'GIF', 'PDF', 'MAC', 'BAS', 'ASM', 'PLM', 'DOC', 'LBR', 'DIZ',
]);

async function installGameZip(file: File): Promise<void> {
  if (machine.busy) {
    con.write('\r\n* Wait for the running program to finish before installing a game.\r\n');
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    con.write(`\r\n* ${file.name}: archive too large (8 MB maximum).\r\n`);
    return;
  }
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzip(new Uint8Array(await file.arrayBuffer()));
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (/unsupported compression method 6/i.test(message)) {
      con.write('\r\n* This is a legacy Implode .zip. Extract it with your system unzip tool and drop the .COM/.DAT files here.\r\n');
    } else {
      con.write(`\r\n* ${file.name}: could not read this archive.\r\n`);
    }
    return;
  }

  const targetDrive = activeDrive;
  const disk = drives[targetDrive];
  const letter = letterFor(targetDrive);
  const coms: string[] = [];
  let hasMqg = false;
  let installed = 0;
  const zipBase = file.name.replace(/\.zip$/i, '').replace(/[^A-Z0-9]/gi, '').toUpperCase();

  for (const [path, data] of Object.entries(entries)) {
    if (path.endsWith('/') || path.includes('__MACOSX')) continue;
    const base = path.split('/').pop() ?? '';
    if (!base || base.startsWith('.')) continue;
    const dot = base.lastIndexOf('.');
    const rawExt = dot > 0 ? base.slice(dot + 1).toUpperCase() : '';
    if (rawExt === 'MQG') hasMqg = true;
    if (data.length > MAX_UPLOAD || SKIP_EXTENSIONS.has(rawExt)) continue;

    const cpm = toCpmName(base);
    const target = uniqueName(disk, machine.bdos.user, cpm.name, cpm.ext);
    if (!disk.put(target.name, target.ext, data, machine.bdos.user)) {
      con.write(`\r\n* Disk full; ${base} was not installed.\r\n`);
      break;
    }
    installed++;
    if (trimName(target.ext) === 'COM') coms.push(trimName(target.name));
  }

  saveAllDrives();
  renderFiles();
  if (!installed) {
    con.write(`\r\n* No CP/M files found in ${file.name}.\r\n`);
    return;
  }
  con.write(`\r\n* Installed ${installed} file${installed === 1 ? '' : 's'} from ${file.name} on ${letter}:.\r\n`);

  const preferred = coms.find((name) => name.replace(/[^A-Z0-9]/gi, '').toUpperCase() === zipBase);
  if (preferred && !hasMqg) {
    con.write(`* Running ${preferred}...\r\n`);
    if (targetDrive !== machine.bdos.drive) con.send(`${letter}:\r\n`);
    con.send(`${preferred}\r`);
  } else if (coms.length === 1 && !hasMqg) {
    con.write(`* Running ${coms[0]}...\r\n`);
    if (targetDrive !== machine.bdos.drive) con.send(`${letter}:\r\n`);
    con.send(`${coms[0]}\r`);
  } else if (coms.length > 1) {
    con.write(`* Type ${letter}:${preferred ?? coms[0]} (or another .COM) to play.\r\n`);
  } else if (hasMqg) {
    con.write('* Run USQ on the .MQG file to decode the message file first.\r\n');
  } else {
    con.write('* No .COM to run.\r\n');
  }
  con.focus();
}

gameZipBtn.addEventListener('click', () => gameZipInput.click());
softwareZipBtn.addEventListener('click', () => gameZipInput.click());
gameZipInput.addEventListener('change', () => {
  const file = gameZipInput.files?.[0];
  gameZipInput.value = '';
  if (file) void installGameZip(file);
});

uploadBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files) void importFiles(fileInput.files);
  fileInput.value = '';
});

for (const ev of ['dragenter', 'dragover'] as const) {
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
}
for (const ev of ['dragleave', 'drop'] as const) {
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
  });
}
dropzone.addEventListener('drop', (e) => {
  const files = (e as DragEvent).dataTransfer?.files;
  if (files?.length) void importFiles(files);
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

driveTabs.addEventListener('click', (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('.drive-tab');
  if (!btn || machine.busy) return;
  const index = Number(btn.dataset.drive);
  if (!drives[index]) return;
  activeDrive = index;
  renderFiles();
  con.send(`${letterFor(index)}:\r`);
  con.focus();
});

mountImageBtn.addEventListener('click', () => imageInput.click());

imageInput.addEventListener('change', async () => {
  const file = imageInput.files?.[0];
  imageInput.value = '';
  if (!file || machine.busy) return;
  const data = new Uint8Array(await file.arrayBuffer());
  if (!activeDisk().mountImage(data)) {
    con.write('\r\n* Unsupported image. Use a raw 8" SSSD, 512K or 4MB .dsk/.img.\r\n');
    return;
  }
  saveAllDrives();
  renderFiles();
  con.write(`\r\n* Mounted ${file.name} on ${letterFor(activeDrive)}:.\r\n`);
  con.send('\r');
  con.focus();
});

exportImageBtn.addEventListener('click', () => {
  if (machine.busy) return;
  const bytes = activeDisk().exportImage();
  if (!bytes) {
    con.write('\r\n* Not enough space for an 8" image.\r\n');
    return;
  }
  downloadBytes(`${letterFor(activeDrive)}.dsk`, bytes);
  saveAllDrives();
});

ejectImageBtn.addEventListener('click', () => {
  if (machine.busy) return;
  activeDisk().ejectImage();
  saveAllDrives();
  renderFiles();
  con.write(`\r\n* Ejected image from ${letterFor(activeDrive)}:.\r\n`);
  con.send('\r');
  con.focus();
});

function applyTerminalType(type: string, persist = true): void {
  const valid: TerminalType[] = ['ansi', 'adm3a', 'vt52'];
  if (!valid.includes(type as TerminalType)) return;
  con.setTerminalType(type as TerminalType);
  terminalSelect.value = type;
  if (persist) {
    try {
      localStorage.setItem(TERM_KEY, type);
    } catch {
      /* ignore */
    }
  }
}

terminalSelect.addEventListener('change', () => applyTerminalType(terminalSelect.value));

resetBtn.addEventListener('click', () => {
  if (machine.busy) return;
  const letter = letterFor(activeDrive);
  const extra = activeDrive === 0 ? ' and restore the original programs' : '';
  if (!confirm(`Delete all files on drive ${letter}:${extra}?`)) return;
  drives[activeDrive].reset();
  localStorage.removeItem(driveKey(activeDrive));
  machine.bdos.resetDrive(activeDrive);
  if (activeDrive === 0) loadBuiltins();
  saveAllDrives();
  renderFiles();
  con.write(`\r\n* Drive ${letter}: restored.\r\n`);
  con.send('\r');
  con.focus();
});

document.querySelectorAll<HTMLButtonElement>('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    if (machine.busy) return;
    con.send((chip.dataset.cmd ?? '') + '\r');
  });
});

// ---- wiring -----------------------------------------------------------

machine.onRefresh = () => {
  if (machine.bdos.drive !== lastMachineDrive) {
    lastMachineDrive = machine.bdos.drive;
    activeDrive = lastMachineDrive;
  }
  renderFiles();
  renderDevices();
};
machine.onBusy = (busy) => {
  consolePanel.classList.toggle('busy', busy);
  statusText.textContent = busy ? 'RUNNING' : 'READY';
  dropzone.classList.toggle('disabled', busy);
  resetBtn.disabled = busy;
};

window.addEventListener('resize', () => {
  applyFontSize();
  con.fit();
});
new ResizeObserver(() => con.fit()).observe(el('terminal'));
new ResizeObserver(() => con.fit()).observe(consolePanel);
document.fonts?.ready.then(() => con.fit());

function applyFontSize(): void {
  const size = window.innerWidth < 700 ? 12 : 15;
  if (con.term.options.fontSize !== size) con.term.options.fontSize = size;
}

consolePanel.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('button')) return;
  con.focus();
});

loadBuiltins();
for (let i = 0; i < drives.length; i++) restoreDrive(i);
applyTerminalType(localStorage.getItem(TERM_KEY) ?? 'ansi', false);
renderFiles();
renderDevices();
updateClock();
window.setInterval(() => {
  updateClock();
  renderDevices();
}, 1000);
applyFontSize();
statusText.textContent = 'READY';
con.focus();
requestAnimationFrame(() => {
  con.fit();
  machine.start().catch((err: unknown) => {
    con.write(`\r\n* Failed to start: ${err instanceof Error ? err.message : String(err)}\r\n`);
  });
});
