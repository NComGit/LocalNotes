/* ============================================================================
 * LocalNotes Manager — app.js
 * ----------------------------------------------------------------------------
 * Local-first HTML note manager.
 *
 *   • Notes are plain, un-stylized HTML5 files on the user's own disk.
 *   • Metadata lives in <meta> tags; content lives in <section id="content">.
 *   • The directory handle is cached in IndexedDB (idb-keyval) and re-authorised
 *     with a user gesture when the browser drops the permission.
 *   • Every launch re-walks /Notes, parses headers with DOMParser and rebuilds a
 *     TRANSIENT in-memory AlaSQL index. Nothing is ever written to a database.
 *   • Editing happens in HugeRTE behind a double-layer style firewall: only the
 *     inner HTML of <section id="content"> is ever exposed to the editor, and
 *     everything coming back out is scrubbed of presentational cruft before it
 *     is stitched into the preserved <head> skeleton and written back to disk.
 *   • Templates are real HTML documents with inline CSS and ES modules. Their
 *     modules are compiled into Blob URLs and dynamically imported so that
 *     lifecycle hooks such as initTemplate(workspace) can run.
 *   • Workspace configuration is written back to config.json in the mounted
 *     root, so the whole setup is portable with the folder.
 *
 * Zero network calls. Zero telemetry. Zero cloud.
 * ==========================================================================*/

import { get, set, del } from './lib/idb-keyval.js';

/* ===========================================================================
 * 0. CONSTANTS
 * =========================================================================*/

const IDB_HANDLE_KEY = 'localnotes.rootDirectoryHandle';
const IDB_CONFIG_KEY = 'localnotes.configMirror';
const IDB_NAME_KEY = 'localnotes.rootDirectoryName';

const DIR_NOTES = 'Notes';
const DIR_TEMPLATES = 'Templates';
const DIR_QUERIES = 'Queries';
const DIR_ASSETS = 'Assets';
const CONFIG_FILE = 'config.json';

const MAX_SCAN_DEPTH = 16;
const EXCERPT_LENGTH = 260;
const MODULE_IMPORT_DEPTH = 3;

const DEFAULT_CONFIG = {
  version: 1,
  theme: 'light',
  accent: '#1d59c1',
  sidebarWidth: 280,
  resultsWidth: 330,
  contentWidth: 720,
  activeFolder: DIR_NOTES,
  selectedTags: [],
  expandedFolders: [DIR_NOTES],
  lastNote: '',
  viewMode: 'edit',
  autosave: true,
  autosaveDelay: 1500,
  defaultTemplate: 'default',
  sortOrder: 'modified-desc',
  lastOpened: ''
};

/* Attributes that carry presentation and must never reach the saved file. */
const BANNED_ATTRIBUTES = [
  'style', 'align', 'valign', 'border', 'cellpadding', 'cellspacing', 'bgcolor',
  'background', 'width', 'height', 'hspace', 'vspace', 'frame', 'rules',
  'nowrap', 'face', 'color', 'size', 'clear', 'compact', 'link', 'vlink',
  'alink', 'text', 'bordercolor', 'bordercolordark', 'bordercolorlight',
  'summary', 'char', 'charoff', 'axis', 'contenteditable', 'spellcheck',
  'autocorrect', 'autocapitalize', 'sizset', 'sizcache', 'unselectable'
];

/* Elements whose only purpose is styling: unwrap, keep their children. */
const UNWRAP_TAGS = new Set([
  'font', 'center', 'basefont', 'big', 'blink', 'marquee', 'tt', 'acronym',
  'strike', 'nobr'
]);

/* Elements that are removed outright from note content. */
const DROP_TAGS = new Set([
  'style', 'link', 'meta', 'script', 'base', 'title', 'iframe', 'object',
  'embed', 'applet', 'noscript', 'template', 'colgroup', 'form', 'input',
  'button', 'select', 'textarea', 'frame', 'frameset'
]);

/* ===========================================================================
 * 1. TINY DOM / UTILITY HELPERS
 * =========================================================================*/

const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function debounce(fn, wait) {
  let timer = 0;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  wrapped.flush = (...args) => { clearTimeout(timer); fn(...args); };
  return wrapped;
}

function splitPath(path) {
  return String(path || '').split('/').filter((part) => part.length && part !== '.');
}

function joinPath(...parts) {
  return parts.flatMap((p) => splitPath(p)).join('/');
}

function dirname(path) {
  const parts = splitPath(path);
  parts.pop();
  return parts.join('/');
}

function basename(path) {
  const parts = splitPath(path);
  return parts.length ? parts[parts.length - 1] : '';
}

function stripExtension(name) {
  return String(name).replace(/\.[^./]+$/, '');
}

/** Resolve a possibly relative reference (./x, ../y/z) against a base folder. */
function resolveRelative(baseDir, reference) {
  const stack = splitPath(baseDir);
  for (const segment of String(reference).split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') stack.pop();
    else stack.push(segment);
  }
  return stack.join('/');
}

function isExternalUrl(value) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(String(value || '').trim());
}

