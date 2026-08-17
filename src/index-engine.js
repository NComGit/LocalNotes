/* ============================================================================
 * LocalNotes Manager — src/index-engine.js
 * ==========================================================================*/

export function sqlEngine() {
  return typeof window.alasql === 'function' ? window.alasql : null;
}

export function destroyIndex() {
  const alasql = sqlEngine();
  if (!alasql) return;
  try {
    alasql('DROP TABLE IF EXISTS notes');
    alasql('DROP TABLE IF EXISTS note_tags');
  } catch (_) { /* nothing to drop */ }
}

export function rebuildIndex(notes) {
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

export function runSql(sql, params = []) {
  const alasql = sqlEngine();
  if (!alasql) throw new Error('AlaSQL is not loaded (lib/alasql.js missing).');
  const result = alasql(sql, params);
  return Array.isArray(result) ? result : (result === undefined ? [] : [result]);
}
