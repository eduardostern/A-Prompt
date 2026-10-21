import './style.css';
import { XtermConsole } from './terminal';
import { CpmMachine } from './cpm/machine';
import { BUILTIN_FILES } from './assets/builtin-programs';
import type { Disk } from './cpm/disk';
import { CpmFile, MAX_BYTES, displayName, padExt, padName, trimName } from './cpm/disk';

const LS_PREFIX = 'a-prompt.drive.';
const LEGACY_LS_KEY = 'a-prompt.drive.v1';
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

function saveDrive(index: number): void {
  const disk = drives[index];
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
    const parsed = JSON.parse(raw) as { files?: StoredFile[] };
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
const consoleDrive = el('console-drive');
const usage = el('usage');
const usageBar = el<HTMLDivElement>('usage-bar');
const led = el('led');
const statusText = el('status-text');
const dropzone = el('dropzone');
const fileInput = el<HTMLInputElement>('file-input');
const uploadBtn = el<HTMLButtonElement>('upload-btn');
const resetBtn = el<HTMLButtonElement>('reset-btn');
const consolePanel = document.querySelector<HTMLElement>('.console-panel')!;

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

function downloadFile(file: CpmFile): void {
  const blob = new Blob([new Uint8Array(file.data)], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = displayName(file);
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

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
renderFiles();
applyFontSize();
statusText.textContent = 'READY';
con.focus();
requestAnimationFrame(() => {
  con.fit();
  machine.start().catch((err: unknown) => {
    con.write(`\r\n* Failed to start: ${err instanceof Error ? err.message : String(err)}\r\n`);
  });
});