function slugify(value) {
  const slug = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['"`]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  return slug || 'untitled-note';
}

function todayISO() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseTagList(value) {
  return String(value || '')
    .split(/[,\n;]+/)
    .map((tag) => tag.trim().replace(/^#/, ''))
    .filter(Boolean)
    .filter((tag, index, arr) => arr.findIndex((t) => t.toLowerCase() === tag.toLowerCase()) === index);
}

function tagKey(tags) {
  return `|${tags.map((t) => t.toLowerCase()).join('|')}|`;
}

function relativeTime(timestamp) {
  if (!timestamp) return 'never';
  const diff = Date.now() - timestamp;
  if (diff < 5000) return 'just now';
  const units = [
    ['d', 86400000], ['h', 3600000], ['m', 60000], ['s', 1000]
  ];
  for (const [suffix, ms] of units) {
    if (diff >= ms) return `${Math.floor(diff / ms)}${suffix} ago`;
  }
  return 'just now';
}

/* ===========================================================================
 * 2. APPLICATION STATE
 * =========================================================================*/

const State = {
  supported: typeof window.showDirectoryPicker === 'function',
  rootHandle: null,
  rootName: '',
  mounted: false,
  config: { ...DEFAULT_CONFIG },

  notes: [],
  tree: null,
  tagUniverse: [],
  templates: [],
  queries: [],

  folderFilter: DIR_NOTES,
  selectedTags: new Set(),
  searchText: '',
  activeQuery: null,      /* { name, path, sql } */
  results: [],
  rawRows: null,          /* non-note SQL rows */

  expanded: new Set([DIR_NOTES]),

  current: null,          /* active note session */
  dirty: false,
  saving: false,
  lastSavedAt: 0,

  editor: null,           /* EditorAdapter */
  viewMode: 'edit',
  blobUrls: [],
  moduleUrls: [],
  assetCache: new Map(),
  scanning: false
};

/* Cached DOM references. */
const UI = {};

function cacheDom() {
  UI.container = $('.app-container');
  UI.sidebar = $('#col-navigation');
  UI.results = $('#col-results');
  UI.workspace = $('#col-workspace');

  UI.btnNewNote = $('#btn-new-note');
  UI.btnMount = $('#btn-mount');
  UI.searchInput = $('#search-input');
  UI.fileTree = $('#file-tree');
  UI.tagsList = $('#tags-list');
  UI.btnClearTags = $('#btn-clear-tags');
  UI.queriesList = $('#queries-list');
  UI.btnNewQuery = $('#btn-new-query');
  UI.btnSettings = $('#btn-settings');
  UI.statusBadge = $('#status-badge');

  UI.queueHeader = $('.queue-header');
  UI.resultsCount = $('#results-count');
  UI.resultsList = $('#results-list');

  UI.emptyState = $('#workspace-empty-state');
  UI.welcomeBox = $('.welcome-box');
  UI.btnWelcomeMount = $('#btn-welcome-mount');
  UI.activeState = $('#workspace-active-state');
  UI.filePath = $('#current-filepath');
  UI.templateSelect = $('#select-template');
  UI.btnEdit = $('#btn-toggle-edit');
  UI.btnPreview = $('#btn-toggle-preview');
  UI.editorPane = $('#pane-editor');
  UI.previewPane = $('#pane-preview');
  UI.renderedView = $('#rendered-view-pane');
  UI.titleInput = $('#note-title-input');
  UI.metaBar = $('#metadata-editor-bar');
  UI.tagsInput = $('#note-tags-input');
  UI.textarea = $('#my-note-editor');
  UI.cursorPosition = $('#cursor-position');
  UI.saveStatus = $('#last-saved-status');
  UI.encoding = $('#file-encoding');
}

/* ===========================================================================
 * 3. TOASTS + MODALS
 * =========================================================================*/

let toastStack = null;

function toast(message, kind = 'info', timeout = 4200) {
  if (!toastStack) {
    toastStack = el('div', { class: 'toast-stack', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastStack);
  }
  const node = el('div', {
    class: `toast${kind === 'info' ? '' : ` is-${kind}`}`,
    text: message
  });
  toastStack.append(node);
  const remove = () => node.remove();
  node.addEventListener('click', remove);
  if (timeout > 0) setTimeout(remove, timeout);
  return node;
}

let openModal = null;

function closeModal() {
  if (!openModal) return;
  openModal.remove();
  openModal = null;
}

/**
 * Build a modal. `build(body, close)` fills the body; `actions` is an array of
 * { label, kind, onClick } descriptors rendered in the footer.
 */
function showModal({ title, build, actions = [], wide = false, onOpen = null }) {
  closeModal();

  const body = el('div', { class: 'modal-body' });
  const close = () => closeModal();
  build(body, close);

  const footer = el('div', { class: 'modal-footer' });
  for (const action of actions) {
    if (action === 'spacer') { footer.append(el('span', { class: 'spacer' })); continue; }
    footer.append(el('button', {
      class: `btn btn-inline${action.kind === 'danger' ? ' btn-danger' : ''}${action.kind === 'secondary' ? ' btn-secondary' : ''}`,
      text: action.label,
      onClick: () => action.onClick(close)
    }));
  }

  const modal = el('div', { class: `modal${wide ? ' modal-wide' : ''}`, role: 'dialog', 'aria-modal': 'true' }, [
    el('div', { class: 'modal-header' }, [
      el('span', { class: 'modal-title', text: title }),
      el('button', { class: 'modal-close', text: '✕', title: 'Close', onClick: close })
    ]),
    body,
    footer
  ]);

  const backdrop = el('div', {
    class: 'modal-backdrop',
    onMousedown: (event) => { if (event.target === backdrop) close(); }
  }, [modal]);

  document.body.append(backdrop);
  openModal = backdrop;

  const focusable = $('input, textarea, select, button', body);
  if (focusable) focusable.focus();
  if (typeof onOpen === 'function') onOpen(body);
  return backdrop;
}

function confirmModal(title, message, confirmLabel = '[ Confirm ]') {
  return new Promise((resolve) => {
    showModal({
      title,
      build: (body) => { body.append(el('p', { text: message })); },
      actions: [
        { label: '[ Cancel ]', kind: 'secondary', onClick: (close) => { close(); resolve(false); } },
        { label: confirmLabel, kind: 'danger', onClick: (close) => { close(); resolve(true); } }
      ]
    });
  });
}

/* ===========================================================================
 * 4. FILE SYSTEM ACCESS LAYER
 * =========================================================================*/

async function dirEntries(dirHandle) {
  const entries = [];
  if (typeof dirHandle.entries === 'function') {
    for await (const [name, handle] of dirHandle.entries()) entries.push([name, handle]);
  } else if (typeof dirHandle.values === 'function') {
    for await (const handle of dirHandle.values()) entries.push([handle.name, handle]);
  }
  entries.sort((a, b) => {
    if (a[1].kind !== b[1].kind) return a[1].kind === 'directory' ? -1 : 1;
    return a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: 'base' });
  });
  return entries;
}

async function getDirectory(root, path, create = false) {
  let handle = root;
  for (const part of splitPath(path)) {
    handle = await handle.getDirectoryHandle(part, { create });
  }
  return handle;
}

async function getFileHandleAt(root, path, create = false) {
  const parts = splitPath(path);
  const name = parts.pop();
  if (!name) throw new Error(`Invalid file path: ${path}`);
  const dir = await getDirectory(root, parts.join('/'), create);
  return dir.getFileHandle(name, { create });
}

async function readTextAt(root, path) {
  const handle = await getFileHandleAt(root, path, false);
  const file = await handle.getFile();
  return file.text();
}

async function readTextFromHandle(handle) {
  const file = await handle.getFile();
  return file.text();
}

async function writeTextToHandle(handle, text, mime = 'text/html;charset=utf-8') {
  const writable = await handle.createWritable({ keepExistingData: false });
  await writable.write(new Blob([text], { type: mime }));
  await writable.close();
}

async function writeTextAt(root, path, text, mime) {
  const handle = await getFileHandleAt(root, path, true);
  await writeTextToHandle(handle, text, mime);
  return handle;
}

async function pathExists(root, path, kind = 'file') {
  try {
    if (kind === 'directory') await getDirectory(root, path, false);
    else await getFileHandleAt(root, path, false);
    return true;
  } catch (_) {
    return false;
  }
}

async function removeRecursively(root, path) {
  const parts = splitPath(path);
  const name = parts.pop();
  const parent = await getDirectory(root, parts.join('/'), false);
  await parent.removeEntry(name, { recursive: true });
}

async function copyDirectory(sourceDir, targetDir, depth = 0) {
  if (depth > MAX_SCAN_DEPTH) return;
  for (const [name, handle] of await dirEntries(sourceDir)) {
    if (handle.kind === 'directory') {
      const child = await targetDir.getDirectoryHandle(name, { create: true });
      await copyDirectory(handle, child, depth + 1);
    } else {
      const file = await handle.getFile();
      const target = await targetDir.getFileHandle(name, { create: true });
      const writable = await target.createWritable({ keepExistingData: false });
      await writable.write(await file.arrayBuffer());
      await writable.close();
    }
  }
}

/* ===========================================================================
 * 5. PERMISSIONS & MOUNTING
 * =========================================================================*/

function setStatus(text, kind) {
  if (!UI.statusBadge) return;
  UI.statusBadge.textContent = text;
  UI.statusBadge.className = `badge badge-${kind}`;
}

async function permissionState(handle, mode = 'readwrite') {
  if (!handle || typeof handle.queryPermission !== 'function') return 'granted';
  try {
    return await handle.queryPermission({ mode });
  } catch (_) {
    return 'prompt';
  }
}

async function askPermission(handle, mode = 'readwrite') {
  if (!handle || typeof handle.requestPermission !== 'function') return 'granted';
  try {
    return await handle.requestPermission({ mode });
  } catch (error) {
    console.warn('[localnotes] permission request failed', error);
    return 'denied';
  }
}

async function pickDirectory() {
  if (!State.supported) {
    renderUnsupported();
    return;
  }
  let handle;
  try {
    handle = await window.showDirectoryPicker({
      id: 'localnotes-root',
      mode: 'readwrite',
      startIn: 'documents'
    });
  } catch (error) {
    if (error && error.name === 'AbortError') return;
    toast(`Could not open the directory picker: ${error.message}`, 'error');
    return;
  }

  const granted = await askPermission(handle, 'readwrite');
  if (granted !== 'granted') {
    toast('Read/write permission was not granted for that folder.', 'error');
    return;
  }

  await set(IDB_HANDLE_KEY, handle);
  await set(IDB_NAME_KEY, handle.name);
  await mountRoot(handle);
}

async function unmount() {
  if (State.dirty && !(await confirmModal('Unsaved changes',
    'The current note has unsaved changes. Unmount anyway and discard them?', '[ Discard & Unmount ]'))) {
    return;
  }
  await del(IDB_HANDLE_KEY);
  await del(IDB_NAME_KEY);
  releaseBlobUrls();
  State.rootHandle = null;
  State.mounted = false;
  State.notes = [];
  State.results = [];
  State.current = null;
  State.dirty = false;
  State.activeQuery = null;
  State.templates = [];
  State.queries = [];
  State.tagUniverse = [];
  destroyIndex();
  renderAll();
  showWelcome();
  setStatus('● Folder Unmounted', 'disconnected');
  toast('Workspace unmounted. Your files were left untouched.', 'ok');
}

async function mountRoot(handle) {
  State.rootHandle = handle;
  State.rootName = handle.name || 'MyNotes';
  setStatus('● Indexing…', 'pending');

  try {
    await ensureWorkspaceSkeleton();
    await loadConfig();
    applyConfig();
    await scanWorkspace();
    State.mounted = true;
    setStatus(`● ${State.rootName} mounted`, 'connected');
    renderAll();

    const target = State.config.lastNote &&
      State.notes.find((note) => note.path === State.config.lastNote);
    if (target) await openNote(target.path);
    else if (State.notes.length) showWelcome(true);
    else showWelcome(true);

    if (new URLSearchParams(location.search).get('action') === 'new') {
      promptNewNote();
    }
  } catch (error) {
    console.error('[localnotes] mount failed', error);
    setStatus('● Mount error', 'error');
    showWelcome(false, `Could not read that folder: ${error.message}`);
    toast(`Mount failed: ${error.message}`, 'error');
  }
}

/** Create the canonical directory skeleton + starter files on first mount. */
async function ensureWorkspaceSkeleton() {
  await getDirectory(State.rootHandle, DIR_NOTES, true);
  await getDirectory(State.rootHandle, DIR_TEMPLATES, true);
  await getDirectory(State.rootHandle, DIR_QUERIES, true);

  if (!(await pathExists(State.rootHandle, CONFIG_FILE))) {
    await writeTextAt(State.rootHandle, CONFIG_FILE,
      JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'application/json');
  }
  if (!(await pathExists(State.rootHandle, `${DIR_TEMPLATES}/default-layout.css`))) {
    await writeTextAt(State.rootHandle, `${DIR_TEMPLATES}/default-layout.css`,
      STARTER_DEFAULT_LAYOUT_CSS, 'text/css');
  }
  if (!(await pathExists(State.rootHandle, `${DIR_QUERIES}/stale-notes.sql`))) {
    await writeTextAt(State.rootHandle, `${DIR_QUERIES}/stale-notes.sql`,
      STARTER_STALE_QUERY, 'text/plain');
  }
}

/* ===========================================================================
 * 6. CONFIG (portable config.json in the mounted root)
 * =========================================================================*/

async function loadConfig() {
  let loaded = {};
  try {
    loaded = JSON.parse(await readTextAt(State.rootHandle, CONFIG_FILE));
  } catch (error) {
    console.warn('[localnotes] config.json unreadable, using defaults', error);
  }
  State.config = { ...DEFAULT_CONFIG, ...(loaded && typeof loaded === 'object' ? loaded : {}) };
  State.folderFilter = State.config.activeFolder || DIR_NOTES;
  State.selectedTags = new Set(Array.isArray(State.config.selectedTags) ? State.config.selectedTags : []);
  State.expanded = new Set(Array.isArray(State.config.expandedFolders) && State.config.expandedFolders.length
    ? State.config.expandedFolders
    : [DIR_NOTES]);
  State.viewMode = State.config.viewMode === 'preview' ? 'preview' : 'edit';
  await set(IDB_CONFIG_KEY, State.config);
}

function applyConfig() {
  const root = document.documentElement;
  const clamp = (value, min, max, fallback) => {
    const num = Number(value);
    return Number.isFinite(num) ? Math.min(max, Math.max(min, num)) : fallback;
  };
  root.style.setProperty('--sidebar-w', `${clamp(State.config.sidebarWidth, 240, 480, 280)}px`);
  root.style.setProperty('--results-w', `${clamp(State.config.resultsWidth, 240, 560, 330)}px`);
  root.style.setProperty('--content-w', `${clamp(State.config.contentWidth, 480, 1200, 720)}px`);
  if (/^#[0-9a-f]{3,8}$/i.test(String(State.config.accent || ''))) {
    root.style.setProperty('--accent', State.config.accent);
  }
  setViewMode(State.viewMode, true);
}

const persistConfig = debounce(async () => {
  if (!State.rootHandle) return;
  State.config.activeFolder = State.folderFilter;
  State.config.selectedTags = Array.from(State.selectedTags);
  State.config.expandedFolders = Array.from(State.expanded);
  State.config.viewMode = State.viewMode;
  State.config.lastNote = State.current ? State.current.path : State.config.lastNote;
  State.config.lastOpened = new Date().toISOString();
  try {
    await writeTextAt(State.rootHandle, CONFIG_FILE,
      JSON.stringify(State.config, null, 2) + '\n', 'application/json');
    await set(IDB_CONFIG_KEY, State.config);
  } catch (error) {
    console.warn('[localnotes] could not persist config.json', error);
  }
}, 700);

/* ===========================================================================
 * 7. TRAVERSAL + PARSING
 * =========================================================================*/

const domParser = new DOMParser();

function parseNoteDocument(text) {
  const doc = domParser.parseFromString(text, 'text/html');
  const metaOf = (name) => {
    const node = doc.querySelector(`meta[name="${name}"]`);
    return node ? (node.getAttribute('content') || '').trim() : '';
  };
  const section = doc.querySelector('section#content') ||
    doc.querySelector('#content') ||
    doc.querySelector('main') ||
    doc.body;

  return {
    doc,
    title: (doc.querySelector('title')?.textContent || '').trim(),
    template: metaOf('template') || 'default',
    tags: parseTagList(metaOf('tags')),
    created: metaOf('created'),
    modified: metaOf('modified'),
    author: metaOf('author'),
    contentHtml: section ? section.innerHTML.trim() : '',
    contentText: (section ? section.textContent : '').replace(/\s+/g, ' ').trim()
  };
}

async function scanWorkspace() {
  if (State.scanning) return;
  State.scanning = true;
  const started = performance.now();

  try {
    const notes = [];
    const notesDir = await getDirectory(State.rootHandle, DIR_NOTES, true);
    await walkNotes(notesDir, DIR_NOTES, notes, 0);

    notes.sort((a, b) => (b.modifiedTs - a.modifiedTs) || a.path.localeCompare(b.path));
    State.notes = notes;

    const tagSet = new Map();
    for (const note of notes) {
      for (const tag of note.tags) {
        const key = tag.toLowerCase();
        if (!tagSet.has(key)) tagSet.set(key, tag);
      }
    }
    State.tagUniverse = Array.from(tagSet.values())
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    State.tree = buildTree(notes);
    await loadTemplates();
    await loadQueries();
    rebuildIndex(notes);

    console.info(`[localnotes] indexed ${notes.length} notes in ` +
      `${(performance.now() - started).toFixed(0)}ms`);
  } finally {
    State.scanning = false;
  }
}

async function walkNotes(dirHandle, path, output, depth) {
  if (depth > MAX_SCAN_DEPTH) return;
  for (const [name, handle] of await dirEntries(dirHandle)) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    if (handle.kind === 'directory') {
      if (name === DIR_ASSETS) continue;         /* assets are not notes */
      await walkNotes(handle, `${path}/${name}`, output, depth + 1);
      continue;
    }
    if (!/\.x?html?$/i.test(name)) continue;
    try {
      const record = await buildNoteRecord(handle, dirHandle, `${path}/${name}`);
      output.push(record);
    } catch (error) {
      console.warn(`[localnotes] failed to parse ${path}/${name}`, error);
    }
  }
}

async function buildNoteRecord(fileHandle, parentDir, path) {
  const file = await fileHandle.getFile();
  const text = await file.text();
  const parsed = parseNoteDocument(text);
  const dir = dirname(path);
  const name = basename(path);
  const created = parsed.created || new Date(file.lastModified).toISOString().slice(0, 10);
  const modified = parsed.modified || new Date(file.lastModified).toISOString().slice(0, 10);

  let hasAssets = false;
  try {
    await parentDir.getDirectoryHandle(DIR_ASSETS, { create: false });
    hasAssets = true;
  } catch (_) { hasAssets = false; }

  const title = parsed.title || stripExtension(name);
  const tags = parsed.tags;

  return {
    id: path,
    path,
    dir,
    folder: dir,
    name,
    slug: stripExtension(name),
    title,
    template: parsed.template,
    tags,
    tags_csv: tags.join(', '),
    tags_key: tagKey(tags),
    tag_count: tags.length,
    created,
    modified,
    modifiedTs: Date.parse(modified) || file.lastModified,
    mtime: file.lastModified,
    mtime_iso: new Date(file.lastModified).toISOString(),
    age_days: Math.floor((Date.now() - (Date.parse(modified) || file.lastModified)) / 86400000),
    size: file.size,
    words: parsed.contentText ? parsed.contentText.split(/\s+/).filter(Boolean).length : 0,
    excerpt: parsed.contentText.slice(0, EXCERPT_LENGTH),
    text: parsed.contentText,
    title_lc: title.toLowerCase(),
    text_lc: parsed.contentText.toLowerCase(),
    path_lc: path.toLowerCase(),
    is_bundle: basename(dir).toLowerCase() === stripExtension(name).toLowerCase(),
    has_assets: hasAssets
  };
}

function buildTree(notes) {
  const root = { name: DIR_NOTES, path: DIR_NOTES, kind: 'folder', children: new Map(), notes: [], count: 0 };

  for (const note of notes) {
    const parts = splitPath(note.dir);
    let node = root;
    /* parts[0] is always 'Notes' — start from index 1. */
    for (let i = 1; i < parts.length; i += 1) {
      const segment = parts[i];
      if (!node.children.has(segment)) {
        node.children.set(segment, {
          name: segment,
          path: `${node.path}/${segment}`,
          kind: 'folder',
          children: new Map(),
          notes: [],
          count: 0
        });
      }
      node = node.children.get(segment);
    }
    node.notes.push(note);
  }

  const countUp = (node) => {
    let total = node.notes.length;
    for (const child of node.children.values()) total += countUp(child);
    node.count = total;
    return total;
  };
  countUp(root);
  return root;
}

async function loadTemplates() {
  const templates = [];
  try {
    const dir = await getDirectory(State.rootHandle, DIR_TEMPLATES, true);
    for (const [name, handle] of await dirEntries(dir)) {
      if (handle.kind !== 'file' || !/\.x?html?$/i.test(name)) continue;
      templates.push({
        name: stripExtension(name),
        file: name,
        path: `${DIR_TEMPLATES}/${name}`,
        handle
      });
    }
  } catch (error) {
    console.warn('[localnotes] no Templates directory', error);
  }
  State.templates = templates;
}

async function loadQueries() {
  const queries = [];
  const collect = async (folder) => {
    try {
      const dir = await getDirectory(State.rootHandle, folder, false);
      for (const [name, handle] of await dirEntries(dir)) {
        if (handle.kind !== 'file' || !/\.sql$/i.test(name)) continue;
        queries.push({
          name,
          path: folder ? `${folder}/${name}` : name,
          handle
        });
      }
    } catch (_) { /* folder absent */ }
  };
  await collect(DIR_QUERIES);
  await collect('');
  State.queries = queries.filter((q, i, arr) => arr.findIndex((o) => o.path === q.path) === i);
}

/* ===========================================================================
 * 8. TRANSIENT ALASQL INDEX
 * =========================================================================*/

function sqlEngine() {
  return typeof window.alasql === 'function' ? window.alasql : null;
}

function destroyIndex() {
  const alasql = sqlEngine();
  if (!alasql) return;
  try {
    alasql('DROP TABLE IF EXISTS notes');
    alasql('DROP TABLE IF EXISTS note_tags');
  } catch (_) { /* nothing to drop */ }
}

function rebuildIndex(notes) {
  const alasql = sqlEngine();
  if (!alasql) {
    console.warn('[localnotes] AlaSQL is not available; falling back to JS filtering.');
    return;
  }
  destroyIndex();
  alasql('CREATE TABLE notes');
  alasql('CREATE TABLE note_tags');

  /* Direct data injection keeps the index transient and O(n). */
  alasql.tables.notes.data = notes.map((note) => ({
    id: note.id,
    path: note.path,
    dir: note.dir,
    folder: note.folder,
    name: note.name,
    slug: note.slug,
    title: note.title,
    title_lc: note.title_lc,
    template: note.template,
    tags: note.tags.slice(),
    tags_csv: note.tags_csv,
    tags_key: note.tags_key,
    tag_count: note.tag_count,
    created: note.created,
    modified: note.modified,
    modified_ts: note.modifiedTs,
    mtime: note.mtime,
    mtime_iso: note.mtime_iso,
    age_days: note.age_days,
    size: note.size,
    words: note.words,
    excerpt: note.excerpt,
    text: note.text,
    text_lc: note.text_lc,
    path_lc: note.path_lc,
    is_bundle: note.is_bundle,
    has_assets: note.has_assets
  }));

  const pairs = [];
  for (const note of notes) {
    for (const tag of note.tags) {
      pairs.push({ path: note.path, title: note.title, tag, tag_lc: tag.toLowerCase() });
    }
  }
  alasql.tables.note_tags.data = pairs;
}

function runSql(sql, params = []) {
  const alasql = sqlEngine();
  if (!alasql) throw new Error('AlaSQL is not loaded (lib/alasql.js missing).');
  const result = alasql(sql, params);
  return Array.isArray(result) ? result : (result === undefined ? [] : [result]);
}

/* ===========================================================================
 * 9. SEARCH GRAMMAR + FILTERING
 * =========================================================================*/

/**
 * Parse the search box into structured facets.
 *   free text            → title/text/path LIKE
 *   tag:work  -tag:draft → tag inclusion / exclusion
 *   template:math-journal, folder:Work, title:delta
 *   before:2026-01-01, after:2025-06-01, is:untagged, has:assets
 */
function parseSearch(input) {
  const facets = {
    text: [], tags: [], notTags: [], templates: [], folders: [],
    titles: [], before: '', after: '', untagged: false, hasAssets: false, bundles: false
  };
  const tokens = String(input || '').match(/(?:[^\s"]+|"[^"]*")+/g) || [];

  for (const raw of tokens) {
    const token = raw.replace(/"/g, '').trim();
    if (!token) continue;
    const negated = token.startsWith('-');
    const body = negated ? token.slice(1) : token;
    const separator = body.indexOf(':');

    if (separator > 0) {
      const key = body.slice(0, separator).toLowerCase();
      const value = body.slice(separator + 1).trim();
      if (!value && key !== 'is') continue;
      switch (key) {
        case 'tag':
        case '#':
          (negated ? facets.notTags : facets.tags).push(value.replace(/^#/, '').toLowerCase());
          continue;
        case 'template': facets.templates.push(value.toLowerCase()); continue;
        case 'folder':
        case 'path': facets.folders.push(value.toLowerCase()); continue;
        case 'title': facets.titles.push(value.toLowerCase()); continue;
        case 'before': facets.before = value; continue;
        case 'after': facets.after = value; continue;
        case 'is':
          if (value.toLowerCase() === 'untagged') facets.untagged = true;
          if (value.toLowerCase() === 'bundle') facets.bundles = true;
          continue;
        case 'has':
          if (value.toLowerCase().startsWith('asset')) facets.hasAssets = true;
          continue;
        default: break;
      }
    }
    if (token.startsWith('#')) { facets.tags.push(token.slice(1).toLowerCase()); continue; }
    facets.text.push(body.toLowerCase());
  }
  return facets;
}

function orderByClause() {
  switch (State.config.sortOrder) {
    case 'modified-asc': return 'modified_ts ASC, path ASC';
    case 'created-desc': return 'created DESC, path ASC';
    case 'title-asc': return 'title_lc ASC';
    case 'path-asc': return 'path ASC';
    case 'words-desc': return 'words DESC, path ASC';
    default: return 'modified_ts DESC, path ASC';
  }
}

/**
 * The active note subset:
 *   N_active = { n : n.path starts with F } ∩ { n : T_selected ⊆ n.tags }
 * plus the free-form search facets. Executed as a transient AlaSQL statement so
 * that the GUI and saved .sql files share exactly one query engine.
 */
function computeActiveSet() {
  const facets = parseSearch(State.searchText);
  const where = [];
  const params = [];

  const folder = State.folderFilter && State.folderFilter !== DIR_NOTES ? State.folderFilter : '';
  if (folder) {
    where.push('(path = ? OR path LIKE ?)');
    params.push(folder, `${folder}/%`);
  }

  for (const tag of State.selectedTags) {
    where.push('tags_key LIKE ?');
    params.push(`%|${String(tag).toLowerCase()}|%`);
  }
  for (const tag of facets.tags) {
    where.push('tags_key LIKE ?');
    params.push(`%|${tag}|%`);
  }
  for (const tag of facets.notTags) {
    where.push('tags_key NOT LIKE ?');
    params.push(`%|${tag}|%`);
  }
  for (const template of facets.templates) {
    where.push('LOWER(template) = ?');
    params.push(template);
  }
  for (const needle of facets.folders) {
    where.push('path_lc LIKE ?');
    params.push(`%${needle}%`);
  }
  for (const needle of facets.titles) {
    where.push('title_lc LIKE ?');
    params.push(`%${needle}%`);
  }
  for (const needle of facets.text) {
    where.push('(title_lc LIKE ? OR text_lc LIKE ? OR path_lc LIKE ? OR tags_key LIKE ?)');
    params.push(`%${needle}%`, `%${needle}%`, `%${needle}%`, `%${needle}%`);
  }
  if (facets.before) { where.push('modified < ?'); params.push(facets.before); }
  if (facets.after) { where.push('modified > ?'); params.push(facets.after); }
  if (facets.untagged) where.push('tag_count = 0');
  if (facets.bundles) where.push('is_bundle = true');
  if (facets.hasAssets) where.push('has_assets = true');

  const sql = `SELECT * FROM notes${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ` +
    `ORDER BY ${orderByClause()}`;

  if (!sqlEngine()) return jsFallbackFilter(facets, folder);

  try {
    const rows = runSql(sql, params);
    const byPath = new Map(State.notes.map((note) => [note.path, note]));
    return rows.map((row) => byPath.get(row.path)).filter(Boolean);
  } catch (error) {
    console.warn('[localnotes] SQL filter failed, using JS fallback', error, sql);
    return jsFallbackFilter(facets, folder);
  }
}

/** Pure-JS mirror of the SQL filter (used if AlaSQL is unavailable). */
function jsFallbackFilter(facets, folder) {
  const selected = Array.from(State.selectedTags).map((t) => t.toLowerCase());
  return State.notes.filter((note) => {
    if (folder && note.path !== folder && !note.path.startsWith(`${folder}/`)) return false;
    for (const tag of selected) if (!note.tags_key.includes(`|${tag}|`)) return false;
    for (const tag of facets.tags) if (!note.tags_key.includes(`|${tag}|`)) return false;
    for (const tag of facets.notTags) if (note.tags_key.includes(`|${tag}|`)) return false;
    for (const template of facets.templates) if (note.template.toLowerCase() !== template) return false;
    for (const needle of facets.folders) if (!note.path_lc.includes(needle)) return false;
    for (const needle of facets.titles) if (!note.title_lc.includes(needle)) return false;
    for (const needle of facets.text) {
      if (!note.title_lc.includes(needle) && !note.text_lc.includes(needle) &&
        !note.path_lc.includes(needle) && !note.tags_key.includes(needle)) return false;
    }
    if (facets.before && !(note.modified < facets.before)) return false;
    if (facets.after && !(note.modified > facets.after)) return false;
    if (facets.untagged && note.tag_count !== 0) return false;
    if (facets.bundles && !note.is_bundle) return false;
    if (facets.hasAssets && !note.has_assets) return false;
    return true;
  });
}

/** Clicking a saved .sql file hands total authority to the statement. */
async function activateQuery(query) {
  if (State.activeQuery && State.activeQuery.path === query.path) {
    releaseQuery();
    return;
  }
  try {
    const sql = await readTextFromHandle(query.handle);
    State.activeQuery = { name: query.name, path: query.path, sql };
    refreshResults();
    renderQueries();
    renderTags();
    renderTree();
    UI.searchInput.disabled = true;
    UI.searchInput.title = 'Suspended: a saved SQL query is driving the index.';
  } catch (error) {
    toast(`Could not read ${query.name}: ${error.message}`, 'error');
  }
}

function releaseQuery() {
  State.activeQuery = null;
  State.rawRows = null;
  UI.searchInput.disabled = false;
  UI.searchInput.title = '';
  refreshResults();
  renderQueries();
  renderTags();
  renderTree();
}

function runActiveQuery() {
  const statements = State.activeQuery.sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.replace(/(^|\n)\s*--[^\n]*/g, '').trim())
    .filter(Boolean);

  let rows = [];
  for (const statement of statements) rows = runSql(statement);
  const byPath = new Map(State.notes.map((note) => [note.path, note]));
  const notes = [];
  const raw = [];
  for (const row of rows) {
    if (row && typeof row === 'object' && row.path && byPath.has(row.path)) notes.push(byPath.get(row.path));
    else raw.push(row);
  }
  return { notes, raw };
}

function refreshResults() {
  if (!State.mounted) {
    State.results = [];
    State.rawRows = null;
    renderResults();
    return;
  }

  if (State.activeQuery) {
    try {
      const { notes, raw } = runActiveQuery();
      State.results = notes;
      State.rawRows = raw.length ? raw : null;
    } catch (error) {
      State.results = [];
      State.rawRows = null;
      renderResults(`SQL error in ${State.activeQuery.name}: ${error.message}`);
      return;
    }
  } else {
    State.results = computeActiveSet();
    State.rawRows = null;
  }
  renderResults();
  renderTags();
}

/* ===========================================================================
 * 10. RENDERING — SIDEBAR
 * =========================================================================*/

function renderAll() {
  renderTree();
  renderTags();
  renderQueries();
  renderTemplateSelect();
  refreshResults();
  UI.btnMount.textContent = State.mounted ? '[ Change Folder ]' : '[ Mount Folder ]';
}

function renderTree() {
  const container = UI.fileTree;
  container.innerHTML = '';

  if (!State.mounted) {
    container.append(el('div', { class: 'tree-empty', text: 'No folder mounted.' }));
    return;
  }
  if (!State.tree || (!State.tree.count && !State.tree.children.size)) {
    container.append(el('div', { class: 'tree-empty', text: 'No notes yet — create one.' }));
    return;
  }

  const suspended = Boolean(State.activeQuery);
  const rootRow = folderRow(State.tree, 0, suspended);
  container.append(rootRow.row);
  container.append(rootRow.childrenWrap);
}

function folderRow(node, depth, suspended) {
  const isExpanded = State.expanded.has(node.path);
  const hasChildren = node.children.size > 0 || node.notes.length > 0;
  const isSelected = State.folderFilter === node.path && !suspended;

  const row = el('div', {
    class: `tree-node tree-folder${isExpanded ? '' : ' is-collapsed'}${isSelected ? ' is-selected' : ''}`,
    dataset: { path: node.path, kind: 'folder' },
    title: node.path,
    style: `padding-left:${8 + depth * 14}px`
  }, [
    el('span', { class: `tree-twisty${hasChildren ? '' : ' is-empty'}`, text: '▼' }),
    el('span', { class: 'tree-icon', text: isExpanded ? '▣' : '▢' }),
    el('span', { class: 'tree-label', text: node.name }),
    el('span', { class: 'tree-count', text: String(node.count) })
  ]);

  const childrenWrap = el('div', { class: 'tree-children' });
  if (!isExpanded) childrenWrap.hidden = true;

  row.addEventListener('click', (event) => {
    if (suspended) {
      toast('Folder filters are suspended while a saved SQL query is active.', 'warn');
      return;
    }
    const onTwisty = event.target.classList.contains('tree-twisty');
    if (onTwisty || (isSelected && hasChildren)) {
      toggleFolder(node.path);
      return;
    }
    State.folderFilter = node.path;
    if (!State.expanded.has(node.path)) State.expanded.add(node.path);
    renderTree();
    refreshResults();
    persistConfig();
  });

  for (const child of Array.from(node.children.values())
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))) {
    const rendered = folderRow(child, depth + 1, suspended);
    childrenWrap.append(rendered.row, rendered.childrenWrap);
  }

  for (const note of node.notes.slice().sort((a, b) => a.title.localeCompare(b.title))) {
    childrenWrap.append(noteRow(note, depth + 1));
  }

  return { row, childrenWrap };
}

function noteRow(note, depth) {
  const isActive = State.current && State.current.path === note.path;
  const row = el('div', {
    class: `tree-node tree-file${isActive ? ' is-active' : ''}${isActive && State.dirty ? ' is-dirty' : ''}`,
    dataset: { path: note.path, kind: 'file' },
    title: `${note.path}\n${note.tags_csv || 'no tags'}`,
    style: `padding-left:${8 + depth * 14}px`
  }, [
    el('span', { class: 'tree-twisty is-empty', text: '▼' }),
    el('span', { class: 'tree-icon', text: '▤' }),
    el('span', { class: 'tree-label', text: note.title || note.name }),
    note.has_assets ? el('span', { class: 'tree-count', text: '⛭' }) : null
  ]);
  row.addEventListener('click', () => openNote(note.path));
  return row;
}

function toggleFolder(path) {
  if (State.expanded.has(path)) State.expanded.delete(path);
  else State.expanded.add(path);
  renderTree();
  persistConfig();
}

/**
 * Faceted tag arithmetic.
 *   N_active = { n : n.path ⊃ F } ∩ { n : T_selected ⊆ n.tags }
 *   T_visible = ⋃ n.tags for n ∈ N_active
 * Tags outside T_visible stay listed but are greyed out, unclickable, with (0).
 */
function renderTags() {
  const container = UI.tagsList;
  container.innerHTML = '';
  const suspended = Boolean(State.activeQuery);
  container.classList.toggle('is-suspended', suspended);

  if (!State.tagUniverse.length) {
    container.append(el('div', { class: 'list-empty', text: State.mounted ? 'No tags found.' : '—' }));
    UI.btnClearTags.style.display = 'none';
    return;
  }

  /* N_active is the current result set when the GUI is in charge; when a SQL
     query is active the counts follow the query output instead. */
  const activeSet = State.results;
  const counts = new Map();
  for (const note of activeSet) {
    for (const tag of note.tags) {
      const key = tag.toLowerCase();
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }

  /* A selected tag is by definition present in every member of N_active. */
  for (const tag of State.selectedTags) {
    const key = tag.toLowerCase();
    if (!counts.has(key)) counts.set(key, activeSet.length);
  }

  for (const tag of State.tagUniverse) {
    const key = tag.toLowerCase();
    const count = counts.get(key) || 0;
    const isActive = Array.from(State.selectedTags).some((t) => t.toLowerCase() === key);
    const isEmpty = count === 0 && !isActive;

    const row = el('button', {
      class: `tag-row${isActive ? ' is-active' : ''}${isEmpty ? ' is-empty' : ''}`,
      type: 'button',
      title: isEmpty ? `${tag} — no notes in the current selection` : `Filter by ${tag}`,
      disabled: isEmpty || suspended,
      'aria-pressed': isActive ? 'true' : 'false'
    }, [
      el('span', { class: 'tag-name', text: `#${tag}` }),
      el('span', { class: 'tag-count', text: `(${count})` })
    ]);

    if (!isEmpty && !suspended) {
      row.addEventListener('click', () => toggleTag(tag));
    }
    container.append(row);
  }

  UI.btnClearTags.style.display = State.selectedTags.size ? '' : 'none';
}

function toggleTag(tag) {
  const key = tag.toLowerCase();
  const existing = Array.from(State.selectedTags).find((t) => t.toLowerCase() === key);
  if (existing) State.selectedTags.delete(existing);
  else State.selectedTags.add(tag);
  refreshResults();
  persistConfig();
}

function renderQueries() {
  const container = UI.queriesList;
  container.innerHTML = '';

  if (!State.mounted) {
    container.append(el('div', { class: 'list-empty', text: '—' }));
    return;
  }
  if (!State.queries.length) {
    container.append(el('div', { class: 'list-empty', text: 'No .sql files yet.' }));
    return;
  }

  for (const query of State.queries) {
    const isActive = State.activeQuery && State.activeQuery.path === query.path;
    const row = el('div', {
      class: `query-row${isActive ? ' is-active' : ''}`,
      title: `${query.path}${isActive ? ' — click to release' : ''}`
    }, [
      el('span', { class: 'query-icon', text: '⛁' }),
      el('span', { class: 'query-name', text: query.name }),
      el('button', {
        class: 'query-del',
        text: '✕',
        title: `Delete ${query.name}`,
        onClick: async (event) => {
          event.stopPropagation();
          if (!(await confirmModal('Delete query',
            `Permanently delete ${query.path} from disk?`, '[ Delete ]'))) return;
          try {
            await removeRecursively(State.rootHandle, query.path);
            if (State.activeQuery && State.activeQuery.path === query.path) releaseQuery();
            await loadQueries();
            renderQueries();
            toast(`${query.name} deleted.`, 'ok');
          } catch (error) {
            toast(`Delete failed: ${error.message}`, 'error');
          }
        }
      })
    ]);
    row.addEventListener('click', () => activateQuery(query));
    container.append(row);
  }
}

/* ===========================================================================
 * 11. RENDERING — RESULTS QUEUE
 * =========================================================================*/

function renderResults(errorMessage) {
  const list = UI.resultsList;
  list.innerHTML = '';

  /* Header: either the facet summary or the active SQL statement. */
  UI.resultsCount.textContent = State.activeQuery
    ? `Query: ⛁ ${State.activeQuery.name} (AlaSQL active)`
    : `Found: ${State.results.length} note${State.results.length === 1 ? '' : 's'}`;

  let release = $('#btn-release-query');
  if (State.activeQuery && !release) {
    release = el('button', {
      class: 'btn-text',
      id: 'btn-release-query',
      text: '[ Release ]',
      title: 'Return authority to the folder and tag filters',
      onClick: () => releaseQuery()
    });
    UI.queueHeader.append(release);
  } else if (!State.activeQuery && release) {
    release.remove();
  }

  if (errorMessage) {
    list.append(el('div', { class: 'results-empty' }, [
      el('div', { class: 'preview-error', text: errorMessage })
    ]));
    return;
  }

  if (!State.mounted) {
    list.append(el('div', { class: 'results-empty', html:
      'Nothing indexed yet.<br><br>Mount a local folder to build the transient index. ' +
      'The scan reads every <code>.html</code> file under <code>Notes/</code> and parses its ' +
      '<code>&lt;meta&gt;</code> header.' }));
    return;
  }

  if (!State.results.length && !State.rawRows) {
    list.append(el('div', { class: 'results-empty', html:
      'No notes match the current selection.<br><br>Try <code>tag:work</code>, ' +
      '<code>-tag:draft</code>, <code>template:math-journal</code>, <code>is:untagged</code>, ' +
      '<code>after:2026-01-01</code> or clear the filters.' }));
    return;
  }

  for (const note of State.results) {
    const isActive = State.current && State.current.path === note.path;
    const item = el('article', {
      class: `result-item${isActive ? ' is-active' : ''}`,
      tabindex: '0',
      dataset: { path: note.path }
    }, [
      el('div', { class: 'result-head' }, [
        el('h3', { class: 'result-title', text: note.title || note.name }),
        el('span', { class: 'result-date', text: note.modified || '' })
      ]),
      el('div', { class: 'result-path', text: note.path }),
      el('p', { class: 'result-excerpt', text: note.excerpt || '(empty note)' }),
      note.tags.length
        ? el('div', { class: 'result-tags' }, note.tags.map((tag) => el('span', {
          class: `result-tag${Array.from(State.selectedTags).some((t) => t.toLowerCase() === tag.toLowerCase()) ? ' is-selected' : ''}`,
          text: `#${tag}`
        })))
        : null
    ]);
    item.addEventListener('click', () => openNote(note.path));
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openNote(note.path);
      }
    });
    list.append(item);
  }

  /* Aggregate / non-note rows from custom SQL are shown verbatim. */
  if (State.rawRows) {
    for (const row of State.rawRows) {
      const wrap = el('div', { class: 'result-raw' });
      if (row && typeof row === 'object') {
        for (const [key, value] of Object.entries(row)) {
          wrap.append(el('div', { class: 'raw-pair' }, [
            el('span', { class: 'rk', text: key }),
            el('span', { class: 'rv', text: Array.isArray(value) ? value.join(', ') : String(value) })
          ]));
        }
      } else {
        wrap.append(el('span', { class: 'rv', text: String(row) }));
      }
      UI.resultsList.append(wrap);
    }
  }
}

/* ===========================================================================
 * 12. WORKSPACE STATES
 * =========================================================================*/

function renderUnsupported() {
  UI.emptyState.style.display = '';
  UI.activeState.style.display = 'none';
  UI.welcomeBox.innerHTML = '';
  UI.welcomeBox.append(
    el('h2', { text: 'Browser not supported' }),
    el('p', { text:
      'LocalNotes needs the File System Access API (window.showDirectoryPicker) to read and ' +
      'write notes directly on your disk. Please use a Chromium-based browser such as Chrome, ' +
      'Edge, Brave or Opera on desktop.' }),
    el('div', { class: 'welcome-hint', text:
      'Everything else about the app is standard HTML: your notes remain readable in any browser.' })
  );
  setStatus('● Unsupported browser', 'error');
}

function showWelcome(mounted = false, errorMessage = '') {
  UI.emptyState.style.display = '';
  UI.activeState.style.display = 'none';
  UI.welcomeBox.innerHTML = '';

  if (!State.supported) { renderUnsupported(); return; }

  if (mounted) {
    UI.welcomeBox.append(
      el('h2', { text: `${State.rootName} is mounted` }),
      el('p', { text: State.notes.length
        ? 'Pick a note from the index, or start a new one. Nothing leaves this machine.'
        : 'This workspace has no notes yet. Create your first one to get started.' }),
      el('button', { class: 'btn', text: '[ + New Note ]', onClick: () => promptNewNote() }),
      el('div', { class: 'welcome-hint', text:
        `Root: ${State.rootName}/\n` +
        `Notes indexed: ${State.notes.length}\n` +
        `Templates: ${State.templates.length}   Queries: ${State.queries.length}` })
    );
  } else {
    UI.welcomeBox.append(
      el('h2', { text: 'Welcome to LocalNotes' }),
      el('p', { text:
        'Please mount your local notes directory to begin writing. All notes are saved 100% ' +
        'locally on your machine.' }),
      el('button', { class: 'btn', id: 'btn-welcome-mount', text: '[ Select Notes Directory ]', onClick: () => pickDirectory() }),
      el('div', { class: 'welcome-hint', text:
        'Expected layout:\n' +
        'MyNotes/\n' +
        '├── config.json\n' +
        '├── Templates/   (academic-article.html, math-journal.html, default-layout.css)\n' +
        '├── Queries/     (stale-notes.sql)\n' +
        '└── Notes/       (Work/Project-Delta/Project-Delta.html + Assets/)\n\n' +
        'Missing folders are created automatically on mount.' })
    );
  }

  if (errorMessage) {
    UI.welcomeBox.append(el('div', { class: 'welcome-error', text: errorMessage }));
  }
  UI.btnWelcomeMount = $('#btn-welcome-mount');
}

/** The PWA lost the permission: require an explicit user gesture. */
function showUnlockState(handle) {
  UI.emptyState.style.display = '';
  UI.activeState.style.display = 'none';
  UI.welcomeBox.innerHTML = '';
  setStatus('● Folder locked', 'pending');

  UI.welcomeBox.append(
    el('h2', { text: 'Unlock your notes folder' }),
    el('p', { text:
      `Your workspace "${handle.name}" is remembered, but the browser needs a single click ` +
      'to restore read/write permission for this session. Nothing is uploaded — the click only ' +
      're-authorises local disk access.' }),
    el('button', {
      class: 'btn',
      id: 'btn-unlock',
      text: '[ Unlock Folder ]',
      onClick: async (event) => {
        event.currentTarget.disabled = true;
        const granted = await askPermission(handle, 'readwrite');
        if (granted === 'granted') {
          await mountRoot(handle);
        } else {
          event.currentTarget.disabled = false;
          toast('Permission denied. Pick the folder again to re-authorise it.', 'error');
          showWelcome(false, 'Permission for the remembered folder was denied.');
        }
      }
    }),
    el('button', {
      class: 'btn btn-secondary',
      text: '[ Choose a different folder ]',
      onClick: () => pickDirectory()
    }),
    el('div', { class: 'welcome-hint', text:
      'Tip: install LocalNotes as an app (address bar → Install) to make the browser remember ' +
      'this permission across launches.' })
  );
}

function showEditor() {
  UI.emptyState.style.display = 'none';
  UI.activeState.style.display = '';
}

function setSaveStatus(text, kind = 'saved') {
  UI.saveStatus.textContent = text;
  UI.saveStatus.className = `mono-label is-${kind}`;
}

/* ===========================================================================
 * 13. EDITOR ADAPTER (HugeRTE, with a real textarea fallback)
 * =========================================================================*/

const EDITOR_CONTENT_STYLE = `
  html, body { background: #FCFCFA; }
  body {
    font-family: Georgia, "EB Garamond", Garamond, "Iowan Old Style", serif;
    font-size: 17px;
    line-height: 1.62;
    color: #1a1c1b;
    margin: 18px 0 60px;
    padding: 0;
    max-width: none;
  }
  h1 { font-size: 30px; font-weight: 600; line-height: 1.2; margin: 0 0 .6em; }
  h2 { font-size: 24px; font-weight: 600; margin: 1.5em 0 .5em; }
  h3 { font-size: 20px; font-weight: 600; margin: 1.3em 0 .4em; }
  p { margin: 0 0 1.05em; }
  ul, ol { margin: 0 0 1.05em; padding-left: 1.4em; }
  blockquote {
    margin: 1.2em 0; padding: .2em 0 .2em 1.1em;
    border-left: 2px solid #1d59c1; color: #4b463f; font-style: italic;
  }
  a { color: #1d59c1; }
  code, kbd, samp { font-family: "JetBrains Mono", ui-monospace, Menlo, monospace; font-size: .88em; background: #F4F4F2; padding: .08em .3em; }
  pre { font-family: "JetBrains Mono", ui-monospace, Menlo, monospace; font-size: 13px; background: #F4F4F2; border: 1px solid #E6E6E2; padding: 12px 14px; overflow-x: auto; }
  img { max-width: 100%; height: auto; }
  hr { border: 0; border-top: 1px solid #E6E6E2; margin: 2em 0; }
  table { width: 100%; border-collapse: collapse; font-family: Inter, system-ui, sans-serif; font-size: 14px; }
  table th, table td { border: 1px solid #E6E6E2; padding: 8px 10px; text-align: left; }
  table th { background: #F4F4F2; font-weight: 600; }
  ::selection { background: #e8eefb; }
`;

class EditorAdapter {
  constructor() {
    this.mode = 'textarea';
    this.instance = null;
    this.ready = false;
    this.onChange = () => {};
    this.onCursor = () => {};
  }

  async init() {
    if (this.ready) return this;
    if (typeof window.hugerte === 'object' && window.hugerte && typeof window.hugerte.init === 'function') {
      try {
        await this.initHugeRte();
        this.mode = 'hugerte';
        this.ready = true;
        return this;
      } catch (error) {
        console.error('[localnotes] HugeRTE failed to initialise; using plain textarea', error);
        toast('Rich editor unavailable — falling back to plain HTML editing.', 'warn');
      }
    }
    this.initTextarea();
    this.mode = 'textarea';
    this.ready = true;
    return this;
  }

  async initHugeRte() {
    const editors = await window.hugerte.init({
      target: UI.textarea,
      base_url: './lib/hugerte',
      suffix: '.min',
      skin: 'oxide',
      content_css: false,
      content_style: EDITOR_CONTENT_STYLE,
      menubar: false,
      statusbar: false,
      branding: false,
      promotion: false,
      elementpath: false,
      resize: false,
      min_height: 460,
      autoresize_bottom_margin: 90,
      plugins: [
        'autolink', 'autoresize', 'charmap', 'code', 'codesample', 'link', 'lists',
        'advlist', 'searchreplace', 'table', 'visualblocks', 'wordcount', 'image',
        'insertdatetime', 'nonbreaking', 'anchor', 'quickbars'
      ].join(' '),
      toolbar: 'blocks | bold italic underline | bullist numlist | blockquote link image table | ' +
        'code codesample charmap | removeformat searchreplace',
      quickbars_insert_toolbar: false,
      quickbars_selection_toolbar: 'bold italic | blockquote link',
      block_formats: 'Paragraph=p; Heading 1=h1; Heading 2=h2; Heading 3=h3; ' +
        'Heading 4=h4; Preformatted=pre; Blockquote=blockquote',
      /* --- style firewall, layer one: never let the editor emit styling --- */
      convert_urls: false,
      relative_urls: false,
      remove_script_host: false,
      inline_styles: false,
      formats: {
        bold: { inline: 'strong' },
        italic: { inline: 'em' },
        underline: { inline: 'u' },
        strikethrough: { inline: 's' }
      },
      invalid_styles: {
        '*': 'color font-size font-family background background-color line-height ' +
          'letter-spacing text-align margin margin-left margin-right margin-top margin-bottom ' +
          'padding padding-left padding-right width height border border-collapse float',
        table: 'width height border border-collapse',
        td: 'width height border padding vertical-align',
        th: 'width height border padding vertical-align',
        img: 'width height'
      },
      table_default_attributes: {},
      table_default_styles: {},
      table_use_colgroups: false,
      table_advtab: false,
      table_cell_advtab: false,
      table_row_advtab: false,
      table_style_by_css: false,
      object_resizing: false,
      paste_data_images: false,
      paste_as_text: false,
      paste_remove_styles_if_webkit: true,
      extended_valid_elements: 'section[id|class],figure,figcaption,mark,abbr[title],' +
        'time[datetime],details,summary,sup,sub,math[xmlns|display],semantics,mrow,mi,mn,mo,' +
        'msup,msub,mfrac,msqrt,annotation[encoding]',
      valid_children: '+section[div|p|h1|h2|h3|h4|ul|ol|table|figure|pre|blockquote]',
      setup: (editor) => {
        this.instance = editor;
        editor.on('Dirty input NodeChange ExecCommand SetContent undo redo', () => {
          if (this.suppress) return;
          this.onChange();
        });
        editor.on('NodeChange KeyUp MouseUp SelectionChange', () => {
          this.onCursor(this.cursor());
        });
        editor.on('keydown', (event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            saveCurrentNote(true);
          }
        });
      }
    });
    if (!editors || !editors.length) throw new Error('HugeRTE returned no editor instance');
    return editors[0];
  }

  initTextarea() {
    UI.textarea.style.display = '';
    UI.textarea.addEventListener('input', () => {
      if (this.suppress) return;
      this.onChange();
      this.onCursor(this.cursor());
    });
    UI.textarea.addEventListener('keyup', () => this.onCursor(this.cursor()));
    UI.textarea.addEventListener('click', () => this.onCursor(this.cursor()));
  }

  getContent() {
    if (this.mode === 'hugerte' && this.instance) return this.instance.getContent({ format: 'html' });
    return UI.textarea.value;
  }

  setContent(html) {
    this.suppress = true;
    try {
      if (this.mode === 'hugerte' && this.instance) {
        this.instance.setContent(html || '', { format: 'html' });
        this.instance.undoManager.clear();
        this.instance.setDirty(false);
      } else {
        UI.textarea.value = html || '';
      }
    } finally {
      this.suppress = false;
    }
  }

  focus() {
    if (this.mode === 'hugerte' && this.instance) this.instance.focus();
    else UI.textarea.focus();
  }

  /** Real Ln/Col computation from the live selection. */
  cursor() {
    if (this.mode === 'hugerte' && this.instance) {
      try {
        const range = this.instance.selection.getRng();
        const body = this.instance.getBody();
        const blocks = Array.from(body.children);
        let block = range.startContainer;
        while (block && block.parentNode && block.parentNode !== body) block = block.parentNode;
        const line = block && blocks.indexOf(block) >= 0 ? blocks.indexOf(block) + 1 : 1;
        let column = 1;
        if (block && block.nodeType === 1) {
          const probe = body.ownerDocument.createRange();
          probe.selectNodeContents(block);
          probe.setEnd(range.startContainer, range.startOffset);
          column = probe.toString().length + 1;
        }
        return { line, column };
      } catch (_) {
        return { line: 1, column: 1 };
      }
    }
    const value = UI.textarea.value.slice(0, UI.textarea.selectionStart || 0);
    const lines = value.split('\n');
    return { line: lines.length, column: lines[lines.length - 1].length + 1 };
  }

  wordCount() {
    const text = this.mode === 'hugerte' && this.instance
      ? this.instance.getContent({ format: 'text' })
      : UI.textarea.value.replace(/<[^>]+>/g, ' ');
    return text.split(/\s+/).filter(Boolean).length;
  }
}

