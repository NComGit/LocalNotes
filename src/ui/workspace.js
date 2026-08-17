/* ============================================================================
 * LocalNotes Manager — src/ui/workspace.js
 * ==========================================================================*/

import { State, UI } from '../state.js';
import { el, $ } from '../utils.js';
import { persistConfig } from '../config.js';
import { askPermission, pickDirectory, mountRoot } from '../mounting.js';
import { promptNewNote } from '../note-actions.js';
import { renderPreview } from '../templates.js';

export function setStatus(text, kind) {
  if (!UI.statusBadge) return;
  UI.statusBadge.textContent = text;
  UI.statusBadge.className = `badge badge-${kind}`;
}

export function renderUnsupported() {
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

export function showWelcome(mounted = false, errorMessage = '') {
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
export function showUnlockState(handle) {
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

export function showEditor() {
  UI.emptyState.style.display = 'none';
  UI.activeState.style.display = '';
}

export function setSaveStatus(text, kind = 'saved') {
  UI.saveStatus.textContent = text;
  UI.saveStatus.className = `mono-label is-${kind}`;
}

export async function setViewMode(mode, silent = false) {
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

export function installResizers() {
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

export function installMobileChrome() {
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
