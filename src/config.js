/* ============================================================================
 * LocalNotes Manager — src/config.js
 * ==========================================================================*/

import { DEFAULT_CONFIG, CONFIG_FILE, IDB_CONFIG_KEY } from './constants.js';
import { State } from './state.js';
import { debounce } from './utils.js';
import { readTextAt, writeTextAt } from './fs.js';
import { set } from '../lib/idb-keyval.js';

export async function loadConfig() {
  let loaded = {};
  try {
    loaded = JSON.parse(await readTextAt(State.rootHandle, CONFIG_FILE));
  } catch (error) {
    console.warn('[localnotes] config.json unreadable, using defaults', error);
  }
  State.config = { ...DEFAULT_CONFIG, ...(loaded && typeof loaded === 'object' ? loaded : {}) };
  State.folderFilter = State.config.activeFolder !== undefined ? State.config.activeFolder : '';
  State.selectedTags = new Set(Array.isArray(State.config.selectedTags) ? State.config.selectedTags : []);
  State.expanded = new Set(Array.isArray(State.config.expandedFolders) && State.config.expandedFolders.length
    ? State.config.expandedFolders
    : ['']);
  State.viewMode = State.config.viewMode === 'preview' ? 'preview' : 'edit';
  await set(IDB_CONFIG_KEY, State.config);
}

export function applyConfig() {
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
}

export const persistConfig = debounce(async () => {
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
