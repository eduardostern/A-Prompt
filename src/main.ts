/*! A-Prompt — © 2026 Eduardo Stern <eduardostern@icloud.com> — MIT License */
import './style.css';
import { unzip } from './zip';
import { XtermConsole } from './terminal';
import type { TerminalType } from './terminal-translator';
import { CpmMachine } from './cpm/machine';
import { BUILTIN_FILES } from './assets/builtin-programs';
import type { Dialer, Link, LinkHandlers } from './cpm/modem';
import { createAiBoard } from './aiboard';
import { withCallSound } from './call-sound';
import { audioContext } from './audio';
import { setupDisplay } from './display-ui';
import { askConfirm } from './confirm';
import { waitForPower, warmUp } from './power';
import { startCallSound } from './modem-audio';
import { assemble } from './cpm/assembler';
import { streamChat } from './deepseek';
import { inPhoneBook } from './phonebook';
import type { Disk } from './cpm/disk';
import { CpmFile, MAX_BYTES, displayName, padExt, padName, trimName } from './cpm/disk';
import {
  StoredFileEntry, b64ToBytes, decodeFiles, decodeImage, encodeFiles, encodeImage, packFiles, sameBytes, unpackFiles,
} from './storage';

const LS_PREFIX = 'a-prompt.drive.';
const LEGACY_LS_KEY = 'a-prompt.drive.v1';
const TERM_KEY = 'a-prompt.terminal';
const CLOCK_KEY = 'a-prompt.clock';
const DEFAULT_CLOCK_HZ = '4000000';
const PANEL_KEY = 'a-prompt.panels';
const MAX_UPLOAD = 512 * 1024;

const letterFor = (index: number): string => String.fromCharCode(65 + index);
const driveKey = (index: number): string => `${LS_PREFIX}${letterFor(index)}.v2`;

// ---- helpers ----------------------------------------------------------

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
const display = setupDisplay(con, () => window.innerWidth < 700, () => {
  setPanels(true);
  const card = el<HTMLDetailsElement>('display-card');
  card.open = true;
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});
const machine = new CpmMachine(con);

// ---- DeepSeek key (AI board) -------------------------------------------

const DEEPSEEK_KEY = 'a-prompt.deepseek-key';
const keyInput = el<HTMLInputElement>('deepseek-key');
const keyStatus = el<HTMLElement>('deepseek-status');

function getDeepSeekKey(): string | null {
  try {
    return localStorage.getItem(DEEPSEEK_KEY);
  } catch {
    return null;
  }
}

function setDeepSeekKey(key: string | null): void {
  try {
    if (key) localStorage.setItem(DEEPSEEK_KEY, key);
    else localStorage.removeItem(DEEPSEEK_KEY);
  } catch {
    /* storage blocked: the key lasts for this call only */
  }
  showKeyStatus();
}

function showKeyStatus(): void {
  const key = getDeepSeekKey();
  keyStatus.textContent = key
    ? `Key saved in this browser (${key.slice(0, 3)}…${key.slice(-4)}).`
    : 'No key yet.';
  keyStatus.classList.toggle('ok', Boolean(key));
}

el<HTMLButtonElement>('deepseek-save').addEventListener('click', () => {
  const key = keyInput.value.trim();
  if (!key) return;
  setDeepSeekKey(key);
  keyInput.value = '';
});
el<HTMLButtonElement>('deepseek-forget').addEventListener('click', () => {
  setDeepSeekKey(null);
  keyInput.value = '';
});
el<HTMLButtonElement>('deepseek-show').addEventListener('click', (e) => {
  const show = keyInput.type === 'password';
  keyInput.type = show ? 'text' : 'password';
  (e.currentTarget as HTMLButtonElement).textContent = show ? 'Hide' : 'Show';
});
keyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el<HTMLButtonElement>('deepseek-save').click();
});
showKeyStatus();

// ---- telnet modem -----------------------------------------------------

