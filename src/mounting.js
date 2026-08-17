/* ============================================================================
 * LocalNotes Manager — src/mounting.js
 * ==========================================================================*/

import { IDB_HANDLE_KEY, IDB_NAME_KEY, DIR_TEMPLATES, DIR_QUERIES, CONFIG_FILE, DEFAULT_CONFIG, STARTER_DEFAULT_LAYOUT_CSS, STARTER_STALE_QUERY } from './constants.js';
import { State } from './state.js';
import { set, del } from '../lib/idb-keyval.js';
import { getDirectory, pathExists, writeTextAt } from './fs.js';
import { loadConfig, applyConfig } from './config.js';
import { scanWorkspace } from './traversal.js';
import { releaseBlobUrls } from './templates.js';
import { destroyIndex } from './index-engine.js';
import { toast, confirmModal } from './ui/toast.js';
import { renderAll } from './ui/render.js';
import { showWelcome, renderUnsupported, setStatus } from './ui/workspace.js';
import { openNote, promptNewNote } from './note-actions.js';

export async function permissionState(handle, mode = 'readwrite') {
  if (!handle || typeof handle.queryPermission !== 'function') return 'granted';
  try {
    return await handle.queryPermission({ mode });
  } catch (_) {
    return 'prompt';
  }
}

export async function askPermission(handle, mode = 'readwrite') {
  if (!handle || typeof handle.requestPermission !== 'function') return 'granted';
  try {
    return await handle.requestPermission({ mode });
  } catch (error) {
    console.warn('[localnotes] permission request failed', error);
    return 'denied';
  }
}

export async function pickDirectory() {
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

export async function unmount() {
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

export async function mountRoot(handle) {
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
export async function ensureWorkspaceSkeleton() {
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
