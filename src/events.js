/* ============================================================================
 * LocalNotes Manager — src/events.js
 * ==========================================================================*/

import { State, UI } from './state.js';
import { debounce, parseTagList, el } from './utils.js';
import { pickDirectory } from './mounting.js';
import { promptNewNote, saveCurrentNote, renameCurrentNote, deleteCurrentNote, refreshIndex, markDirty, autosaveWithDelay } from './note-actions.js';
import { promptNewQuery, openSettings } from './settings.js';
import { refreshResults } from './search.js';
import { persistConfig } from './config.js';
import { setViewMode } from './ui/workspace.js';
import { closeModal, openModal } from './ui/toast.js';
import { renderPreview } from './templates.js';

export function wireEvents() {
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