/** A call over one WebSocket; `isRelay` waits for the relay's CONNECT frame. */
function wsCall(url: string, protocols: string[], isRelay: boolean, handlers: LinkHandlers): Link {
  let ws: WebSocket;
  try {
    ws = new WebSocket(url, protocols);
  } catch {
    queueMicrotask(() => handlers.onClose());
    return { send: () => {}, close: () => {} };
  }
  ws.binaryType = 'arraybuffer';
  if (!isRelay) ws.onopen = () => handlers.onOpen('DIRECT');
  ws.onmessage = (e: MessageEvent) => {
    if (typeof e.data !== 'string') handlers.onData(new Uint8Array(e.data as ArrayBuffer));
    else if (isRelay && e.data === 'CONNECT') handlers.onOpen();
    else handlers.onData(Uint8Array.from(e.data, (c) => c.charCodeAt(0) & 0xff));
  };
  ws.onclose = () => handlers.onClose();
  return {
    send: (bytes) => { if (ws.readyState === WebSocket.OPEN) ws.send(bytes); },
    close: () => ws.close(),
  };
}

/** Through the Worker relay (worker/index.ts) on the same origin. */
function relayCall(host: string, port: number, handlers: LinkHandlers): Link {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const query = `host=${encodeURIComponent(host)}&port=${port}`;
  return wsCall(`${scheme}://${location.host}/relay?${query}`, [], true, handlers);
}

/**
 * Dials a BBS's own WebSocket gateway straight from the browser when it has
 * one, so the call comes from the user's IP; if that fails before the call is
 * up and the board is in the phone book, it goes through the relay instead.
 */
const modemDialer: Dialer = (target, handlers) => {
  if (target.host === 'deepseek' || target.host === 'ai') {
    return createAiBoard(handlers, {
      getKey: getDeepSeekKey,
      setKey: setDeepSeekKey,
      chat: streamChat,
      assemble: (name, source) => assemble(name, source, () => new Promise((r) => setTimeout(r, 0))),
      schedule: (fn, ms) => { window.setTimeout(fn, ms); },
    });
  }
  if (!target.ws) return relayCall(target.host, target.port, handlers);
  let current: Link;
  let opened = false;
  let closed = false;
  current = wsCall(target.ws, ['binary'], false, {
    onOpen: (info) => { opened = true; handlers.onOpen(info); },
    onData: (bytes) => handlers.onData(bytes),
    onClose: () => {
      if (!opened && !closed && inPhoneBook(target.host, target.port)) {
        current = relayCall(target.host, target.port, handlers);
      } else {
        handlers.onClose();
      }
    },
  });
  return {
    send: (bytes) => current.send(bytes),
    close: () => { closed = true; current.close(); },
  };
};

const MODEM_PROFILE = 'a-prompt.modem';
machine.modem.dialer = withCallSound(modemDialer, (target) =>
  machine.modem.speaker === 0 ? undefined : startCallSound(`${target.host}:${target.port}`, machine.modem.volume));
try {
  const saved = localStorage.getItem(MODEM_PROFILE);
  if (saved) machine.modem.loadProfile(JSON.parse(saved));
} catch {
  /* no saved profile */
}
machine.modem.onSaveProfile = (profile) => {
  try {
    localStorage.setItem(MODEM_PROFILE, JSON.stringify(profile));
  } catch {
    /* storage blocked */
  }
};
machine.modem.services = [{ number: 'DEEPSEEK', name: 'AI board: DeepSeek V4.1 Flash, your API key' }];
machine.modem.terminalType = () => ({ ansi: 'ANSI', adm3a: 'ADM3A', vt52: 'VT52' })[con.terminalType];
machine.modem.windowSize = () => [con.term.cols, con.term.rows];
const drives = machine.drives;
let activeDrive = 0;
let lastMachineDrive = 0;

const builtinData = new Map<string, string>();
for (const f of BUILTIN_FILES) builtinData.set(`${f.name}.${f.ext}`, f.data);
/** Built-in program bytes, to skip saving unmodified copies on A:. */
const builtinBytes = new Map<string, Uint8Array>();
for (const f of BUILTIN_FILES) builtinBytes.set(`${f.name}.${f.ext}`, b64ToBytes(f.data));

