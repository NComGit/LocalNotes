/* ============================================================================
 * LocalNotes Manager — src/traversal.js
 * ==========================================================================*/

import { MAX_SCAN_DEPTH, EXCERPT_LENGTH, DIR_TEMPLATES, DIR_QUERIES, DIR_ASSETS } from './constants.js';
import { State } from './state.js';
import { parseTagList, tagKey, dirname, basename, stripExtension, splitPath } from './utils.js';
import { dirEntries, getDirectory } from './fs.js';
import { rebuildIndex } from './index-engine.js';

const domParser = new DOMParser();

export function parseNoteDocument(text) {
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

export async function scanWorkspace() {
  if (State.scanning) return;
  State.scanning = true;
  const started = performance.now();

  try {
    const notes = [];
    /* Recursively scan from the root handle to discover all notes */
    await walkNotes(State.rootHandle, '', notes, 0);

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

export async function walkNotes(dirHandle, path, output, depth) {
  if (depth > MAX_SCAN_DEPTH) return;
  for (const [name, handle] of await dirEntries(dirHandle)) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    if (handle.kind === 'directory') {
      /* Skip reserved system folders */
      if (name === DIR_TEMPLATES || name === DIR_QUERIES || name === DIR_ASSETS) continue;
      const subPath = path ? `${path}/${name}` : name;
      await walkNotes(handle, subPath, output, depth + 1);
      continue;
    }
    if (!/\.x?html?$/i.test(name)) continue;
    try {
      const filePath = path ? `${path}/${name}` : name;
      const record = await buildNoteRecord(handle, dirHandle, filePath);
      output.push(record);
    } catch (error) {
      console.warn(`[localnotes] failed to parse ${path ? `${path}/${name}` : name}`, error);
    }
  }
}

export async function buildNoteRecord(fileHandle, parentDir, path) {
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
    is_bundle: dir !== '' && basename(dir).toLowerCase() === stripExtension(name).toLowerCase(),
    has_assets: hasAssets
  };
}

export function buildTree(notes) {
  const rootLabel = State.rootName || 'Workspace';
  const root = { name: rootLabel, path: '', kind: 'folder', children: new Map(), notes: [], count: 0 };

  for (const note of notes) {
    const parts = splitPath(note.dir);
    let node = root;
    for (let i = 0; i < parts.length; i += 1) {
      const segment = parts[i];
      if (!node.children.has(segment)) {
        node.children.set(segment, {
          name: segment,
          path: node.path ? `${node.path}/${segment}` : segment,
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

export async function loadTemplates() {
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

export async function loadQueries() {
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
