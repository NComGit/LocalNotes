/* ============================================================================
 * LocalNotes Manager — src/ui/toast.js
 * ==========================================================================*/

import { el, $ } from '../utils.js';

let toastStack = null;

export function toast(message, kind = 'info', timeout = 4200) {
  if (!toastStack) {
    toastStack = el('div', { class: 'toast-stack', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastStack);
  }
  const node = el('div', {
    class: `toast${kind === 'info' ? '' : ` is-${kind}`}`,
    text: message
  });
  toastStack.append(node);
  const remove = () => node.remove();
  node.addEventListener('click', remove);
  if (timeout > 0) setTimeout(remove, timeout);
  return node;
}

export let openModal = null;

export function closeModal() {
  if (!openModal) return;
  openModal.remove();
  openModal = null;
}

/**
 * Build a modal. `build(body, close)` fills the body; `actions` is an array of
 * { label, kind, onClick } descriptors rendered in the footer.
 */
export function showModal({ title, build, actions = [], wide = false, onOpen = null }) {
  closeModal();

  const body = el('div', { class: 'modal-body' });
  const close = () => closeModal();
  build(body, close);

  const footer = el('div', { class: 'modal-footer' });
  for (const action of actions) {
    if (action === 'spacer') { footer.append(el('span', { class: 'spacer' })); continue; }
    footer.append(el('button', {
      class: `btn btn-inline${action.kind === 'danger' ? ' btn-danger' : ''}${action.kind === 'secondary' ? ' btn-secondary' : ''}`,
      text: action.label,
      onClick: () => action.onClick(close)
    }));
  }

  const modal = el('div', { class: `modal${wide ? ' modal-wide' : ''}`, role: 'dialog', 'aria-modal': 'true' }, [
    el('div', { class: 'modal-header' }, [
      el('span', { class: 'modal-title', text: title }),
      el('button', { class: 'modal-close', text: '✕', title: 'Close', onClick: close })
    ]),
    body,
    footer
  ]);

  const backdrop = el('div', {
    class: 'modal-backdrop',
    onMousedown: (event) => { if (event.target === backdrop) close(); }
  }, [modal]);

  document.body.append(backdrop);
  openModal = backdrop;

  const focusable = $('input, textarea, select, button', body);
  if (focusable) focusable.focus();
  if (typeof onOpen === 'function') onOpen(body);
  return backdrop;
}

export function confirmModal(title, message, confirmLabel = '[ Confirm ]') {
  return new Promise((resolve) => {
    showModal({
      title,
      build: (body) => { body.append(el('p', { text: message })); },
      actions: [
        { label: '[ Cancel ]', kind: 'secondary', onClick: (close) => { close(); resolve(false); } },
        { label: confirmLabel, kind: 'danger', onClick: (close) => { close(); resolve(true); } }
      ]
    });
  });
}