async function ensureEditor() {
  if (!State.editor) {
    State.editor = new EditorAdapter();
    State.editor.onChange = handleEditorChange;
    State.editor.onCursor = ({ line, column }) => {
      UI.cursorPosition.textContent = `Ln ${line}, Col ${column}`;
    };
    await State.editor.init();
  }
  return State.editor;
}

/* ===========================================================================
 * 14. OPENING NOTES  (structural decoupling)
 * =========================================================================*/

async function openNote(path, { force = false } = {}) {
  if (!State.rootHandle) return;
  if (State.current && State.current.path === path && !force) {
    showEditor();
    return;
  }

  if (State.dirty) {
    if (State.config.autosave) {
      await saveCurrentNote(false);
    } else if (!(await confirmModal('Unsaved changes',
      'Discard the unsaved changes in the current note?', '[ Discard ]'))) {
      return;
    }
  }

  let handle;
  let text;
  try {
    handle = await getFileHandleAt(State.rootHandle, path, false);
    text = await readTextFromHandle(handle);
  } catch (error) {
    toast(`Could not open ${path}: ${error.message}`, 'error');
    await refreshIndex();
    return;
  }

  const parsed = parseNoteDocument(text);
  const dirHandle = await getDirectory(State.rootHandle, dirname(path), false);

  /* The <head> skeleton (and everything else outside #content) is kept
     in-memory only. It is never handed to the editor DOM. */
  State.current = {
    path,
    dir: dirname(path),
    name: basename(path),
    handle,
    dirHandle,
    doc: parsed.doc,
    meta: {
      title: parsed.title || stripExtension(basename(path)),
      template: parsed.template || State.config.defaultTemplate || 'default',
      tags: parsed.tags,
      created: parsed.created || todayISO(),
      modified: parsed.modified || todayISO()
    },
    originalHtml: parsed.contentHtml
  };

  await ensureEditor();
  State.editor.setContent(parsed.contentHtml);

  UI.titleInput.value = State.current.meta.title;
  UI.tagsInput.value = State.current.meta.tags.join(', ');
  UI.filePath.textContent = `File: ~/${State.rootName}/${path}`;
  UI.filePath.title = `~/${State.rootName}/${path}`;
  UI.encoding.textContent = 'UTF-8';
  renderTemplateSelect();
  markClean();
  showEditor();
  updateMetaStat();

  State.config.lastNote = path;
  persistConfig();

  renderTree();
  renderResults();
  if (State.viewMode === 'preview') await renderPreview();
  const { line, column } = State.editor.cursor();
  UI.cursorPosition.textContent = `Ln ${line}, Col ${column}`;
}

