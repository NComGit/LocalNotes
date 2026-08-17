/* ============================================================================
 * LocalNotes Manager — src/note-actions.js
 * ==========================================================================*/

import { BANNED_ATTRIBUTES, UNWRAP_TAGS, DROP_TAGS, DIR_ASSETS, DIR_NOTES } from './constants.js';
import { State, UI } from './state.js';
import { getFileHandleAt, readTextFromHandle, getDirectory, writeTextToHandle, writeTextAt, pathExists, removeRecursively, copyDirectory } from './fs.js';
import { parseNoteDocument, buildNoteRecord, buildTree, scanWorkspace } from './traversal.js';
import { ensureEditor } from './editor.js';
import { persistConfig } from './config.js';
import { rebuildIndex } from './index-engine.js';
import { renderTemplateSelect, renderPreview } from './templates.js';
import { renderTree, renderResults, renderAll } from './ui/render.js';
import { showEditor, showWelcome, setSaveStatus, setStatus } from './ui/workspace.js';
import { toast, confirmModal, showModal } from './ui/toast.js';
import { dirname, basename, stripExtension, todayISO, escapeHtml, parseTagList, slugify, joinPath, splitPath, el, $ } from './utils.js';

const domParser = new DOMParser();

export async function openNote(path, { force = false } = {}) {
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

export function updateMetaStat() {
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

export function markDirty() {
  if (State.dirty) return;
  State.dirty = true;
  setSaveStatus('Unsaved changes…', 'dirty');
  const activeRow = $('.tree-node.is-active', UI.fileTree);
  if (activeRow) activeRow.classList.add('is-dirty');
}

export function markClean() {
  State.dirty = false;
  State.lastSavedAt = Date.now();
  setSaveStatus('All changes saved', 'saved');
  const activeRow = $('.tree-node.is-active', UI.fileTree);
  if (activeRow) activeRow.classList.remove('is-dirty');
}

export function handleEditorChange() {
  if (!State.current) return;
  markDirty();
  updateMetaStat();
  if (State.config.autosave) {
    autosaveWithDelay(Math.max(400, Number(State.config.autosaveDelay) || 1500));
  }
}

let autosaveTimer = 0;
export function autosaveWithDelay(delay) {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    if (State.config.autosave && State.dirty && !State.saving) saveCurrentNote(false);
  }, delay);
}

/**
 * Recursively purge every trace of presentation and editor bookkeeping from raw
 * editor output. Returns clean, standards-only HTML.
 */
export function sanitizeEditorHtml(rawHtml) {
  const doc = domParser.parseFromString(
    `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${rawHtml || ''}</body></html>`,
    'text/html'
  );

  const unwrap = (element) => {
    const parent = element.parentNode;
    if (!parent) return;
    while (element.firstChild) parent.insertBefore(element.firstChild, element);
    parent.removeChild(element);
  };

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
          (name === 'srcset' && !attribute.value.trim())) {
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
export function tidyHtml(html) {
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
export function serializeNoteDocument(cleanContent) {
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

export async function saveCurrentNote(explicit = true) {
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

export async function refreshNoteRecord(path) {
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
    renderResults();
    renderTree();
  } catch (error) {
    console.warn('[localnotes] could not refresh index row', error);
  }
}

export async function refreshIndex() {
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

export function noteSkeleton({ title, template, tags, created }) {
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

export function folderOptions() {
  const options = [{ path: '', label: `[Root Folder] (${State.rootName || 'Workspace'})` }];
  const walk = (node) => {
    for (const child of node.children.values()) {
      if (child.path) options.push({ path: child.path, label: `${child.path}/` });
      walk(child);
    }
  };
  if (State.tree) walk(State.tree);
  return options;
}

export function promptNewNote() {
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
            el('select', { id: 'nn-folder' }, folders.map(({ path, label }) =>
              el('option', { value: path, text: label, selected: path === State.folderFilter })))
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
          const folder = $('#nn-folder').value || '';
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

export async function createNote({ title, folder, template, tags, subfolder, bundle }) {
  try {
    const slug = slugify(title);
    let targetDir = joinPath(folder, subfolder);
    if (bundle) targetDir = joinPath(targetDir, slug);

    if (targetDir) await getDirectory(State.rootHandle, targetDir, true);
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

    State.expanded.add('');
    if (targetDir) {
      for (const part of splitPath(targetDir).reduce((acc, part) => {
        acc.push(acc.length ? `${acc[acc.length - 1]}/${part}` : part);
        return acc;
      }, [])) State.expanded.add(part);
    }

    await refreshIndex();
    await openNote(path, { force: true });
    UI.titleInput.focus();
    toast(`Created ${path}`, 'ok');
  } catch (error) {
    console.error('[localnotes] create note failed', error);
    toast(`Could not create the note: ${error.message}`, 'error');
  }
}

export async function deleteCurrentNote() {
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

export async function renameCurrentNote() {
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

export async function performRename(note, newName) {
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
