/* ============================================================================
 * LocalNotes Manager — src/utils.js
 * ==========================================================================*/

export const $ = (selector, scope = document) => scope.querySelector(selector);
export const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function debounce(fn, wait) {
  let timer = 0;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  wrapped.flush = (...args) => { clearTimeout(timer); fn(...args); };
  return wrapped;
}

export function splitPath(path) {
  return String(path || '').split('/').filter((part) => part.length && part !== '.');
}

export function joinPath(...parts) {
  return parts.flatMap((p) => splitPath(p)).join('/');
}

export function dirname(path) {
  const parts = splitPath(path);
  parts.pop();
  return parts.join('/');
}

export function basename(path) {
  const parts = splitPath(path);
  return parts.length ? parts[parts.length - 1] : '';
}

export function stripExtension(name) {
  return String(name).replace(/\.[^./]+$/, '');
}

/** Resolve a possibly relative reference (./x, ../y/z) against a base folder. */
export function resolveRelative(baseDir, reference) {
  const stack = splitPath(baseDir);
  for (const segment of String(reference).split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') stack.pop();
    else stack.push(segment);
  }
  return stack.join('/');
}

export function isExternalUrl(value) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(String(value || '').trim());
}

export function slugify(value) {
  const slug = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['"`]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  return slug || 'untitled-note';
}

export function todayISO() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&' + 'amp;')
    .replace(/</g, '&' + 'lt;')
    .replace(/>/g, '&' + 'gt;')
    .replace(/"/g, '&' + 'quot;');
}

export function parseTagList(value) {
  return String(value || '')
    .split(/[,\n;]+/)
    .map((tag) => tag.trim().replace(/^#/, ''))
    .filter(Boolean)
    .filter((tag, index, arr) => arr.findIndex((t) => t.toLowerCase() === tag.toLowerCase()) === index);
}

export function tagKey(tags) {
  return `|${tags.map((t) => t.toLowerCase()).join('|')}|`;
}

export function relativeTime(timestamp) {
  if (!timestamp) return 'never';
  const diff = Date.now() - timestamp;
  if (diff < 5000) return 'just now';
  const units = [
    ['d', 86400000], ['h', 3600000], ['m', 60000], ['s', 1000]
  ];
  for (const [suffix, ms] of units) {
    if (diff >= ms) return `${Math.floor(diff / ms)}${suffix} ago`;
  }
  return 'just now';
}
