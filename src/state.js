/* ============================================================================
 * LocalNotes Manager — src/state.js
 * ==========================================================================*/

import { DEFAULT_CONFIG } from './constants.js';
import { $ } from './utils.js';

export const State = {
  supported: typeof window.showDirectoryPicker === 'function',
  rootHandle: null,
  rootName: '',
  mounted: false,
  config: { ...DEFAULT_CONFIG },

  notes: [],
  tree: null,
  tagUniverse: [],
  templates: [],
  queries: [],

  folderFilter: '',
  selectedTags: new Set(),
  searchText: '',
  activeQuery: null,      /* { name, path, sql } */
  results: [],
  rawRows: null,          /* non-note SQL rows */

  expanded: new Set(['']),

  current: null,          /* active note session */
  dirty: false,
  saving: false,
  lastSavedAt: 0,

  editor: null,           /* EditorAdapter */
  viewMode: 'edit',
  blobUrls: [],
  moduleUrls: [],
  assetCache: new Map(),
  scanning: false
};

/* Cached DOM references. */
export const UI = {};

export function cacheDom() {
  UI.container = $('.app-container');
  UI.sidebar = $('#col-navigation');
  UI.results = $('#col-results');
  UI.workspace = $('#col-workspace');

  UI.btnNewNote = $('#btn-new-note');
  UI.btnMount = $('#btn-mount');
  UI.searchInput = $('#search-input');
  UI.fileTree = $('#file-tree');
  UI.tagsList = $('#tags-list');
  UI.btnClearTags = $('#btn-clear-tags');
  UI.queriesList = $('#queries-list');
  UI.btnNewQuery = $('#btn-new-query');
  UI.btnSettings = $('#btn-settings');
  UI.statusBadge = $('#status-badge');

  UI.queueHeader = $('.queue-header');
  UI.resultsCount = $('#results-count');
  UI.resultsList = $('#results-list');

  UI.emptyState = $('#workspace-empty-state');
  UI.welcomeBox = $('.welcome-box');
  UI.btnWelcomeMount = $('#btn-welcome-mount');
  UI.activeState = $('#workspace-active-state');
  UI.filePath = $('#current-filepath');
  UI.templateSelect = $('#select-template');
  UI.btnEdit = $('#btn-toggle-edit');
  UI.btnPreview = $('#btn-toggle-preview');
  UI.editorPane = $('#pane-editor');
  UI.previewPane = $('#pane-preview');
  UI.renderedView = $('#rendered-view-pane');
  UI.titleInput = $('#note-title-input');
  UI.metaBar = $('#metadata-editor-bar');
  UI.tagsInput = $('#note-tags-input');
  UI.textarea = $('#my-note-editor');
  UI.cursorPosition = $('#cursor-position');
  UI.saveStatus = $('#last-saved-status');
  UI.encoding = $('#file-encoding');
}
