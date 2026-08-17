/* ============================================================================
 * LocalNotes Manager — src/settings.js
 * ==========================================================================*/

import { DIR_QUERIES, CONFIG_FILE } from './constants.js';
import { State } from './state.js';
import { el, $, relativeTime } from './utils.js';
import { writeTextAt } from './fs.js';
import { applyConfig, persistConfig } from './config.js';
import { sqlEngine, runSql } from './index-engine.js';
import { loadQueries, loadTemplates } from './traversal.js';
import { refreshResults } from './search.js';
import { renderTemplateSelect } from './templates.js';
import { unmount } from './mounting.js';
import { refreshIndex } from './note-actions.js';
import { renderQueries } from './ui/render.js';
import { toast, showModal, closeModal } from './ui/toast.js';

export function promptNewQuery() {
  if (!State.mounted) {
    toast('Mount a folder first.', 'warn');
    return;
  }

  showModal({
    title: 'New SQL query',
    wide: true,
    build: (body) => {
      body.append(
        el('p', { html:
          'Saved as a plain <code>.sql</code> file inside <code>Queries/</code>. Available tables: ' +
          '<code>notes</code> (path, dir, title, template, tags, tags_csv, tags_key, tag_count, ' +
          'created, modified, modified_ts, age_days, size, words, excerpt, text, is_bundle, ' +
          'has_assets) and <code>note_tags</code> (path, title, tag).' }),
        el('div', { class: 'field' }, [
          el('label', { for: 'nq-name', text: 'File name' }),
          el('input', { type: 'text', id: 'nq-name', value: 'my-query.sql' })
        ]),
        el('div', { class: 'field' }, [
          el('label', { for: 'nq-sql', text: 'SQL statement' }),
          el('textarea', { id: 'nq-sql', spellcheck: 'false' },
            ['-- Notes not touched in 30 days\nSELECT *\n  FROM notes\n WHERE age_days > 30\n ORDER BY age_days DESC'])
        ]),
        el('div', { class: 'field' }, [
          el('label', { text: 'Dry run' }),
          el('button', {
            class: 'btn btn-inline btn-secondary',
            text: '[ Test statement ]',
            onClick: () => {
              const output = $('#nq-result');
              try {
                const rows = runSql($('#nq-sql').value.replace(/(^|\n)\s*--[^\n]*/g, '').replace(/;\s*$/, ''));
                output.className = 'hint';
                output.textContent = `OK — ${rows.length} row(s). ` +
                  (rows.length ? `First: ${JSON.stringify(rows[0]).slice(0, 220)}` : '');
              } catch (error) {
                output.className = 'preview-error';
                output.textContent = String(error.message || error);
              }
            }
          }),
          el('span', { class: 'hint', id: 'nq-result', text: 'Runs against the live in-memory index.' })
        ])
      );
    },
    actions: [
      { label: '[ Cancel ]', kind: 'secondary', onClick: (close) => close() },
      {
        label: '[ Save Query ]',
        onClick: async (close) => {
          let name = $('#nq-name').value.trim() || 'my-query.sql';
          if (!/\.sql$/i.test(name)) name += '.sql';
          const sql = $('#nq-sql').value;
          close();
          try {
            await writeTextAt(State.rootHandle, `${DIR_QUERIES}/${name}`, `${sql.trim()}\n`, 'text/plain');
            await loadQueries();
            renderQueries();
            toast(`Saved Queries/${name}`, 'ok');
          } catch (error) {
            toast(`Could not save the query: ${error.message}`, 'error');
          }
        }
      }
    ]
  });
}