function updateMetaStat() {
  let stat = $('.meta-stat', UI.metaBar);
  if (!stat) {
    stat = el('span', { class: 'meta-stat' });
    UI.metaBar.append(stat);
  }
  if (!State.current) { stat.textContent = ''; return; }
  const words = State.editor ? State.editor.wordCount() : 0;
  stat.textContent = `${words} words · created ${State.current.meta.created} · ` +
    `modified ${State.current.meta.modified}`;
}

function markDirty() {
  if (State.dirty) return;
  State.dirty = true;
  setSaveStatus('Unsaved changes…', 'dirty');
  const activeRow = $('.tree-node.is-active', UI.fileTree);
  if (activeRow) activeRow.classList.add('is-dirty');
}

function markClean() {
  State.dirty = false;
  State.lastSavedAt = Date.now();
  setSaveStatus('All changes saved', 'saved');
  const activeRow = $('.tree-node.is-active', UI.fileTree);
  if (activeRow) activeRow.classList.remove('is-dirty');
}

function handleEditorChange() {
  if (!State.current) return;
  markDirty();
  updateMetaStat();
  if (State.config.autosave) {
    autosaveWithDelay(Math.max(400, Number(State.config.autosaveDelay) || 1500));
  }
}

let autosaveTimer = 0;
function autosaveWithDelay(delay) {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    if (State.config.autosave && State.dirty && !State.saving) saveCurrentNote(false);
  }, delay);
}

