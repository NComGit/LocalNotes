/* ============================================================================
 * LocalNotes Manager — src/templates.js
 * ==========================================================================*/

import { MODULE_IMPORT_DEPTH, DIR_TEMPLATES } from './constants.js';
import { State, UI } from './state.js';
import { getFileHandleAt, readTextAt, readTextFromHandle } from './fs.js';
import { isExternalUrl, resolveRelative, basename, dirname, el } from './utils.js';
import { sanitizeEditorHtml } from './note-actions.js';
import { runSql } from './index-engine.js';

const domParser = new DOMParser();

export function releaseBlobUrls() {
  for (const url of State.blobUrls) URL.revokeObjectURL(url);
  for (const url of State.moduleUrls) URL.revokeObjectURL(url);
  State.blobUrls = [];
  State.moduleUrls = [];
  State.assetCache.clear();
}

export function trackBlob(url, kind = 'asset') {
  if (kind === 'module') State.moduleUrls.push(url);
  else State.blobUrls.push(url);
  return url;
}

/** Read a local file and hand back a Blob URL the browser can render. */
export async function assetBlobUrl(absolutePath) {
  if (State.assetCache.has(absolutePath)) return State.assetCache.get(absolutePath);
  const handle = await getFileHandleAt(State.rootHandle, absolutePath, false);
  const file = await handle.getFile();
  const url = trackBlob(URL.createObjectURL(file));
  State.assetCache.set(absolutePath, url);
  return url;
}

export const ASSET_ATTRIBUTES = [
  ['img', 'src'], ['img', 'poster'], ['source', 'src'], ['video', 'src'],
  ['video', 'poster'], ['audio', 'src'], ['track', 'src'], ['embed', 'src'],
  ['object', 'data'], ['a', 'href'], ['iframe', 'src'], ['input', 'src']
];

/**
 * Swap every relative asset reference inside `container` for a Blob URL read
 * straight off the hard drive. Base is the note's own directory, so
 * ./Assets/architecture.png resolves inside the note bundle.
 */
export async function resolveAssets(container, baseDir) {
  const jobs = [];

  for (const [tag, attribute] of ASSET_ATTRIBUTES) {
    for (const node of Array.from(container.querySelectorAll(tag))) {
      const value = node.getAttribute(attribute);
      if (!value || isExternalUrl(value)) continue;
      const target = resolveRelative(baseDir, value);
      jobs.push(assetBlobUrl(target)
        .then((url) => {
          node.setAttribute(attribute, url);
          if (tag === 'a') {
            node.setAttribute('target', '_blank');
            node.setAttribute('rel', 'noopener');
            node.setAttribute('download', basename(target));
          }
        })
        .catch((error) => {
          console.warn(`[localnotes] missing asset ${target}`, error);
          if (tag === 'img') {
            node.replaceWith(el('span', {
              class: 'preview-error',
              text: `Missing asset: ${value}`
            }));
          }
        }));
    }
  }

  /* srcset support */
  for (const node of Array.from(container.querySelectorAll('img[srcset], source[srcset]'))) {
    const parts = node.getAttribute('srcset').split(',').map((entry) => entry.trim()).filter(Boolean);
    jobs.push(Promise.all(parts.map(async (entry) => {
      const [url, descriptor = ''] = entry.split(/\s+/);
      if (!url || isExternalUrl(url)) return entry;
      try {
        const blob = await assetBlobUrl(resolveRelative(baseDir, url));
        return `${blob} ${descriptor}`.trim();
      } catch (_) { return entry; }
    })).then((resolved) => node.setAttribute('srcset', resolved.join(', '))));
  }

  /* url(...) inside inline styles and <style> blocks */
  const rewriteCssUrls = async (css) => {
    const matches = Array.from(css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi));
    let output = css;
    for (const match of matches) {
      const reference = match[2];
      if (isExternalUrl(reference)) continue;
      try {
        const blob = await assetBlobUrl(resolveRelative(baseDir, reference));
        output = output.split(match[0]).join(`url("${blob}")`);
      } catch (_) { /* leave as-is */ }
    }
    return output;
  };

  for (const node of Array.from(container.querySelectorAll('[style*="url("]'))) {
    jobs.push(rewriteCssUrls(node.getAttribute('style'))
      .then((css) => node.setAttribute('style', css)));
  }
  for (const node of Array.from(container.querySelectorAll('style'))) {
    if (!/url\(/i.test(node.textContent)) continue;
    jobs.push(rewriteCssUrls(node.textContent).then((css) => { node.textContent = css; }));
  }

  await Promise.all(jobs);
  return container;
}

/**
 * Compile a template module into a Blob URL, recursively inlining its own
 * relative imports so that ES module graphs still work from a blob origin.
 */