function loadBuiltins(): void {
  for (const f of BUILTIN_FILES) {
    drives[0].put(f.name, f.ext, b64ToBytes(f.data));
  }
}

/** v2 file record (one base64 string per file); still read on restore. */
interface StoredFile {
  n: string;
  e: string;
  u: number;
  d: string;
}

interface StoredDrive {
  v?: number;
  files?: StoredFile[];
  /** v2: plain base64 image. */
  image?: string;
  /** v3: deflated packed files (see storage.ts). */
  filesz?: string;
  /** v3: deflated base64 image (see storage.ts). */
  imagez?: string;
  size?: number;
}

/** Image bytes last written to localStorage, per drive, to skip unchanged saves. */
const savedImages: (Uint8Array | undefined)[] = [];
/** Packed files last written to localStorage, per drive. */
const savedFiles: (Uint8Array | undefined)[] = [];
/** Drives whose last save did not fit in localStorage. */
const saveFailed: boolean[] = [];

function setSaveFailed(index: number, failed: boolean): void {
  if (saveFailed[index] === failed) return;
  saveFailed[index] = failed;
  if (index === activeDrive) renderSaveWarning();
}

function saveDrive(index: number): void {
  const disk = drives[index];
  if (disk.image) {
    try {
      disk.syncImage();
      const bytes = disk.exportImage();
      if (!bytes || sameBytes(savedImages[index], bytes)) return;
      localStorage.setItem(driveKey(index), JSON.stringify(encodeImage(bytes)));
      savedImages[index] = bytes;
      savedFiles[index] = undefined;
      setSaveFailed(index, false);
    } catch {
      // Quota exceeded: the image stays in memory; the last good save is kept.
      setSaveFailed(index, true);
    }
    return;
  }
  savedImages[index] = undefined;
  const files: StoredFileEntry[] = [];
  for (const f of disk.files) {
    if (trimName(f.name) === '$$$') continue; // transient SUBMIT queue
    const key = `${trimName(f.name)}.${trimName(f.ext)}`;
    const builtin = builtinBytes.get(key);
    const pristine = index === 0 && f.user === 0 && !f.ro && !f.sys && !!builtin && sameBytes(builtin, f.data);
    if (pristine) continue;
    files.push({ user: f.user, name: f.name, ext: f.ext, ro: f.ro, sys: f.sys, data: f.data });
  }
  try {
    if (!files.length) {
      localStorage.removeItem(driveKey(index));
      savedFiles[index] = undefined;
    } else {
      const packed = packFiles(files);
      if (sameBytes(savedFiles[index], packed)) return;
      localStorage.setItem(driveKey(index), JSON.stringify(encodeFiles(packed)));
      savedFiles[index] = packed;
    }
    setSaveFailed(index, false);
  } catch {
    setSaveFailed(index, true); // quota exceeded: keep running in memory
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
    if (typeof parsed.imagez === 'string' || typeof parsed.image === 'string') {
      const bytes = decodeImage(parsed);
      if (bytes && bytes.length <= MAX_BYTES * 2 && drives[index].mountImage(bytes)) {
        // v3 already holds these bytes; a v2 record is upgraded on the next save.
        if (parsed.v === 3) savedImages[index] = drives[index].exportImage() ?? undefined;
      }
      return;
    }
    if (typeof parsed.filesz === 'string') {
      const packed = decodeFiles(parsed);
      const files = packed && unpackFiles(packed);
      if (!files) return;
      for (const f of files) {
        if (f.data.length <= MAX_BYTES) drives[index].put(f.name, f.ext, f.data, f.user, f.ro, f.sys);
      }
      savedFiles[index] = packed ?? undefined;
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
const clockSelect = el<HTMLSelectElement>('clock-speed');
const speedEl = el('speed');
const resetMachine = el<HTMLButtonElement>('reset-machine');
const usage = el('usage');
const saveWarning = el('save-warning');

function renderSaveWarning(): void {
  saveWarning.hidden = !saveFailed[activeDrive];
}
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
const sidebar = el<HTMLElement>('sidebar');
const sidebarToggle = el<HTMLButtonElement>('sidebar-toggle');
const sidebarClose = el<HTMLButtonElement>('sidebar-close');
const sidebarBackdrop = el('sidebar-backdrop');
const infoDialog = el<HTMLDialogElement>('cpm-info');

document.querySelectorAll<HTMLAnchorElement>('.info-open').forEach((link) => {
  link.addEventListener('click', (ev) => {
    ev.preventDefault();
    if (isMobileLayout()) setPanels(false);
    infoDialog.showModal();
  });
});
infoDialog.querySelector<HTMLButtonElement>('.info-close')?.addEventListener('click', () => infoDialog.close());
infoDialog.addEventListener('click', (ev) => {
  if (ev.target === infoDialog) infoDialog.close();
});

// ---- panel rail -------------------------------------------------------

const isMobileLayout = (): boolean => window.matchMedia('(max-width: 900px)').matches;
let panelsOpen = !isMobileLayout();
let wasMobile = isMobileLayout();

function setPanels(open: boolean, persist = true): void {
  const mobile = isMobileLayout();
  panelsOpen = open;
  document.body.classList.toggle('panels-open', mobile && open);
  document.body.classList.toggle('panels-hidden', !mobile && !open);
  sidebarToggle.classList.toggle('is-on', open);
  sidebarToggle.setAttribute('aria-expanded', String(open));
  if (persist) {
    try {
      localStorage.setItem(PANEL_KEY, open ? 'open' : 'closed');
    } catch {
      /* ignore */
    }
  }
  if (persist && mobile && open) {
    window.setTimeout(() => sidebarClose.focus(), 40);
  }
}

sidebarToggle.addEventListener('click', () => setPanels(!panelsOpen));
sidebarClose.addEventListener('click', () => {
  setPanels(false);
  con.focus();
});
sidebarBackdrop.addEventListener('click', () => {
  setPanels(false);
  con.focus();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && panelsOpen && isMobileLayout()) {
    setPanels(false);
    con.focus();
  }
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
  renderSaveWarning();
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
    void askConfirm({
      title: `Delete ${displayName(found.file)}?`,
      message: `The file goes from drive ${letter}: for good.`,
      ok: 'Delete',
    }).then((yes) => {
      if (!yes) return;
      found.disk.remove(found.file);
      machine.forgetFile(found.file);
      renderFiles();
    });
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
    const setup = coms.find((name) => /^(W?INSTALL|TINST)$/i.test(name));
    const first = preferred ?? setup ?? coms[0];
    con.write(`* Type ${letter}:${first} to start. Installed: ${coms.slice(0, 6).join(', ')}.\r\n`);
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
    con.write('\r\n* Unsupported image. Use a raw 8" SSSD, 512K, 4MB or z80pack 4MB hard disk .dsk/.img.\r\n');
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

/** Sets the Z80 clock limit; the value is in Hz, "0" means no limit. */
function applyClock(value: string, persist = true): void {
  if (![...clockSelect.options].some((o) => o.value === value)) value = DEFAULT_CLOCK_HZ;
  machine.clockHz = Number(value);
  clockSelect.value = value;
  if (persist) {
    try {
      localStorage.setItem(CLOCK_KEY, value);
    } catch {
      /* ignore */
    }
  }
}

clockSelect.addEventListener('change', () => {
  applyClock(clockSelect.value);
  con.focus();
});

resetBtn.addEventListener('click', async () => {
  if (machine.busy) return;
  const letter = letterFor(activeDrive);
  const extra = activeDrive === 0 ? ' The original programs come back.' : '';
  const yes = await askConfirm({
    title: `Restore drive ${letter}:?`,
    message: `Every file on drive ${letter}: is deleted.${extra}`,
    ok: 'Restore',
  });
  if (!yes || machine.busy) return;
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

document.querySelectorAll<HTMLButtonElement>('.chip[data-cmd]').forEach((chip) => {
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
  speedEl.textContent = busy ? '…' : 'IDLE';
  dropzone.classList.toggle('disabled', busy);
  resetBtn.disabled = busy;
};
machine.onSpeed = (mhz) => {
  speedEl.textContent = `≈ ${Math.max(1, Math.round(mhz))} MHz`;
};

resetMachine.addEventListener('click', async () => {
  if (
    machine.busy &&
    !(await askConfirm({
      title: 'Reboot the machine?',
      message: 'A program is running and stops here. Your drives are kept.',
      ok: 'Reboot',
    }))
  ) {
    con.focus();
    return;
  }
  saveAllDrives();
  try {
    sessionStorage.setItem(WARM_KEY, '1');
  } catch {
    /* ignore: the power switch shows again */
  }
  window.location.reload();
});

/** Toolbar menus use their short labels (data-short) on narrow screens. */
function labelToolbar(): void {
  const narrow = window.innerWidth <= 480;
  for (const o of document.querySelectorAll<HTMLOptionElement>('.panel-tools option[data-short]')) {
    o.dataset.long ??= o.textContent ?? '';
    o.textContent = narrow ? o.dataset.short! : o.dataset.long;
  }
}
labelToolbar();

window.addEventListener('resize', () => {
  labelToolbar();
  display.refit();
  const mobile = isMobileLayout();
  if (mobile && !wasMobile) setPanels(false, false);
  else setPanels(panelsOpen, false);
  wasMobile = mobile;
  con.fit();
});
new ResizeObserver(() => con.fit()).observe(el('terminal'));
new ResizeObserver(() => con.fit()).observe(consolePanel);
document.fonts?.ready.then(() => con.fit());


consolePanel.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('button')) return;
  con.focus();
});

loadBuiltins();
for (let i = 0; i < drives.length; i++) restoreDrive(i);
applyTerminalType(localStorage.getItem(TERM_KEY) ?? 'ansi', false);
applyClock(localStorage.getItem(CLOCK_KEY) ?? DEFAULT_CLOCK_HZ, false);
const savedPanels = localStorage.getItem(PANEL_KEY);
setPanels(isMobileLayout() ? false : savedPanels ? savedPanels === 'open' : true, false);
renderFiles();
renderDevices();
updateClock();
window.setInterval(() => {
  updateClock();
  renderDevices();
}, 1000);
statusText.textContent = 'READY';
con.focus();
// ---- power ------------------------------------------------------------

// A fresh visit starts with the machine off: browsers allow sound only after
// a click or key, and that is the power switch, so the boot bell rings. Reset
// reboots without it, and so does a visitor who ticks "Power on by itself".
const AUTO_POWER_KEY = 'a-prompt.autopower';
const WARM_KEY = 'a-prompt.warm-reboot';
const autoPower = el<HTMLInputElement>('auto-power');
autoPower.checked = localStorage.getItem(AUTO_POWER_KEY) === '1';
autoPower.addEventListener('change', () => {
  try {
    if (autoPower.checked) localStorage.setItem(AUTO_POWER_KEY, '1');
    else localStorage.removeItem(AUTO_POWER_KEY);
  } catch {
    /* ignore */
  }
});
let warmReboot = false;
try {
  warmReboot = sessionStorage.getItem(WARM_KEY) === '1';
  sessionStorage.removeItem(WARM_KEY);
} catch {
  /* ignore */
}

// Without the switch, the bell waits for the first click or key.
const wakeAudio = () => {
  audioContext();
  window.removeEventListener('pointerdown', wakeAudio, true);
  window.removeEventListener('keydown', wakeAudio, true);
};
window.addEventListener('pointerdown', wakeAudio, true);
window.addEventListener('keydown', wakeAudio, true);

requestAnimationFrame(async () => {
  con.fit();
  if (!warmReboot && !autoPower.checked) {
    const wrap = el('terminal-wrap');
    statusText.textContent = 'OFF';
    document.body.classList.add('machine-off');
    await waitForPower(wrap);
    document.body.classList.remove('machine-off');
    statusText.textContent = 'READY';
    await warmUp(wrap);
  }
  con.focus();
  machine.start().catch((err: unknown) => {
    con.write(`\r\n* Failed to start: ${err instanceof Error ? err.message : String(err)}\r\n`);
  });
});