/* ===========================================================================
 * 15. THE SAVE FIREWALL
 * =========================================================================*/

/**
 * Recursively purge every trace of presentation and editor bookkeeping from raw
 * editor output. Returns clean, standards-only HTML.
 */
function sanitizeEditorHtml(rawHtml) {
  const doc = domParser.parseFromString(
    `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${rawHtml || ''}</body></html>`,
    'text/html'
  );

  const walk = (node) => {
    /* Snapshot children: the list mutates while we clean. */
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.COMMENT_NODE) {
        const value = child.nodeValue || '';
        if (/^\s*mce|data-mce|StartFragment|EndFragment/i.test(value)) child.remove();
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;

      const tag = child.tagName.toLowerCase();

      if (DROP_TAGS.has(tag)) {
        if (tag === 'colgroup' || tag === 'style' || tag === 'link' || tag === 'script') {
          child.remove();
          continue;
        }
        unwrap(child);
        continue;
      }

      /* Editor bogus nodes. */
      if (child.hasAttribute('data-mce-bogus')) {
        if (child.getAttribute('data-mce-bogus') === 'all') { child.remove(); continue; }
        unwrap(child);
        continue;
      }

      /* Strip presentational + bookkeeping attributes. */
      for (const attribute of Array.from(child.attributes)) {
        const name = attribute.name.toLowerCase();
        if (BANNED_ATTRIBUTES.includes(name) ||
          name.startsWith('data-mce') ||
          name.startsWith('on') ||
          name === 'srcset' && !attribute.value.trim()) {
          child.removeAttribute(attribute.name);
          continue;
        }
        if (name === 'class') {
          const kept = attribute.value.split(/\s+/)
            .filter((token) => token && !/^mce/i.test(token) && !/^tox/i.test(token) &&
              !/^Mso/i.test(token));
          if (kept.length) child.setAttribute('class', kept.join(' '));
          else child.removeAttribute('class');
          continue;
        }
        if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(attribute.value)) {
          child.removeAttribute(attribute.name);
        }
        if (name === 'id' && /^mce[_-]/i.test(attribute.value)) child.removeAttribute('id');
      }

      /* Presentational wrappers: keep the words, drop the paint. */
      if (UNWRAP_TAGS.has(tag)) {
        walk(child);
        unwrap(child);
        continue;
      }

      /* Attribute-less spans/divs that only existed to carry a style. */
      if ((tag === 'span' || tag === 'font') && child.attributes.length === 0) {
        walk(child);
        unwrap(child);
        continue;
      }

      walk(child);

      /* Drop leftover empty inline shells. */
      if (['span', 'em', 'strong', 'u', 's', 'b', 'i', 'mark', 'small'].includes(tag) &&
        !child.attributes.length && !child.textContent.trim() && !child.querySelector('img, br')) {
        child.remove();
      }
    }
  };

  const unwrap = (element) => {
    const parent = element.parentNode;
    if (!parent) return;
    while (element.firstChild) parent.insertBefore(element.firstChild, element);
    parent.removeChild(element);
  };

  walk(doc.body);

  /* Nested-list normalisation: <ul> directly inside <ul> is illegal HTML. */
  for (const list of Array.from(doc.body.querySelectorAll('ul > ul, ul > ol, ol > ul, ol > ol'))) {
    const previous = list.previousElementSibling;
    if (previous && previous.tagName.toLowerCase() === 'li') previous.append(list);
    else {
      const item = doc.createElement('li');
      list.parentNode.insertBefore(item, list);
      item.append(list);
    }
  }

  return tidyHtml(doc.body.innerHTML);
}

/** Light, whitespace-safe pretty printing for human-readable note files. */
function tidyHtml(html) {
  const blocks = 'address|article|aside|blockquote|details|div|dl|dt|dd|fieldset|figcaption|' +
    'figure|footer|form|h1|h2|h3|h4|h5|h6|header|hr|li|main|nav|ol|p|pre|section|summary|' +
    'table|tbody|td|tfoot|th|thead|tr|ul';
  return String(html)
    .replace(new RegExp(`\\s*<(${blocks})(\\s|>)`, 'gi'), '\n<$1$2')
    .replace(new RegExp(`</(${blocks})>\\s*`, 'gi'), '</$1>\n')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line, index, arr) => !(line === '' && arr[index - 1] === ''))
    .join('\n')
    .trim();
}

/** Stitch clean content back into the preserved <head> skeleton. */
function serializeNoteDocument(cleanContent) {
  const current = State.current;
  const doc = current.doc;

  /* --- refresh the metadata header ------------------------------------- */
  const head = doc.head || doc.createElement('head');
  if (!doc.head) doc.documentElement.prepend(head);

  const ensureMeta = (name, content) => {
    let node = head.querySelector(`meta[name="${name}"]`);
    if (!node) {
      node = doc.createElement('meta');
      node.setAttribute('name', name);
      head.append(node);
    }
    node.setAttribute('content', content);
  };

  if (!head.querySelector('meta[charset]')) {
    const charset = doc.createElement('meta');
    charset.setAttribute('charset', 'UTF-8');
    head.prepend(charset);
  }
  let titleNode = head.querySelector('title');
  if (!titleNode) {
    titleNode = doc.createElement('title');
    head.append(titleNode);
  }
  titleNode.textContent = current.meta.title || stripExtension(current.name);

  ensureMeta('template', current.meta.template || 'default');
  ensureMeta('tags', current.meta.tags.join(', '));
  ensureMeta('created', current.meta.created || todayISO());
  ensureMeta('modified', todayISO());
  current.meta.modified = todayISO();

  /* --- put the purified body back inside <section id="content"> -------- */
  let section = doc.querySelector('section#content');
  if (!section) {
    section = doc.createElement('section');
    section.id = 'content';
    (doc.body || doc.documentElement).append(section);
  }
  section.innerHTML = `\n${cleanContent}\n`;

  const headHtml = Array.from(head.children)
    .map((node) => `    ${node.outerHTML}`)
    .join('\n');

  const bodyHtml = Array.from(doc.body.children)
    .map((node) => node.outerHTML)
    .join('\n');

  const lang = doc.documentElement.getAttribute('lang') || 'en';

  return `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}">
<head>
${headHtml}
</head>
<body>
${bodyHtml}
</body>
</html>
`;
}

async function saveCurrentNote(explicit = true) {
  if (!State.current || State.saving) return false;
  const current = State.current;

  State.saving = true;
  setSaveStatus('Saving…', 'saving');

  try {
    current.meta.title = UI.titleInput.value.trim() || stripExtension(current.name);
    current.meta.tags = parseTagList(UI.tagsInput.value);
    current.meta.template = UI.templateSelect.value || current.meta.template || 'default';

    const raw = State.editor ? State.editor.getContent() : '';
    const clean = sanitizeEditorHtml(raw);
    const document_ = serializeNoteDocument(clean);

    await writeTextToHandle(current.handle, document_);

    current.originalHtml = clean;
    markClean();
    if (explicit) toast(`Saved ${current.name}`, 'ok', 2200);

    /* Refresh only the affected index row — no full rescan needed. */
    await refreshNoteRecord(current.path);
    updateMetaStat();
    persistConfig();
    return true;
  } catch (error) {
    console.error('[localnotes] save failed', error);
    setSaveStatus(`Save failed: ${error.message}`, 'error');
    toast(`Save failed: ${error.message}`, 'error', 8000);
    return false;
  } finally {
    State.saving = false;
  }
}