export async function buildModuleBlob(code, baseDir, depth = 0, seen = new Map()) {
  let source = code;

  if (depth < MODULE_IMPORT_DEPTH) {
    const importPattern = /(from\s*|import\s*|import\(\s*)(['"])(\.{1,2}\/[^'"]+)\2/g;
    const replacements = [];
    let match;
    while ((match = importPattern.exec(code)) !== null) {
      replacements.push({ full: match[0], prefix: match[1], quote: match[2], path: match[3] });
    }
    for (const replacement of replacements) {
      const target = resolveRelative(baseDir, replacement.path);
      try {
        let url = seen.get(target);
        if (!url) {
          const text = await readTextAt(State.rootHandle, target);
          url = await buildModuleBlob(text, dirname(target), depth + 1, seen);
          seen.set(target, url);
        }
        source = source.split(replacement.full)
          .join(`${replacement.prefix}${replacement.quote}${url}${replacement.quote}`);
      } catch (error) {
        console.warn(`[localnotes] template module import unresolved: ${target}`, error);
      }
    }
  }

  const blob = new Blob([source], { type: 'text/javascript' });
  return trackBlob(URL.createObjectURL(blob), 'module');
}

export function substituteTokens(root, values) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  const pattern = /\{\{\s*([a-z0-9_.-]+)\s*\}\}/gi;
  const replace = (input) => input.replace(pattern, (whole, key) => {
    const value = values[key.toLowerCase()];
    return value === undefined ? whole : String(value);
  });

  let node = walker.currentNode;
  while (node) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (pattern.test(node.nodeValue)) node.nodeValue = replace(node.nodeValue);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      for (const attribute of Array.from(node.attributes || [])) {
        if (attribute.value.includes('{{')) {
          node.setAttribute(attribute.name, replace(attribute.value));
        }
      }
    }
    node = walker.nextNode();
  }
}