export function openSettings() {
  showModal({
    title: 'Settings',
    wide: true,
    build: (body) => {
      const config = State.config;

      body.append(
        el('div', { class: 'settings-block' }, [
          el('h4', { text: 'Workspace' }),
          el('table', { class: 'kv-table' }, [
            el('tr', {}, [el('th', { text: 'Mounted root' }), el('td', { text: State.mounted ? `${State.rootName}/` : '(none)' })]),
            el('tr', {}, [el('th', { text: 'Config file' }), el('td', { text: `${State.rootName}/${CONFIG_FILE}` })]),
            el('tr', {}, [el('th', { text: 'Notes indexed' }), el('td', { text: String(State.notes.length) })]),
            el('tr', {}, [el('th', { text: 'Tags in universe' }), el('td', { text: String(State.tagUniverse.length) })]),
            el('tr', {}, [el('th', { text: 'Templates' }), el('td', { text: State.templates.map((t) => t.name).join(', ') || '(none)' })]),
            el('tr', {}, [el('th', { text: 'Saved queries' }), el('td', { text: State.queries.map((q) => q.name).join(', ') || '(none)' })]),
            el('tr', {}, [el('th', { text: 'Index engine' }), el('td', { text: sqlEngine() ? 'AlaSQL (transient, in-memory)' : 'JS fallback (AlaSQL missing)' })]),
            el('tr', {}, [el('th', { text: 'Editor' }), el('td', { text: State.editor ? State.editor.mode : 'not initialised' })]),
            el('tr', {}, [el('th', { text: 'Last save' }), el('td', { text: relativeTime(State.lastSavedAt) })])
          ])
        ]),

        el('div', { class: 'settings-block' }, [
          el('h4', { text: 'Layout (saved to config.json)' }),
          el('div', { class: 'field-row' }, [
            el('div', { class: 'field' }, [
              el('label', { for: 'st-sidebar', text: 'Sidebar width (px)' }),
              el('input', { type: 'number', id: 'st-sidebar', min: '240', max: '480', value: String(config.sidebarWidth) })
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 'st-results', text: 'Results width (px)' }),
              el('input', { type: 'number', id: 'st-results', min: '240', max: '560', value: String(config.resultsWidth) })
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 'st-content', text: 'Reading measure (px)' }),
              el('input', { type: 'number', id: 'st-content', min: '480', max: '1200', value: String(config.contentWidth) })
            ])
          ]),
          el('div', { class: 'field-row' }, [
            el('div', { class: 'field' }, [
              el('label', { for: 'st-accent', text: 'Accent colour' }),
              el('input', { type: 'text', id: 'st-accent', value: config.accent })
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 'st-sort', text: 'Result order' }),
              el('select', { id: 'st-sort' }, [
                ['modified-desc', 'Modified — newest first'],
                ['modified-asc', 'Modified — oldest first'],
                ['created-desc', 'Created — newest first'],
                ['title-asc', 'Title A→Z'],
                ['path-asc', 'Path A→Z'],
                ['words-desc', 'Longest first']
              ].map(([value, label]) => el('option', {
                value, text: label, selected: config.sortOrder === value
              })))
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 'st-template', text: 'Default template' }),
              el('select', { id: 'st-template' }, [el('option', { value: 'default', text: 'default' })]
                .concat(State.templates.map((t) => el('option', {
                  value: t.name, text: t.name, selected: config.defaultTemplate === t.name
                }))))
            ])
          ])
        ]),

        el('div', { class: 'settings-block' }, [
          el('h4', { text: 'Saving' }),
          el('label', { class: 'field-check' }, [
            el('input', { type: 'checkbox', id: 'st-autosave', checked: Boolean(config.autosave) }),
            'Autosave while typing'
          ]),
          el('div', { class: 'field' }, [
            el('label', { for: 'st-delay', text: 'Autosave delay (ms)' }),
            el('input', { type: 'number', id: 'st-delay', min: '400', max: '15000', step: '100', value: String(config.autosaveDelay) })
          ])
        ]),

        el('div', { class: 'settings-block' }, [
          el('h4', { text: 'Maintenance' }),
          el('div', { class: 'field-row' }, [
            el('button', { class: 'btn btn-inline btn-secondary', text: '[ Re-index workspace ]', onClick: () => refreshIndex() }),
            el('button', { class: 'btn btn-inline btn-secondary', text: '[ Reload templates ]', onClick: async () => {
              await loadTemplates();
              renderTemplateSelect();
              toast(`${State.templates.length} template(s) reloaded.`, 'ok');
            } }),
            el('button', { class: 'btn btn-inline btn-secondary', text: '[ Clear offline cache ]', onClick: () => {
              if (navigator.serviceWorker && navigator.serviceWorker.controller) {
                navigator.serviceWorker.controller.postMessage({ type: 'PURGE_CACHES' });
                toast('Offline cache purged. Reload to re-install the shell.', 'ok');
              } else {
                toast('No service worker is active.', 'warn');
              }
            } }),
            el('button', { class: 'btn btn-inline btn-danger', text: '[ Unmount folder ]', onClick: async () => {
              closeModal();
              await unmount();
            } })
          ]),
          el('span', { class: 'hint', text:
            'Unmounting only forgets the directory handle stored in IndexedDB. Nothing on disk is ' +
            'touched or deleted.' })
        ]),

        el('div', { class: 'settings-block' }, [
          el('h4', { text: 'Keyboard' }),
          el('table', { class: 'kv-table' }, [
            el('tr', {}, [el('th', { text: 'Ctrl/Cmd + S' }), el('td', { text: 'Save the current note' })]),
            el('tr', {}, [el('th', { text: 'Ctrl/Cmd + N' }), el('td', { text: 'New note' })]),
            el('tr', {}, [el('th', { text: 'Ctrl/Cmd + K' }), el('td', { text: 'Focus the search index' })]),
            el('tr', {}, [el('th', { text: 'Ctrl/Cmd + E' }), el('td', { text: 'Toggle editor / rendered preview' })]),
            el('tr', {}, [el('th', { text: 'Ctrl/Cmd + R' }), el('td', { text: 'Re-index the workspace' })]),
            el('tr', {}, [el('th', { text: 'Escape' }), el('td', { text: 'Close dialogs and drawers' })])
          ])
        ])
      );
    },
    actions: [
      { label: '[ Close ]', kind: 'secondary', onClick: (close) => close() },
      {
        label: '[ Apply & Save ]',
        onClick: async (close) => {
          const number = (id, fallback) => {
            const value = Number($(`#${id}`).value);
            return Number.isFinite(value) ? value : fallback;
          };
          State.config.sidebarWidth = number('st-sidebar', State.config.sidebarWidth);
          State.config.resultsWidth = number('st-results', State.config.resultsWidth);
          State.config.contentWidth = number('st-content', State.config.contentWidth);
          const accent = $('#st-accent').value.trim();
          if (/^#[0-9a-f]{3,8}$/i.test(accent)) State.config.accent = accent;
          State.config.sortOrder = $('#st-sort').value;
          State.config.defaultTemplate = $('#st-template').value;
          State.config.autosave = $('#st-autosave').checked;
          State.config.autosaveDelay = number('st-delay', 1500);
          close();
          applyConfig();
          refreshResults();
          persistConfig.flush();
          toast('Settings written to config.json.', 'ok');
        }
      }
    ]
  });
}
