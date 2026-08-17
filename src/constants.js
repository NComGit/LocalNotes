/* ============================================================================
 * LocalNotes Manager — src/constants.js
 * ==========================================================================*/

export const IDB_HANDLE_KEY = 'localnotes.rootDirectoryHandle';
export const IDB_CONFIG_KEY = 'localnotes.configMirror';
export const IDB_NAME_KEY = 'localnotes.rootDirectoryName';

export const DIR_NOTES = 'Notes';
export const DIR_TEMPLATES = 'Templates';
export const DIR_QUERIES = 'Queries';
export const DIR_ASSETS = 'Assets';
export const CONFIG_FILE = 'config.json';

export const MAX_SCAN_DEPTH = 16;
export const EXCERPT_LENGTH = 260;
export const MODULE_IMPORT_DEPTH = 3;

export const DEFAULT_CONFIG = {
  version: 1,
  theme: 'light',
  accent: '#1d59c1',
  sidebarWidth: 280,
  resultsWidth: 330,
  contentWidth: 720,
  activeFolder: '',
  selectedTags: [],
  expandedFolders: [''],
  lastNote: '',
  viewMode: 'edit',
  autosave: true,
  autosaveDelay: 1500,
  defaultTemplate: 'default',
  sortOrder: 'modified-desc',
  lastOpened: ''
};

/* Attributes that carry presentation and must never reach the saved file. */
export const BANNED_ATTRIBUTES = [
  'style', 'align', 'valign', 'border', 'cellpadding', 'cellspacing', 'bgcolor',
  'background', 'width', 'height', 'hspace', 'vspace', 'frame', 'rules',
  'nowrap', 'face', 'color', 'size', 'clear', 'compact', 'link', 'vlink',
  'alink', 'text', 'bordercolor', 'bordercolordark', 'bordercolorlight',
  'summary', 'char', 'charoff', 'axis', 'contenteditable', 'spellcheck',
  'autocorrect', 'autocapitalize', 'sizset', 'sizcache', 'unselectable'
];

/* Elements whose only purpose is styling: unwrap, keep their children. */
export const UNWRAP_TAGS = new Set([
  'font', 'center', 'basefont', 'big', 'blink', 'marquee', 'tt', 'acronym',
  'strike', 'nobr'
]);

/* Elements that are removed outright from note content. */
export const DROP_TAGS = new Set([
  'style', 'link', 'meta', 'script', 'base', 'title', 'iframe', 'object',
  'embed', 'applet', 'noscript', 'template', 'colgroup', 'form', 'input',
  'button', 'select', 'textarea', 'frame', 'frameset'
]);

/* Starter files written on first mount. */
export const STARTER_DEFAULT_LAYOUT_CSS = `/* default-layout.css — applied when a note has no template. */
.note-default-header { border-bottom: 1px solid #E6E6E2; margin-bottom: 28px; padding-bottom: 14px; }
.note-default-header h1 { font-family: Georgia, serif; font-size: 32px; font-weight: 600; margin: 0; }
.note-default-tags { font-family: ui-monospace, Menlo, monospace; font-size: 12px; color: #7A756D; margin-top: 8px; }
`;

export const STARTER_STALE_QUERY = `-- stale-notes.sql
-- Notes that have not been modified in the last 30 days.
-- Clicking this file suspends the folder/tag GUI filters entirely.
SELECT *
  FROM notes
 WHERE age_days > 30
 ORDER BY age_days DESC, path ASC
`;