export async function renderPreview() {
  const pane = UI.renderedView;
  if (!State.current) {
    pane.innerHTML = '';
    return;
  }

  releaseBlobUrls();
  pane.innerHTML = '';
  pane.classList.remove('is-fullbleed');

  const note = State.current;
  const contentHtml = sanitizeEditorHtml(State.editor ? State.editor.getContent() : note.originalHtml);
  const templateName = UI.templateSelect.value || note.meta.template || 'default';
  const template = State.templates.find((item) => item.name === templateName);

  /* The note content lives in its own container so assets resolve relative to
     the note bundle, not the template folder. */
  const contentHost = document.createElement('div');
  contentHost.innerHTML = contentHtml;
  try {
    await resolveAssets(contentHost, note.dir);
  } catch (error) {
    console.warn('[localnotes] asset resolution problem', error);
  }

  const tokens = {
    title: note.meta.title,
    tags: note.meta.tags.join(', '),
    taglist: note.meta.tags.map((t) => `#${t}`).join(' '),
    created: note.meta.created,
    modified: note.meta.modified,
    template: templateName,
    path: note.path,
    filename: note.name,
    workspace: State.rootName,
    words: State.editor ? State.editor.wordCount() : 0
  };

  if (!template) {
    /* No template file: render the bare note under the optional default CSS. */
    await injectDefaultLayout(pane);
    const header = el('header', { class: 'note-default-header' }, [
      el('h1', { text: note.meta.title }),
      note.meta.tags.length
        ? el('p', { class: 'note-default-tags', text: note.meta.tags.map((t) => `#${t}`).join('  ') })
        : null
    ]);
    pane.append(header);
    while (contentHost.firstChild) pane.append(contentHost.firstChild);
    return;
  }

  let templateText;
  try {
    templateText = await readTextFromHandle(template.handle);
  } catch (error) {
    pane.append(el('div', { class: 'preview-error', text:
      `Template "${templateName}" could not be read: ${error.message}` }));
    while (contentHost.firstChild) pane.append(contentHost.firstChild);
    return;
  }

  const templateDoc = domParser.parseFromString(templateText, 'text/html');
  const templateDir = DIR_TEMPLATES;

  /* Pull scripts out before anything touches the live DOM. */
  const scripts = Array.from(templateDoc.querySelectorAll('script'))
    .map((node) => ({
      type: (node.getAttribute('type') || '').toLowerCase(),
      src: node.getAttribute('src') || '',
      code: node.textContent || ''
    }));
  for (const node of Array.from(templateDoc.querySelectorAll('script'))) node.remove();

  /* Inject the note into the template's slot. */
  const slot = templateDoc.querySelector('[data-note-content]') ||
    templateDoc.querySelector('#note-content') ||
    templateDoc.querySelector('#content') ||
    templateDoc.querySelector('main') ||
    templateDoc.body;
  slot.innerHTML = '';
  while (contentHost.firstChild) slot.append(contentHost.firstChild);

  substituteTokens(templateDoc.body, tokens);
  if (templateDoc.head) substituteTokens(templateDoc.head, tokens);

  /* Template-owned assets resolve against Templates/. */
  try {
    await resolveAssets(templateDoc.body, templateDir);
  } catch (error) {
    console.warn('[localnotes] template asset problem', error);
  }

  /* Styles: inline <style> blocks and local <link rel="stylesheet"> files. */
  const styleNodes = [];
  for (const node of Array.from(templateDoc.querySelectorAll('style'))) {
    styleNodes.push(el('style', { html: node.textContent }));
    node.remove();
  }
  for (const node of Array.from(templateDoc.querySelectorAll('link[rel~="stylesheet"]'))) {
    const href = node.getAttribute('href');
    node.remove();
    if (!href || isExternalUrl(href)) continue;
    try {
      const css = await readTextAt(State.rootHandle, resolveRelative(templateDir, href));
      styleNodes.push(el('style', { html: css }));
    } catch (error) {
      console.warn(`[localnotes] template stylesheet missing: ${href}`, error);
    }
  }
  if (templateDoc.head) {
    for (const node of Array.from(templateDoc.head.querySelectorAll('style'))) {
      styleNodes.push(el('style', { html: node.textContent }));
    }
  }

  if (templateDoc.body.hasAttribute('data-fullbleed')) pane.classList.add('is-fullbleed');

  for (const style of styleNodes) pane.append(style);

  const mount = el('div', { class: 'template-root' });
  mount.innerHTML = templateDoc.body.innerHTML;
  /* Re-run the asset pass on the live nodes: innerHTML round-trips blob URLs. */
  pane.append(mount);

  /* --- lifecycle hooks -------------------------------------------------- */
  const workspace = {
    root: mount,
    pane,
    document: mount.ownerDocument,
    note: {
      path: note.path,
      dir: note.dir,
      name: note.name,
      title: note.meta.title,
      tags: note.meta.tags.slice(),
      created: note.meta.created,
      modified: note.meta.modified,
      template: templateName,
      html: contentHtml
    },
    tokens,
    workspaceName: State.rootName,
    resolveAsset: (reference) => assetBlobUrl(resolveRelative(note.dir, reference)),
    readTemplateFile: (reference) => readTextAt(State.rootHandle, resolveRelative(templateDir, reference)),
    query: (sql, params = []) => runSql(sql, params),
    notes: () => State.notes.map((n) => ({
      path: n.path, title: n.title, tags: n.tags.slice(),
      created: n.created, modified: n.modified, template: n.template
    }))
  };

  for (const script of scripts) {
    try {
      let code = script.code;
      if (script.src && !isExternalUrl(script.src)) {
        code = await readTextAt(State.rootHandle, resolveRelative(templateDir, script.src));
      } else if (script.src) {
        console.warn('[localnotes] refusing to load remote template script', script.src);
        continue;
      }
      if (!code.trim()) continue;

      if (script.type === 'module') {
        const url = await buildModuleBlob(code, templateDir);
        const module = await import(/* @vite-ignore */ url);
        for (const hook of ['initTemplate', 'default', 'onRender', 'render', 'mount']) {
          if (typeof module[hook] === 'function') {
            await module[hook](workspace);
            break;
          }
        }
      } else {
        /* Classic scripts run scoped, with the workspace handed in. */
        const runner = new Function('workspace', 'root', 'note', `"use strict";\n${code}`);
        const result = runner(workspace, mount, workspace.note);
        if (typeof result === 'function') await result(workspace);
        if (typeof window.initTemplate === 'function') {
          await window.initTemplate(workspace);
          delete window.initTemplate;
        }
      }
    } catch (error) {
      console.error('[localnotes] template script error', error);
      pane.prepend(el('div', { class: 'preview-error', text:
        `Template script error (${templateName}): ${error.message}` }));
    }
  }

  mount.dispatchEvent(new CustomEvent('localnotes:render', { detail: workspace, bubbles: true }));
}

export async function injectDefaultLayout(pane) {
  try {
    const css = await readTextAt(State.rootHandle, `${DIR_TEMPLATES}/default-layout.css`);
    pane.append(el('style', { html: css }));
  } catch (_) { /* optional file */ }
}

export function renderTemplateSelect() {
  const select = UI.templateSelect;
  const currentValue = State.current ? (State.current.meta.template || 'default') : 'default';
  select.innerHTML = '';
  select.append(el('option', { value: 'default', text: 'Template: Default' }));
  for (const template of State.templates) {
    select.append(el('option', { value: template.name, text: `Template: ${template.name}` }));
  }
  if (!State.templates.some((t) => t.name === currentValue) && currentValue !== 'default') {
    select.append(el('option', { value: currentValue, text: `Template: ${currentValue} (missing)` }));
  }
  select.value = currentValue;
}
