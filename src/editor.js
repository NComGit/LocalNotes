/* ============================================================================
 * LocalNotes Manager — src/editor.js
 * ==========================================================================*/

import { State, UI } from './state.js';
import { toast } from './ui/toast.js';
import { saveCurrentNote, handleEditorChange } from './note-actions.js';

export const EDITOR_CONTENT_STYLE = `
  html, body { background: #FCFCFA; }
  body {
    font-family: Georgia, "EB Garamond", Garamond, "Iowan Old Style", serif;
    font-size: 17px;
    line-height: 1.62;
    color: #1a1c1b;
    margin: 18px 0 60px;
    padding: 0;
    max-width: none;
  }
  h1 { font-size: 30px; font-weight: 600; line-height: 1.2; margin: 0 0 .6em; }
  h2 { font-size: 24px; font-weight: 600; margin: 1.5em 0 .5em; }
  h3 { font-size: 20px; font-weight: 600; margin: 1.3em 0 .4em; }
  p { margin: 0 0 1.05em; }
  ul, ol { margin: 0 0 1.05em; padding-left: 1.4em; }
  blockquote {
    margin: 1.2em 0; padding: .2em 0 .2em 1.1em;
    border-left: 2px solid #1d59c1; color: #4b463f; font-style: italic;
  }
  a { color: #1d59c1; }
  code, kbd, samp { font-family: "JetBrains Mono", ui-monospace, Menlo, monospace; font-size: .88em; background: #F4F4F2; padding: .08em .3em; }
  pre { font-family: "JetBrains Mono", ui-monospace, Menlo, monospace; font-size: 13px; background: #F4F4F2; border: 1px solid #E6E6E2; padding: 12px 14px; overflow-x: auto; }
  img { max-width: 100%; height: auto; }
  hr { border: 0; border-top: 1px solid #E6E6E2; margin: 2em 0; }
  table { width: 100%; border-collapse: collapse; font-family: Inter, system-ui, sans-serif; font-size: 14px; }
  table th, table td { border: 1px solid #E6E6E2; padding: 8px 10px; text-align: left; }
  table th { background: #F4F4F2; font-weight: 600; }
  ::selection { background: #e8eefb; }
`;

export class EditorAdapter {
  constructor() {
    this.mode = 'textarea';
    this.instance = null;
    this.ready = false;
    this.onChange = () => {};
    this.onCursor = () => {};
  }

  async init() {
    if (this.ready) return this;
    if (typeof window.hugerte === 'object' && window.hugerte && typeof window.hugerte.init === 'function') {
      try {
        await this.initHugeRte();
        this.mode = 'hugerte';
        this.ready = true;
        return this;
      } catch (error) {
        console.error('[localnotes] HugeRTE failed to initialise; using plain textarea', error);
        toast('Rich editor unavailable — falling back to plain HTML editing.', 'warn');
      }
    }
    this.initTextarea();
    this.mode = 'textarea';
    this.ready = true;
    return this;
  }

