/* ============================================================================
 * LocalNotes Manager — src/fs.js
 * ==========================================================================*/

import { MAX_SCAN_DEPTH } from './constants.js';
import { splitPath } from './utils.js';

export async function dirEntries(dirHandle) {
  const entries = [];
  if (typeof dirHandle.entries === 'function') {
    for await (const [name, handle] of dirHandle.entries()) entries.push([name, handle]);
  } else if (typeof dirHandle.values === 'function') {
    for await (const handle of dirHandle.values()) entries.push([handle.name, handle]);
  }
  entries.sort((a, b) => {
    if (a[1].kind !== b[1].kind) return a[1].kind === 'directory' ? -1 : 1;
    return a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: 'base' });
  });
  return entries;
}

export async function getDirectory(root, path, create = false) {
  let handle = root;
  for (const part of splitPath(path)) {
    handle = await handle.getDirectoryHandle(part, { create });
  }
  return handle;
}

export async function getFileHandleAt(root, path, create = false) {
  const parts = splitPath(path);
  const name = parts.pop();
  if (!name) throw new Error(`Invalid file path: ${path}`);
  const dir = await getDirectory(root, parts.join('/'), create);
  return dir.getFileHandle(name, { create });
}

export async function readTextAt(root, path) {
  const handle = await getFileHandleAt(root, path, false);
  const file = await handle.getFile();
  return file.text();
}

export async function readTextFromHandle(handle) {
  const file = await handle.getFile();
  return file.text();
}

export async function writeTextToHandle(handle, text, mime = 'text/html;charset=utf-8') {
  const writable = await handle.createWritable({ keepExistingData: false });
  await writable.write(new Blob([text], { type: mime }));
  await writable.close();
}

export async function writeTextAt(root, path, text, mime) {
  const handle = await getFileHandleAt(root, path, true);
  await writeTextToHandle(handle, text, mime);
  return handle;
}

export async function pathExists(root, path, kind = 'file') {
  try {
    if (kind === 'directory') await getDirectory(root, path, false);
    else await getFileHandleAt(root, path, false);
    return true;
  } catch (_) {
    return false;
  }
}

export async function removeRecursively(root, path) {
  const parts = splitPath(path);
  const name = parts.pop();
  const parent = await getDirectory(root, parts.join('/'), false);
  await parent.removeEntry(name, { recursive: true });
}

export async function copyDirectory(sourceDir, targetDir, depth = 0) {
  if (depth > MAX_SCAN_DEPTH) return;
  for (const [name, handle] of await dirEntries(sourceDir)) {
    if (handle.kind === 'directory') {
      const child = await targetDir.getDirectoryHandle(name, { create: true });
      await copyDirectory(handle, child, depth + 1);
    } else {
      const file = await handle.getFile();
      const target = await targetDir.getFileHandle(name, { create: true });
      const writable = await target.createWritable({ keepExistingData: false });
      await writable.write(await file.arrayBuffer());
      await writable.close();
    }
  }
}