async function refreshNoteRecord(path) {
  try {
    const dirHandle = await getDirectory(State.rootHandle, dirname(path), false);
    const fileHandle = await dirHandle.getFileHandle(basename(path), { create: false });
    const record = await buildNoteRecord(fileHandle, dirHandle, path);
    const index = State.notes.findIndex((note) => note.path === path);
    if (index >= 0) State.notes[index] = record;
    else State.notes.push(record);

    const universe = new Map(State.tagUniverse.map((t) => [t.toLowerCase(), t]));
    for (const tag of record.tags) {
      if (!universe.has(tag.toLowerCase())) universe.set(tag.toLowerCase(), tag);
    }
    State.tagUniverse = Array.from(universe.values())
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    State.tree = buildTree(State.notes);
    rebuildIndex(State.notes);
    refreshResults();
    renderTree();
  } catch (error) {
    console.warn('[localnotes] could not refresh index row', error);
  }
}

async function refreshIndex() {
  if (!State.rootHandle) return;
  setStatus('● Indexing…', 'pending');
  try {
    await scanWorkspace();
    renderAll();
    setStatus(`● ${State.rootName} mounted`, 'connected');
  } catch (error) {
    setStatus('● Index error', 'error');
    toast(`Re-index failed: ${error.message}`, 'error');
  }
}

/* ===========================================================================
 * 16. TEMPLATE RENDERING (assets → Blob URLs, modules → dynamic import)
 * =========================================================================*/

function releaseBlobUrls() {
  for (const url of State.blobUrls) URL.revokeObjectURL(url);
  for (const url of State.moduleUrls) URL.revokeObjectURL(url);
  State.blobUrls = [];
  State.moduleUrls = [];
  State.assetCache.clear();
}

function trackBlob(url, kind = 'asset') {
  if (kind === 'module') State.moduleUrls.push(url);
  else State.blobUrls.push(url);
  return url;
}

/** Read a local file and hand back a Blob URL the browser can render. */
async function assetBlobUrl(absolutePath) {
  if (State.assetCache.has(absolutePath)) return State.assetCache.get(absolutePath);
  const handle = await getFileHandleAt(State.rootHandle, absolutePath, false);
  const file = await handle.getFile();
  const url = trackBlob(URL.createObjectURL(file));
  State.assetCache.set(absolutePath, url);
  return url;
}

const ASSET_ATTRIBUTES = [
  ['img', 'src'], ['img', 'poster'], ['source', 'src'], ['video', 'src'],
  ['video', 'poster'], ['audio', 'src'], ['track', 'src'], ['embed', 'src'],
  ['object', 'data'], ['a', 'href'], ['iframe', 'src'], ['input', 'src']
];

/**
 * Swap every relative asset reference inside `container` for a Blob URL read
 * straight off the hard drive. Base is the note's own directory, so
 * ./Assets/architecture.png resolves inside the note bundle.
 */
async function resolveAssets(container, baseDir) {
  const jobs = [];

  for (const [tag, attribute] of ASSET_ATTRIBUTES) {
    for (const node of Array.from(container.querySelectorAll(tag))) {
      const value = node.getAttribute(attribute);
      if (!value || isExternalUrl(value)) continue;
      const target = resolveRelative(baseDir, value);
      jobs.push(assetBlobUrl(target)
        .then((url) => {
          node.setAttribute(attribute, url);
          if (tag === 'a') {
            node.setAttribute('target', '_blank');
            node.setAttribute('rel', 'noopener');
            node.setAttribute('download', basename(target));
          }
        })
        .catch((error) => {
          console.warn(`[localnotes] missing asset ${target}`, error);
          if (tag === 'img') {
            node.replaceWith(el('span', {
              class: 'preview-error',
              text: `Missing asset: ${value}`
            }));
          }
        }));
    }
  }

  /* srcset support */
  for (const node of Array.from(container.querySelectorAll('img[srcset], source[srcset]'))) {
    const parts = node.getAttribute('srcset').split(',').map((entry) => entry.trim()).filter(Boolean);
    jobs.push(Promise.all(parts.map(async (entry) => {
      const [url, descriptor = ''] = entry.split(/\s+/);
      if (!url || isExternalUrl(url)) return entry;
      try {
        const blob = await assetBlobUrl(resolveRelative(baseDir, url));
        return `${blob} ${descriptor}`.trim();
      } catch (_) { return entry; }
    })).then((resolved) => node.setAttribute('srcset', resolved.join(', '))));
  }

  /* url(...) inside inline styles and <style> blocks */
  const rewriteCssUrls = async (css) => {
    const matches = Array.from(css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi));
    let output = css;
    for (const match of matches) {
      const reference = match[2];
      if (isExternalUrl(reference)) continue;
      try {
        const blob = await assetBlobUrl(resolveRelative(baseDir, reference));
        output = output.split(match[0]).join(`url("${blob}")`);
      } catch (_) { /* leave as-is */ }
    }
    return output;
  };

  for (const node of Array.from(container.querySelectorAll('[style*="url("]'))) {
    jobs.push(rewriteCssUrls(node.getAttribute('style'))
      .then((css) => node.setAttribute('style', css)));
  }
  for (const node of Array.from(container.querySelectorAll('style'))) {
    if (!/url\(/i.test(node.textContent)) continue;
    jobs.push(rewriteCssUrls(node.textContent).then((css) => { node.textContent = css; }));
  }

  await Promise.all(jobs);
  return container;
}

/**
 * Compile a template module into a Blob URL, recursively inlining its own
 * relative imports so that ES module graphs still work from a blob origin.
 */
async function buildModuleBlob(code, baseDir, depth = 0, seen = new Map()) {
  let source = code;

  if (depth < MODULE_IMPORT_DEPTH) {
    const importPattern = /(from\s*|import\s*|import\(\s*)(['"])(\.{1,2}\/[^'"]+)\2/g;
    const replacements = [];
    let match;
    while ((match = importPattern.exec(code)) !== null) {
      replacements.push({ full: match[0], prefix: match[1], quote: match[2], path: match[3] });
    }
    for (const replacement of replacements) {
      const target = resolveRelative(baseDir, replacement.path);
      try {
        let url = seen.get(target);
        if (!url) {
          const text = await readTextAt(State.rootHandle, target);
          url = await buildModuleBlob(text, dirname(target), depth + 1, seen);
          seen.set(target, url);
        }
        source = source.split(replacement.full)
          .join(`${replacement.prefix}${replacement.quote}${url}${replacement.quote}`);
      } catch (error) {
        console.warn(`[localnotes] template module import unresolved: ${target}`, error);
      }
    }
  }

  const blob = new Blob([source], { type: 'text/javascript' });
  return trackBlob(URL.createObjectURL(blob), 'module');
}

function substituteTokens(root, values) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  const pattern = /\{\{\s*([a-z0-9_.-]+)\s*\}\}/gi;
  const replace = (input) => input.replace(pattern, (whole, key) => {
    const value = values[key.toLowerCase()];
    return value === undefined ? whole : String(value);
  });

  let node = walker.currentNode;
  while (node) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (pattern.test(node.nodeValue)) node.nodeValue = replace(node.nodeValue);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      for (const attribute of Array.from(node.attributes || [])) {
        if (attribute.value.includes('{{')) {
          node.setAttribute(attribute.name, replace(attribute.value));
        }
      }
    }
    node = walker.nextNode();
  }
}

async function renderPreview() {
  const pane = UI.renderedView;
  if (!State.current) {
    pane.innerHTML = '';
    return;
  }

  releaseBlobUrls();
  pane.innerHTML = '';
  pane.classList.remove('is-fullbleed');

  const note = State.current;
  const contentHtml = sanitizeEditorHtml(State.editor ? State.editor.getContent() : note.originalHtml);
  const templateName = UI.templateSelect.value || note.meta.template || 'default';
  const template = State.templates.find((item) => item.name === templateName);

  /* The note content lives in its own container so assets resolve relative to
     the note bundle, not the template folder. */
  const contentHost = document.createElement('div');
  contentHost.innerHTML = contentHtml;
  try {
    await resolveAssets(contentHost, note.dir);
  } catch (error) {
    console.warn('[localnotes] asset resolution problem', error);
  }

  const tokens = {
    title: note.meta.title,
    tags: note.meta.tags.join(', '),
    taglist: note.meta.tags.map((t) => `#${t}`).join(' '),
    created: note.meta.created,
    modified: note.meta.modified,
    template: templateName,
    path: note.path,
    filename: note.name,
    workspace: State.rootName,
    words: State.editor ? State.editor.wordCount() : 0
  };

  if (!template) {
    /* No template file: render the bare note under the optional default CSS. */
    await injectDefaultLayout(pane);
    const header = el('header', { class: 'note-default-header' }, [
      el('h1', { text: note.meta.title }),
      note.meta.tags.length
        ? el('p', { class: 'note-default-tags', text: note.meta.tags.map((t) => `#${t}`).join('  ') })
        : null
    ]);
    pane.append(header);
    while (contentHost.firstChild) pane.append(contentHost.firstChild);
    return;
  }

  let templateText;
  try {
    templateText = await readTextFromHandle(template.handle);
  } catch (error) {
    pane.append(el('div', { class: 'preview-error', text:
      `Template "${templateName}" could not be read: ${error.message}` }));
    while (contentHost.firstChild) pane.append(contentHost.firstChild);
    return;
  }

  const templateDoc = domParser.parseFromString(templateText, 'text/html');
  const templateDir = DIR_TEMPLATES;

  /* Pull scripts out before anything touches the live DOM. */
  const scripts = Array.from(templateDoc.querySelectorAll('script'))
    .map((node) => ({
      type: (node.getAttribute('type') || '').toLowerCase(),
      src: node.getAttribute('src') || '',
      code: node.textContent || ''
    }));
  for (const node of Array.from(templateDoc.querySelectorAll('script'))) node.remove();

  /* Inject the note into the template's slot. */
  const slot = templateDoc.querySelector('[data-note-content]') ||
    templateDoc.querySelector('#note-content') ||
    templateDoc.querySelector('#content') ||
    templateDoc.querySelector('main') ||
    templateDoc.body;
  slot.innerHTML = '';
  while (contentHost.firstChild) slot.append(contentHost.firstChild);

  substituteTokens(templateDoc.body, tokens);
  if (templateDoc.head) substituteTokens(templateDoc.head, tokens);

  /* Template-owned assets resolve against Templates/. */
  try {
    await resolveAssets(templateDoc.body, templateDir);
  } catch (error) {
    console.warn('[localnotes] template asset problem', error);
  }

  /* Styles: inline <style> blocks and local <link rel="stylesheet"> files. */
  const styleNodes = [];
  for (const node of Array.from(templateDoc.querySelectorAll('style'))) {
    styleNodes.push(el('style', { html: node.textContent }));
    node.remove();
  }
  for (const node of Array.from(templateDoc.querySelectorAll('link[rel~="stylesheet"]'))) {
    const href = node.getAttribute('href');
    node.remove();
    if (!href || isExternalUrl(href)) continue;
    try {
      const css = await readTextAt(State.rootHandle, resolveRelative(templateDir, href));
      styleNodes.push(el('style', { html: css }));
    } catch (error) {
      console.warn(`[localnotes] template stylesheet missing: ${href}`, error);
    }
  }
  if (templateDoc.head) {
    for (const node of Array.from(templateDoc.head.querySelectorAll('style'))) {
      styleNodes.push(el('style', { html: node.textContent }));
    }
  }

  if (templateDoc.body.hasAttribute('data-fullbleed')) pane.classList.add('is-fullbleed');

  for (const style of styleNodes) pane.append(style);

  const mount = el('div', { class: 'template-root' });
  mount.innerHTML = templateDoc.body.innerHTML;
  /* Re-run the asset pass on the live nodes: innerHTML round-trips blob URLs. */
  pane.append(mount);

  /* --- lifecycle hooks -------------------------------------------------- */
  const workspace = {
    root: mount,
    pane,
    document: mount.ownerDocument,
    note: {
      path: note.path,
      dir: note.dir,
      name: note.name,
      title: note.meta.title,
      tags: note.meta.tags.slice(),
      created: note.meta.created,
      modified: note.meta.modified,
      template: templateName,
      html: contentHtml
    },
    tokens,
    workspaceName: State.rootName,
    resolveAsset: (reference) => assetBlobUrl(resolveRelative(note.dir, reference)),
    readTemplateFile: (reference) => readTextAt(State.rootHandle, resolveRelative(templateDir, reference)),
    query: (sql, params = []) => runSql(sql, params),
    notes: () => State.notes.map((n) => ({
      path: n.path, title: n.title, tags: n.tags.slice(),
      created: n.created, modified: n.modified, template: n.template
    }))
  };

  for (const script of scripts) {
    try {
      let code = script.code;
      if (script.src && !isExternalUrl(script.src)) {
        code = await readTextAt(State.rootHandle, resolveRelative(templateDir, script.src));
      } else if (script.src) {
        console.warn('[localnotes] refusing to load remote template script', script.src);
        continue;
      }
      if (!code.trim()) continue;

      if (script.type === 'module') {
        const url = await buildModuleBlob(code, templateDir);
        const module = await import(/* @vite-ignore */ url);
        for (const hook of ['initTemplate', 'default', 'onRender', 'render', 'mount']) {
          if (typeof module[hook] === 'function') {
            await module[hook](workspace);
            break;
          }
        }
      } else {
        /* Classic scripts run scoped, with the workspace handed in. */
        const runner = new Function('workspace', 'root', 'note', `"use strict";\n${code}`);
        const result = runner(workspace, mount, workspace.note);
        if (typeof result === 'function') await result(workspace);
        if (typeof window.initTemplate === 'function') {
          await window.initTemplate(workspace);
          delete window.initTemplate;
        }
      }
    } catch (error) {
      console.error('[localnotes] template script error', error);
      pane.prepend(el('div', { class: 'preview-error', text:
        `Template script error (${templateName}): ${error.message}` }));
    }
  }

  mount.dispatchEvent(new CustomEvent('localnotes:render', { detail: workspace, bubbles: true }));
}

async function injectDefaultLayout(pane) {
  try {
    const css = await readTextAt(State.rootHandle, `${DIR_TEMPLATES}/default-layout.css`);
    pane.append(el('style', { html: css }));
  } catch (_) { /* optional file */ }
}

