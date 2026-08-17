/* ============================================================================
 * LocalNotes Manager — app.js
 * ----------------------------------------------------------------------------
 * Local-first HTML note manager. Main orchestrator module.
 *
 * Zero network calls. Zero telemetry. Zero cloud.
 * ==========================================================================*/

import { IDB_HANDLE_KEY, IDB_CONFIG_KEY, DEFAULT_CONFIG } from './src/constants.js';
import { State, cacheDom } from './src/state.js';
import { get, del } from './lib/idb-keyval.js';
import { applyConfig } from './src/config.js';
import { permissionState, mountRoot } from './src/mounting.js';
import { renderAll } from './src/ui/render.js';
import { showWelcome, showUnlockState, renderUnsupported, setSaveStatus, setStatus, installResizers, installMobileChrome } from './src/ui/workspace.js';
import { wireEvents } from './src/events.js';
import { refreshIndex, saveCurrentNote, openNote, sanitizeEditorHtml } from './src/note-actions.js';
import { runSql } from './src/index-engine.js';

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