  async initHugeRte() {
    const editors = await window.hugerte.init({
      target: UI.textarea,
      base_url: './lib/hugerte',
      suffix: '.min',
      skin: 'oxide',
      content_css: false,
      content_style: EDITOR_CONTENT_STYLE,
      menubar: false,
      statusbar: false,
      branding: false,
      promotion: false,
      elementpath: false,
      resize: false,
      min_height: 460,
      autoresize_bottom_margin: 90,
      plugins: [
        'autolink', 'autoresize', 'charmap', 'code', 'codesample', 'link', 'lists',
        'advlist', 'searchreplace', 'table', 'visualblocks', 'wordcount', 'image',
        'insertdatetime', 'nonbreaking', 'anchor', 'quickbars'
      ].join(' '),
      toolbar: 'blocks | bold italic underline | bullist numlist | blockquote link image table | ' +
        'code codesample charmap | removeformat searchreplace',
      quickbars_insert_toolbar: false,
      quickbars_selection_toolbar: 'bold italic | blockquote link',
      block_formats: 'Paragraph=p; Heading 1=h1; Heading 2=h2; Heading 3=h3; ' +
        'Heading 4=h4; Preformatted=pre; Blockquote=blockquote',
      /* --- style firewall, layer one: never let the editor emit styling --- */
      convert_urls: false,
      relative_urls: false,
      remove_script_host: false,
      inline_styles: false,
      formats: {
        bold: { inline: 'strong' },
        italic: { inline: 'em' },
        underline: { inline: 'u' },
        strikethrough: { inline: 's' }
      },
      invalid_styles: {
        '*': 'color font-size font-family background background-color line-height ' +
          'letter-spacing text-align margin margin-left margin-right margin-top margin-bottom ' +
          'padding padding-left padding-right width height border border-collapse float',
        table: 'width height border border-collapse',
        td: 'width height border padding vertical-align',
        th: 'width height border padding vertical-align',
        img: 'width height'
      },
      table_default_attributes: {},
      table_default_styles: {},
      table_use_colgroups: false,
      table_advtab: false,
      table_cell_advtab: false,
      table_row_advtab: false,
      table_style_by_css: false,
      object_resizing: false,
      paste_data_images: false,
      paste_as_text: false,
      paste_remove_styles_if_webkit: true,
      extended_valid_elements: 'section[id|class],figure,figcaption,mark,abbr[title],' +
        'time[datetime],details,summary,sup,sub,math[xmlns|display],semantics,mrow,mi,mn,mo,' +
        'msup,msub,mfrac,msqrt,annotation[encoding]',
      valid_children: '+section[div|p|h1|h2|h3|h4|ul|ol|table|figure|pre|blockquote]',
      setup: (editor) => {
        this.instance = editor;
        editor.on('Dirty input NodeChange ExecCommand SetContent undo redo', () => {
          if (this.suppress) return;
          this.onChange();
        });
        editor.on('NodeChange KeyUp MouseUp SelectionChange', () => {
          this.onCursor(this.cursor());
        });
        editor.on('keydown', (event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            saveCurrentNote(true);
          }
        });
      }
    });
    if (!editors || !editors.length) throw new Error('HugeRTE returned no editor instance');
    return editors[0];
  }

  initTextarea() {
    UI.textarea.style.display = '';
    UI.textarea.addEventListener('input', () => {
      if (this.suppress) return;
      this.onChange();
      this.onCursor(this.cursor());
    });
    UI.textarea.addEventListener('keyup', () => this.onCursor(this.cursor()));
    UI.textarea.addEventListener('click', () => this.onCursor(this.cursor()));
  }

  getContent() {
    if (this.mode === 'hugerte' && this.instance) return this.instance.getContent({ format: 'html' });
    return UI.textarea.value;
  }

  setContent(html) {
    this.suppress = true;
    try {
      if (this.mode === 'hugerte' && this.instance) {
        this.instance.setContent(html || '', { format: 'html' });
        this.instance.undoManager.clear();
        this.instance.setDirty(false);
      } else {
        UI.textarea.value = html || '';
      }
    } finally {
      this.suppress = false;
    }
  }

  focus() {
    if (this.mode === 'hugerte' && this.instance) this.instance.focus();
    else UI.textarea.focus();
  }

  /** Real Ln/Col computation from the live selection. */
  cursor() {
    if (this.mode === 'hugerte' && this.instance) {
      try {
        const range = this.instance.selection.getRng();
        const body = this.instance.getBody();
        const blocks = Array.from(body.children);
        let block = range.startContainer;
        while (block && block.parentNode && block.parentNode !== body) block = block.parentNode;
        const line = block && blocks.indexOf(block) >= 0 ? blocks.indexOf(block) + 1 : 1;
        let column = 1;
        if (block && block.nodeType === 1) {
          const probe = body.ownerDocument.createRange();
          probe.selectNodeContents(block);
          probe.setEnd(range.startContainer, range.startOffset);
          column = probe.toString().length + 1;
        }
        return { line, column };
      } catch (_) {
        return { line: 1, column: 1 };
      }
    }
    const value = UI.textarea.value.slice(0, UI.textarea.selectionStart || 0);
    const lines = value.split('\n');
    return { line: lines.length, column: lines[lines.length - 1].length + 1 };
  }

  wordCount() {
    const text = this.mode === 'hugerte' && this.instance
      ? this.instance.getContent({ format: 'text' })
      : UI.textarea.value.replace(/<[^>]+>/g, ' ');
    return text.split(/\s+/).filter(Boolean).length;
  }
}

export async function ensureEditor() {
  if (!State.editor) {
    State.editor = new EditorAdapter();
    State.editor.onChange = handleEditorChange;
    State.editor.onCursor = ({ line, column }) => {
      UI.cursorPosition.textContent = `Ln ${line}, Col ${column}`;
    };
    await State.editor.init();
  }
  return State.editor;
}