function renderTemplateSelect() {
  const select = UI.templateSelect;
  const currentValue = State.current ? (State.current.meta.template || 'default') : 'default';
  select.innerHTML = '';
  select.append(el('option', { value: 'default', text: 'Template: Default' }));
  for (const template of State.templates) {
    select.append(el('option', { value: template.name, text: `Template: ${template.name}` }));
  }
  if (!State.templates.some((t) => t.name === currentValue) && currentValue !== 'default') {
    select.append(el('option', { value: currentValue, text: `Template: ${currentValue} (missing)` }));
  }
  select.value = currentValue;
}

/* ===========================================================================
 * 17. VIEW MODE
 * =========================================================================*/

async function setViewMode(mode, silent = false) {
  State.viewMode = mode === 'preview' ? 'preview' : 'edit';
  const isPreview = State.viewMode === 'preview';

  UI.btnEdit.classList.toggle('active', !isPreview);
  UI.btnPreview.classList.toggle('active', isPreview);
  UI.editorPane.style.display = isPreview ? 'none' : '';
  UI.previewPane.style.display = isPreview ? '' : 'none';

  if (isPreview && State.current) {
    try {
      await renderPreview();
    } catch (error) {
      console.error('[localnotes] preview failed', error);
      UI.renderedView.innerHTML = '';
      UI.renderedView.append(el('div', { class: 'preview-error', text:
        `Preview failed: ${error.message}` }));
    }
  }
  if (!silent) persistConfig();
}

/* ===========================================================================
 * 18. NOTE CREATION / RENAMING / DELETION
 * =========================================================================*/

function noteSkeleton({ title, template, tags, created }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>${escapeHtml(title)}</title>
    <meta name="template" content="${escapeHtml(template)}">
    <meta name="tags" content="${escapeHtml(tags.join(', '))}">
    <meta name="created" content="${created}">
    <meta name="modified" content="${created}">
</head>
<body>
    <section id="content">
<h1>${escapeHtml(title)}</h1>
<p></p>
    </section>
</body>
</html>
`;
}

function folderOptions() {
  const options = [DIR_NOTES];
  const walk = (node) => {
    for (const child of node.children.values()) {
      options.push(child.path);
      walk(child);
    }
  };
  if (State.tree) walk(State.tree);
  return options;
}

function promptNewNote() {
  if (!State.mounted) {
    toast('Mount a folder first.', 'warn');
    return;
  }

  showModal({
    title: 'New note',
    build: (body) => {
      const folders = folderOptions();
      body.append(
        el('div', { class: 'field' }, [
          el('label', { for: 'nn-title', text: 'Title' }),
          el('input', { type: 'text', id: 'nn-title', value: '', placeholder: 'Project Delta Strategy' })
        ]),
        el('div', { class: 'field-row' }, [
          el('div', { class: 'field' }, [
            el('label', { for: 'nn-folder', text: 'Folder' }),
            el('select', { id: 'nn-folder' }, folders.map((path) =>
              el('option', { value: path, text: path, selected: path === State.folderFilter })))
          ]),
          el('div', { class: 'field' }, [
            el('label', { for: 'nn-template', text: 'Template' }),
            el('select', { id: 'nn-template' }, [
              el('option', { value: 'default', text: 'default' })
            ].concat(State.templates.map((t) => el('option', {
              value: t.name, text: t.name, selected: t.name === State.config.defaultTemplate
            }))))
          ])
        ]),
        el('div', { class: 'field' }, [
          el('label', { for: 'nn-tags', text: 'Tags (comma separated)' }),
          el('input', { type: 'text', id: 'nn-tags', placeholder: 'work, strategy' })
        ]),
        el('div', { class: 'field' }, [
          el('label', { for: 'nn-subfolder', text: 'New sub-folder (optional)' }),
          el('input', { type: 'text', id: 'nn-subfolder', placeholder: 'e.g. Work/Q3' }),
          el('span', { class: 'hint', text: 'Created inside the folder chosen above.' })
        ]),
        el('label', { class: 'field-check' }, [
          el('input', { type: 'checkbox', id: 'nn-bundle', checked: true }),
          'Create a note-folder bundle (Slug/Slug.html + Assets/)'
        ])
      );
    },
    actions: [
      { label: '[ Cancel ]', kind: 'secondary', onClick: (close) => close() },
      {
        label: '[ Create Note ]',
        onClick: async (close) => {
          const title = $('#nn-title').value.trim() || 'Untitled Note';
          const folder = $('#nn-folder').value || DIR_NOTES;
          const template = $('#nn-template').value || 'default';
          const tags = parseTagList($('#nn-tags').value);
          const subfolder = $('#nn-subfolder').value.trim();
          const bundle = $('#nn-bundle').checked;
          close();
          await createNote({ title, folder, template, tags, subfolder, bundle });
        }
      }
    ]
  });
}

async function createNote({ title, folder, template, tags, subfolder, bundle }) {
  try {
    const slug = slugify(title);
    let targetDir = joinPath(folder, subfolder);
    if (bundle) targetDir = joinPath(targetDir, slug);

    await getDirectory(State.rootHandle, targetDir, true);
    if (bundle) await getDirectory(State.rootHandle, joinPath(targetDir, DIR_ASSETS), true);

    let fileName = `${slug}.html`;
    let counter = 2;
    while (await pathExists(State.rootHandle, joinPath(targetDir, fileName))) {
      fileName = `${slug}-${counter}.html`;
      counter += 1;
    }

    const path = joinPath(targetDir, fileName);
    await writeTextAt(State.rootHandle, path, noteSkeleton({
      title, template, tags, created: todayISO()
    }));

    State.expanded.add(DIR_NOTES);
    for (const part of splitPath(targetDir).reduce((acc, part) => {
      acc.push(acc.length ? `${acc[acc.length - 1]}/${part}` : part);
      return acc;
    }, [])) State.expanded.add(part);

    await refreshIndex();
    await openNote(path, { force: true });
    UI.titleInput.focus();
    toast(`Created ${path}`, 'ok');
  } catch (error) {
    console.error('[localnotes] create note failed', error);
    toast(`Could not create the note: ${error.message}`, 'error');
  }
}

async function deleteCurrentNote() {
  if (!State.current) return;
  const note = State.current;
  const isBundle = basename(note.dir).toLowerCase() === stripExtension(note.name).toLowerCase() &&
    note.dir !== DIR_NOTES;

  const confirmed = await confirmModal(
    'Delete note',
    isBundle
      ? `Permanently delete the bundle folder ${note.dir}/ (including Assets) from disk?`
      : `Permanently delete ${note.path} from disk?`,
    '[ Delete Permanently ]'
  );
  if (!confirmed) return;

  try {
    await removeRecursively(State.rootHandle, isBundle ? note.dir : note.path);
    State.current = null;
    State.dirty = false;
    State.config.lastNote = '';
    if (State.editor) State.editor.setContent('');
    await refreshIndex();
    showWelcome(true);
    toast('Note deleted.', 'ok');
    persistConfig();
  } catch (error) {
    toast(`Delete failed: ${error.message}`, 'error');
  }
}

async function renameCurrentNote() {
  if (!State.current) return;
  const note = State.current;

  showModal({
    title: 'Rename note file',
    build: (body) => {
      body.append(
        el('p', { text:
          'This renames the file on disk. If the note lives in a matching bundle folder, the ' +
          'folder is renamed too (assets are copied across).' }),
        el('div', { class: 'field' }, [
          el('label', { for: 'rn-name', text: 'New file name' }),
          el('input', { type: 'text', id: 'rn-name', value: note.name }),
          el('span', { class: 'hint', text: `Current path: ${note.path}` })
        ])
      );
    },
    actions: [
      { label: '[ Cancel ]', kind: 'secondary', onClick: (close) => close() },
      {
        label: '[ Rename ]',
        onClick: async (close) => {
          let newName = $('#rn-name').value.trim();
          close();
          if (!newName || newName === note.name) return;
          if (!/\.x?html?$/i.test(newName)) newName += '.html';
          await performRename(note, newName);
        }
      }
    ]
  });
}

async function performRename(note, newName) {
  try {
    if (State.dirty) await saveCurrentNote(false);
    const text = await readTextFromHandle(note.handle);
    const isBundle = basename(note.dir).toLowerCase() === stripExtension(note.name).toLowerCase() &&
      note.dir !== DIR_NOTES;
    const newSlug = stripExtension(newName);

    let newPath;
    if (isBundle) {
      const parent = dirname(note.dir);
      const newDirPath = joinPath(parent, newSlug);
      if (await pathExists(State.rootHandle, newDirPath, 'directory')) {
        toast(`A folder named ${newSlug} already exists.`, 'error');
        return;
      }
      const sourceDir = await getDirectory(State.rootHandle, note.dir, false);
      const targetDir = await getDirectory(State.rootHandle, newDirPath, true);
      await copyDirectory(sourceDir, targetDir);
      /* Drop the old copy of the note file inside the new folder, then write it
         under the new name. */
      try { await targetDir.removeEntry(note.name); } catch (_) { /* already gone */ }
      const newFile = await targetDir.getFileHandle(newName, { create: true });
      await writeTextToHandle(newFile, text);
      await removeRecursively(State.rootHandle, note.dir);
      newPath = joinPath(newDirPath, newName);
    } else {
      newPath = joinPath(note.dir, newName);
      if (await pathExists(State.rootHandle, newPath)) {
        toast(`${newName} already exists in this folder.`, 'error');
        return;
      }
      await writeTextAt(State.rootHandle, newPath, text);
      await removeRecursively(State.rootHandle, note.path);
    }

    State.current = null;
    await refreshIndex();
    await openNote(newPath, { force: true });
    toast(`Renamed to ${newName}`, 'ok');
  } catch (error) {
    console.error('[localnotes] rename failed', error);
    toast(`Rename failed: ${error.message}`, 'error');
  }
}

/* ===========================================================================
 * 19. SAVED QUERY AUTHORING
 * =========================================================================*/

function promptNewQuery() {
  if (!State.mounted) {
    toast('Mount a folder first.', 'warn');
    return;
  }

  showModal({
    title: 'New SQL query',
    wide: true,
    build: (body) => {
      body.append(
        el('p', { html:
          'Saved as a plain <code>.sql</code> file inside <code>Queries/</code>. Available tables: ' +
          '<code>notes</code> (path, dir, title, template, tags, tags_csv, tags_key, tag_count, ' +
          'created, modified, modified_ts, age_days, size, words, excerpt, text, is_bundle, ' +
          'has_assets) and <code>note_tags</code> (path, title, tag).' }),
        el('div', { class: 'field' }, [
          el('label', { for: 'nq-name', text: 'File name' }),
          el('input', { type: 'text', id: 'nq-name', value: 'my-query.sql' })
        ]),
        el('div', { class: 'field' }, [
          el('label', { for: 'nq-sql', text: 'SQL statement' }),
          el('textarea', { id: 'nq-sql', spellcheck: 'false' },
            ['-- Notes not touched in 30 days\nSELECT *\n  FROM notes\n WHERE age_days > 30\n ORDER BY age_days DESC'])
        ]),
        el('div', { class: 'field' }, [
          el('label', { text: 'Dry run' }),
          el('button', {
            class: 'btn btn-inline btn-secondary',
            text: '[ Test statement ]',
            onClick: () => {
              const output = $('#nq-result');
              try {
                const rows = runSql($('#nq-sql').value.replace(/(^|\n)\s*--[^\n]*/g, '').replace(/;\s*$/, ''));
                output.className = 'hint';
                output.textContent = `OK — ${rows.length} row(s). ` +
                  (rows.length ? `First: ${JSON.stringify(rows[0]).slice(0, 220)}` : '');
              } catch (error) {
                output.className = 'preview-error';
                output.textContent = String(error.message || error);
              }
            }
          }),
          el('span', { class: 'hint', id: 'nq-result', text: 'Runs against the live in-memory index.' })
        ])
      );
    },
    actions: [
      { label: '[ Cancel ]', kind: 'secondary', onClick: (close) => close() },
      {
        label: '[ Save Query ]',
        onClick: async (close) => {
          let name = $('#nq-name').value.trim() || 'my-query.sql';
          if (!/\.sql$/i.test(name)) name += '.sql';
          const sql = $('#nq-sql').value;
          close();
          try {
            await writeTextAt(State.rootHandle, `${DIR_QUERIES}/${name}`, `${sql.trim()}\n`, 'text/plain');
            await loadQueries();
            renderQueries();
            toast(`Saved Queries/${name}`, 'ok');
          } catch (error) {
            toast(`Could not save the query: ${error.message}`, 'error');
          }
        }
      }
    ]
  });
}

/* ===========================================================================
 * 20. SETTINGS PANEL
 * =========================================================================*/

function openSettings() {
  showModal({
    title: 'Settings',
    wide: true,
    build: (body) => {
      const config = State.config;

      body.append(
        el('div', { class: 'settings-block' }, [
          el('h4', { text: 'Workspace' }),
          el('table', { class: 'kv-table' }, [
            el('tr', {}, [el('th', { text: 'Mounted root' }), el('td', { text: State.mounted ? `${State.rootName}/` : '(none)' })]),
            el('tr', {}, [el('th', { text: 'Config file' }), el('td', { text: `${State.rootName}/${CONFIG_FILE}` })]),
            el('tr', {}, [el('th', { text: 'Notes indexed' }), el('td', { text: String(State.notes.length) })]),
            el('tr', {}, [el('th', { text: 'Tags in universe' }), el('td', { text: String(State.tagUniverse.length) })]),
            el('tr', {}, [el('th', { text: 'Templates' }), el('td', { text: State.templates.map((t) => t.name).join(', ') || '(none)' })]),
            el('tr', {}, [el('th', { text: 'Saved queries' }), el('td', { text: State.queries.map((q) => q.name).join(', ') || '(none)' })]),
            el('tr', {}, [el('th', { text: 'Index engine' }), el('td', { text: sqlEngine() ? 'AlaSQL (transient, in-memory)' : 'JS fallback (AlaSQL missing)' })]),
            el('tr', {}, [el('th', { text: 'Editor' }), el('td', { text: State.editor ? State.editor.mode : 'not initialised' })]),
            el('tr', {}, [el('th', { text: 'Last save' }), el('td', { text: relativeTime(State.lastSavedAt) })])
          ])
        ]),

        el('div', { class: 'settings-block' }, [
          el('h4', { text: 'Layout (saved to config.json)' }),
          el('div', { class: 'field-row' }, [
            el('div', { class: 'field' }, [
              el('label', { for: 'st-sidebar', text: 'Sidebar width (px)' }),
              el('input', { type: 'number', id: 'st-sidebar', min: '240', max: '480', value: String(config.sidebarWidth) })
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 'st-results', text: 'Results width (px)' }),
              el('input', { type: 'number', id: 'st-results', min: '240', max: '560', value: String(config.resultsWidth) })
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 'st-content', text: 'Reading measure (px)' }),
              el('input', { type: 'number', id: 'st-content', min: '480', max: '1200', value: String(config.contentWidth) })
            ])
          ]),
          el('div', { class: 'field-row' }, [
            el('div', { class: 'field' }, [
              el('label', { for: 'st-accent', text: 'Accent colour' }),
              el('input', { type: 'text', id: 'st-accent', value: config.accent })
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 'st-sort', text: 'Result order' }),
              el('select', { id: 'st-sort' }, [
                ['modified-desc', 'Modified — newest first'],
                ['modified-asc', 'Modified — oldest first'],
                ['created-desc', 'Created — newest first'],
                ['title-asc', 'Title A→Z'],
                ['path-asc', 'Path A→Z'],
                ['words-desc', 'Longest first']
              ].map(([value, label]) => el('option', {
                value, text: label, selected: config.sortOrder === value
              })))
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 'st-template', text: 'Default template' }),
              el('select', { id: 'st-template' }, [el('option', { value: 'default', text: 'default' })]
                .concat(State.templates.map((t) => el('option', {
                  value: t.name, text: t.name, selected: config.defaultTemplate === t.name
                }))))
            ])
          ])
        ]),

        el('div', { class: 'settings-block' }, [
          el('h4', { text: 'Saving' }),
          el('label', { class: 'field-check' }, [
            el('input', { type: 'checkbox', id: 'st-autosave', checked: Boolean(config.autosave) }),
            'Autosave while typing'
          ]),
          el('div', { class: 'field' }, [
            el('label', { for: 'st-delay', text: 'Autosave delay (ms)' }),
            el('input', { type: 'number', id: 'st-delay', min: '400', max: '15000', step: '100', value: String(config.autosaveDelay) })
          ])
        ]),

        el('div', { class: 'settings-block' }, [
          el('h4', { text: 'Maintenance' }),
          el('div', { class: 'field-row' }, [
            el('button', { class: 'btn btn-inline btn-secondary', text: '[ Re-index workspace ]', onClick: () => refreshIndex() }),
            el('button', { class: 'btn btn-inline btn-secondary', text: '[ Reload templates ]', onClick: async () => {
              await loadTemplates();
              renderTemplateSelect();
              toast(`${State.templates.length} template(s) reloaded.`, 'ok');
            } }),
            el('button', { class: 'btn btn-inline btn-secondary', text: '[ Clear offline cache ]', onClick: () => {
              if (navigator.serviceWorker && navigator.serviceWorker.controller) {
                navigator.serviceWorker.controller.postMessage({ type: 'PURGE_CACHES' });
                toast('Offline cache purged. Reload to re-install the shell.', 'ok');
              } else {
                toast('No service worker is active.', 'warn');
              }
            } }),
            el('button', { class: 'btn btn-inline btn-danger', text: '[ Unmount folder ]', onClick: async (event) => {
              closeModal();
              await unmount();
            } })
          ]),
          el('span', { class: 'hint', text:
            'Unmounting only forgets the directory handle stored in IndexedDB. Nothing on disk is ' +
            'touched or deleted.' })
        ]),

        el('div', { class: 'settings-block' }, [
          el('h4', { text: 'Keyboard' }),
          el('table', { class: 'kv-table' }, [
            el('tr', {}, [el('th', { text: 'Ctrl/Cmd + S' }), el('td', { text: 'Save the current note' })]),
            el('tr', {}, [el('th', { text: 'Ctrl/Cmd + N' }), el('td', { text: 'New note' })]),
            el('tr', {}, [el('th', { text: 'Ctrl/Cmd + K' }), el('td', { text: 'Focus the search index' })]),
            el('tr', {}, [el('th', { text: 'Ctrl/Cmd + E' }), el('td', { text: 'Toggle editor / rendered preview' })]),
            el('tr', {}, [el('th', { text: 'Ctrl/Cmd + R' }), el('td', { text: 'Re-index the workspace' })]),
            el('tr', {}, [el('th', { text: 'Escape' }), el('td', { text: 'Close dialogs and drawers' })])
          ])
        ])
      );
    },
    actions: [
      { label: '[ Close ]', kind: 'secondary', onClick: (close) => close() },
      {
        label: '[ Apply & Save ]',
        onClick: async (close) => {
          const number = (id, fallback) => {
            const value = Number($(`#${id}`).value);
            return Number.isFinite(value) ? value : fallback;
          };
          State.config.sidebarWidth = number('st-sidebar', State.config.sidebarWidth);
          State.config.resultsWidth = number('st-results', State.config.resultsWidth);
          State.config.contentWidth = number('st-content', State.config.contentWidth);
          const accent = $('#st-accent').value.trim();
          if (/^#[0-9a-f]{3,8}$/i.test(accent)) State.config.accent = accent;
          State.config.sortOrder = $('#st-sort').value;
          State.config.defaultTemplate = $('#st-template').value;
          State.config.autosave = $('#st-autosave').checked;
          State.config.autosaveDelay = number('st-delay', 1500);
          close();
          applyConfig();
          refreshResults();
          persistConfig.flush();
          toast('Settings written to config.json.', 'ok');
        }
      }
    ]
  });
}

