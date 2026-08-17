/* ============================================================================
 * LocalNotes Manager — src/search.js
 * ==========================================================================*/

import { State, UI } from './state.js';
import { readTextFromHandle } from './fs.js';
import { sqlEngine, runSql } from './index-engine.js';
import { toast } from './ui/toast.js';
import { renderResults, renderQueries, renderTags, renderTree } from './ui/render.js';

export function parseSearch(input) {
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

export function orderByClause() {
  switch (State.config.sortOrder) {
    case 'modified-asc': return 'modified_ts ASC, path ASC';
    case 'created-desc': return 'created DESC, path ASC';
    case 'title-asc': return 'title_lc ASC';
    case 'path-asc': return 'path ASC';
    case 'words-desc': return 'words DESC, path ASC';
    default: return 'modified_ts DESC, path ASC';
  }
}

export function computeActiveSet() {
  const facets = parseSearch(State.searchText);
  const where = [];
  const params = [];

  const folder = State.folderFilter;
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

export function jsFallbackFilter(facets, folder) {
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

export async function activateQuery(query) {
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

export function releaseQuery() {
  State.activeQuery = null;
  State.rawRows = null;
  UI.searchInput.disabled = false;
  UI.searchInput.title = '';
  refreshResults();
  renderQueries();
  renderTags();
  renderTree();
}

export function runActiveQuery() {
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

export function refreshResults() {
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
