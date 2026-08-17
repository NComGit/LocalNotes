/* ============================================================================
 * LocalNotes Manager — src/ui/render.js
 * ==========================================================================*/

import { State, UI } from '../state.js';
import { el, $ } from '../utils.js';
import { removeRecursively } from '../fs.js';
import { persistConfig } from '../config.js';
import { refreshResults, activateQuery, releaseQuery } from '../search.js';
import { openNote } from '../note-actions.js';
import { renderTemplateSelect } from '../templates.js';
import { toast, confirmModal } from './toast.js';

export function renderAll() {
  renderTree();
  renderTags();
  renderQueries();
  renderTemplateSelect();
  refreshResults();
  UI.btnMount.textContent = State.mounted ? '[ Change Folder ]' : '[ Mount Folder ]';
}

export function renderTree() {
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

export function folderRow(node, depth, suspended) {
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

export function noteRow(note, depth) {
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

export function toggleFolder(path) {
  if (State.expanded.has(path)) State.expanded.delete(path);
  else State.expanded.add(path);
  renderTree();
  persistConfig();
}

export function renderTags() {
  const container = UI.tagsList;
  container.innerHTML = '';
  const suspended = Boolean(State.activeQuery);
  container.classList.toggle('is-suspended', suspended);

  if (!State.tagUniverse.length) {
    container.append(el('div', { class: 'list-empty', text: State.mounted ? 'No tags found.' : '—' }));
    UI.btnClearTags.style.display = 'none';
    return;
  }

  const activeSet = State.results;
  const counts = new Map();
  for (const note of activeSet) {
    for (const tag of note.tags) {
      const key = tag.toLowerCase();
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }

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

export function toggleTag(tag) {
  const key = tag.toLowerCase();
  const existing = Array.from(State.selectedTags).find((t) => t.toLowerCase() === key);
  if (existing) State.selectedTags.delete(existing);
  else State.selectedTags.add(tag);
  refreshResults();
  persistConfig();
}

export function renderQueries() {
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

export function renderResults(errorMessage) {
  const list = UI.resultsList;
  list.innerHTML = '';

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
      '<code>&' + 'lt;meta&' + 'gt;</code> header.' }));
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