/* ===========================================================================
 * 21. COLUMN RESIZERS + MOBILE CHROME
 * =========================================================================*/

function installResizers() {
  const makeResizer = (className, getWidth, setWidth) => {
    const handle = el('div', { class: `col-resizer ${className}`, role: 'separator', 'aria-orientation': 'vertical' });
    let startX = 0;
    let startWidth = 0;

    const onMove = (event) => {
      const delta = event.clientX - startX;
      setWidth(startWidth + delta);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('is-resizing');
      handle.classList.remove('is-dragging');
      persistConfig();
    };
    handle.addEventListener('mousedown', (event) => {
      event.preventDefault();
      startX = event.clientX;
      startWidth = getWidth();
      document.body.classList.add('is-resizing');
      handle.classList.add('is-dragging');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    handle.addEventListener('dblclick', () => setWidth(className === 'for-sidebar' ? 280 : 330));
    return handle;
  };

  const sidebarResizer = makeResizer('for-sidebar',
    () => UI.sidebar.getBoundingClientRect().width,
    (width) => {
      const clamped = Math.max(240, Math.min(480, Math.round(width)));
      State.config.sidebarWidth = clamped;
      document.documentElement.style.setProperty('--sidebar-w', `${clamped}px`);
    });

  const resultsResizer = makeResizer('for-results',
    () => UI.results.getBoundingClientRect().width,
    (width) => {
      const clamped = Math.max(240, Math.min(560, Math.round(width)));
      State.config.resultsWidth = clamped;
      document.documentElement.style.setProperty('--results-w', `${clamped}px`);
    });

  UI.container.insertBefore(sidebarResizer, UI.results);
  UI.container.insertBefore(resultsResizer, UI.workspace);
}

function installMobileChrome() {
  const navToggle = el('button', {
    class: 'btn-icon mobile-only',
    id: 'btn-nav-toggle',
    title: 'Toggle navigation',
    text: '☰',
    onClick: () => {
      document.body.classList.toggle('nav-open');
      document.body.classList.remove('results-open');
    }
  });
  const resultsToggle = el('button', {
    class: 'btn-icon mobile-only',
    id: 'btn-results-toggle',
    title: 'Toggle the index queue',
    text: '⛁',
    onClick: () => {
      document.body.classList.toggle('results-open');
      document.body.classList.remove('nav-open');
    }
  });

  const header = $('.workspace-header');
  header.prepend(resultsToggle);
  header.prepend(navToggle);

  /* The welcome screen needs the toggles too. */
  const floating = el('div', {
    class: 'mobile-only',
    style: 'position:absolute;top:10px;left:10px;z-index:30;display:flex;gap:4px;'
  }, [
    el('button', { class: 'btn-icon', text: '☰', title: 'Toggle navigation', onClick: () => document.body.classList.toggle('nav-open') })
  ]);
  UI.workspace.prepend(floating);

  UI.resultsList.addEventListener('click', () => document.body.classList.remove('results-open'));
  UI.fileTree.addEventListener('click', (event) => {
    if (event.target.closest('.tree-file')) document.body.classList.remove('nav-open');
  });
}

/* ===========================================================================
 * 22. EVENT WIRING
 * =========================================================================*/

function wireEvents() {
  UI.btnMount.addEventListener('click', () => pickDirectory());
  if (UI.btnWelcomeMount) UI.btnWelcomeMount.addEventListener('click', () => pickDirectory());
  UI.btnNewNote.addEventListener('click', () => promptNewNote());
  UI.btnNewQuery.addEventListener('click', () => promptNewQuery());
  UI.btnSettings.addEventListener('click', () => openSettings());

  UI.btnClearTags.addEventListener('click', () => {
    State.selectedTags.clear();
    refreshResults();
    persistConfig();
  });

  const onSearch = debounce(() => {
    State.searchText = UI.searchInput.value;
    refreshResults();
  }, 180);
  UI.searchInput.addEventListener('input', onSearch);
  UI.searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      UI.searchInput.value = '';
      State.searchText = '';
      refreshResults();
    }
  });

  UI.btnEdit.addEventListener('click', () => setViewMode('edit'));
  UI.btnPreview.addEventListener('click', () => setViewMode('preview'));

  UI.titleInput.addEventListener('input', () => {
    if (!State.current) return;
    State.current.meta.title = UI.titleInput.value;
    markDirty();
    autosaveWithDelay(Math.max(600, Number(State.config.autosaveDelay) || 1500));
  });

  UI.tagsInput.addEventListener('input', () => {
    if (!State.current) return;
    State.current.meta.tags = parseTagList(UI.tagsInput.value);
    markDirty();
    autosaveWithDelay(Math.max(600, Number(State.config.autosaveDelay) || 1500));
  });

  UI.templateSelect.addEventListener('change', async () => {
    if (!State.current) return;
    State.current.meta.template = UI.templateSelect.value;
    markDirty();
    if (State.viewMode === 'preview') await renderPreview();
    autosaveWithDelay(400);
  });

  /* Note actions live in the metadata bar so the header stays quiet. */
  const actions = el('span', { class: 'meta-actions' }, [
    el('button', { class: 'btn-text', text: '[ Save ]', title: 'Ctrl/Cmd + S', onClick: () => saveCurrentNote(true) }),
    el('button', { class: 'btn-text', text: '[ Rename ]', onClick: () => renameCurrentNote() }),
    el('button', { class: 'btn-text', text: '[ Delete ]', onClick: () => deleteCurrentNote() })
  ]);
  UI.metaBar.append(actions);

  document.addEventListener('keydown', (event) => {
    const meta = event.ctrlKey || event.metaKey;
    if (event.key === 'Escape') {
      if (openModal) closeModal();
      document.body.classList.remove('nav-open', 'results-open');
      return;
    }
    if (!meta) return;
    const key = event.key.toLowerCase();
    if (key === 's') { event.preventDefault(); saveCurrentNote(true); }
    else if (key === 'n') { event.preventDefault(); promptNewNote(); }
    else if (key === 'k') { event.preventDefault(); UI.searchInput.focus(); UI.searchInput.select(); }
    else if (key === 'e') {
      event.preventDefault();
      setViewMode(State.viewMode === 'edit' ? 'preview' : 'edit');
    } else if (key === 'r' && event.shiftKey) { event.preventDefault(); refreshIndex(); }
  });

  window.addEventListener('beforeunload', (event) => {
    if (!State.dirty) return;
    event.preventDefault();
    event.returnValue = 'You have unsaved changes in the current note.';
    return event.returnValue;
  });

  /* Flush pending work when the tab is hidden — cheap insurance. */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && State.dirty && State.config.autosave) {
      saveCurrentNote(false);
    }
  });
}

/* ===========================================================================
 * 23. STARTER FILE CONTENT (written on first mount)
 * =========================================================================*/

const STARTER_DEFAULT_LAYOUT_CSS = `/* default-layout.css — applied when a note has no template. */
.note-default-header { border-bottom: 1px solid #E6E6E2; margin-bottom: 28px; padding-bottom: 14px; }
.note-default-header h1 { font-family: Georgia, serif; font-size: 32px; font-weight: 600; margin: 0; }
.note-default-tags { font-family: ui-monospace, Menlo, monospace; font-size: 12px; color: #7A756D; margin-top: 8px; }
`;

const STARTER_STALE_QUERY = `-- stale-notes.sql
-- Notes that have not been modified in the last 30 days.
-- Clicking this file suspends the folder/tag GUI filters entirely.
SELECT *
  FROM notes
 WHERE age_days > 30
 ORDER BY age_days DESC, path ASC
`;

/* ===========================================================================
 * 24. BOOTSTRAP
 * =========================================================================*/

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' &&
    location.hostname !== '127.0.0.1') return;
  try {
    await navigator.serviceWorker.register('./sw.js', { scope: './' });
  } catch (error) {
    console.warn('[localnotes] service worker registration failed', error);
  }
}

async function boot() {
  cacheDom();
  wireEvents();
  installResizers();
  installMobileChrome();
  setSaveStatus('All changes saved', 'saved');
  registerServiceWorker();

  /* Paint the remembered layout before anything async happens. */
  try {
    const mirrored = await get(IDB_CONFIG_KEY);
    if (mirrored && typeof mirrored === 'object') {
      State.config = { ...DEFAULT_CONFIG, ...mirrored };
      applyConfig();
    }
  } catch (_) { /* first run */ }

  if (!State.supported) {
    renderUnsupported();
    renderAll();
    return;
  }

  let handle = null;
  try {
    handle = await get(IDB_HANDLE_KEY);
  } catch (error) {
    console.warn('[localnotes] could not read the cached directory handle', error);
  }

  if (!handle) {
    showWelcome(false);
    renderAll();
    setStatus('● Folder Unmounted', 'disconnected');
    return;
  }

  const state = await permissionState(handle, 'readwrite');
  if (state === 'granted') {
    await mountRoot(handle);
  } else if (state === 'prompt') {
    renderAll();
    showUnlockState(handle);
  } else {
    await del(IDB_HANDLE_KEY);
    renderAll();
    showWelcome(false, 'Permission for the previously mounted folder was revoked by the browser.');
    setStatus('● Permission denied', 'error');
  }
}

/* Expose a tiny debug surface — handy in the console, harmless in production. */
window.LocalNotes = {
  state: State,
  refreshIndex,
  sql: (statement, params = []) => runSql(statement, params),
  save: () => saveCurrentNote(true),
  open: (path) => openNote(path),
  sanitize: sanitizeEditorHtml
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
