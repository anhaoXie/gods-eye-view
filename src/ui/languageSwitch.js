/**
 * Language switcher for the top-center action dock.
 *
 * The button is intentionally text-only: Material Symbols only carries the
 * glyphs listed in index.html's `icon_names` subset, and a glyph outside it
 * renders as its own name. The trigger is wired to the i18n runtime, which
 * re-translates the assembled document in place.
 */
import {
  availableLocales,
  getLocale,
  getLocaleDescriptor,
  onLocaleChange,
  setLocale,
} from '../i18n/index.js';

/**
 * Build the listbox options and the trigger's label.
 * @param {HTMLElement} menu
 * @param {HTMLElement} label
 * @returns {() => void} Re-render the menu against the active locale.
 */
function createMenu(menu, label) {
  function render() {
    const active = getLocale();
    menu.replaceChildren(
      ...availableLocales().map((locale) => {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'language-option';
        option.setAttribute('role', 'option');
        option.dataset.locale = locale.id;
        const selected = locale.id === active;
        option.setAttribute('aria-selected', selected ? 'true' : 'false');
        if (selected) option.classList.add('active');

        const native = document.createElement('span');
        native.className = 'language-option-native';
        native.textContent = locale.native;

        const check = document.createElement('span');
        check.className = 'language-option-check';
        check.setAttribute('aria-hidden', 'true');
        check.textContent = selected ? '✓' : '';

        option.append(native, check);
        return option;
      }),
    );
    label.textContent = getLocaleDescriptor().short;
  }
  return render;
}

/**
 * Bind the language trigger and its popover.
 * @param {{button?: HTMLElement|null, menu?: HTMLElement|null, label?: HTMLElement|null, onAnnounce?: (message: string) => void}} [options]
 * @returns {{destroy: () => void, sync: () => void, open: () => void, close: () => void}}
 */
export function bindLanguageSwitch({
  button,
  menu,
  label,
  onAnnounce,
} = {}) {
  if (!button || !menu || !label) {
    return { destroy() {}, sync() {}, open() {}, close() {} };
  }

  let open = false;
  let destroyed = false;
  const render = createMenu(menu, label);

  const setOpen = (next) => {
    if (destroyed || open === next) return;
    open = next;
    menu.hidden = !next;
    button.setAttribute('aria-expanded', next ? 'true' : 'false');
    button.classList.toggle('open', next);
  };

  const onTriggerClick = (event) => {
    event.stopPropagation();
    setOpen(!open);
  };
  const onMenuClick = (event) => {
    const option = event.target.closest?.('.language-option');
    if (!option) return;
    event.stopPropagation();
    const { locale } = option.dataset;
    if (locale && setLocale(locale)) {
      render();
      onAnnounce?.(getLocaleDescriptor().native);
    }
    setOpen(false);
    button.focus?.();
  };
  const onMenuKeydown = (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    setOpen(false);
    button.focus?.();
  };
  const onDocumentClick = () => setOpen(false);
  const onDocumentKeydown = (event) => {
    if (event.key === 'Escape') setOpen(false);
  };

  render();
  button.addEventListener('click', onTriggerClick);
  menu.addEventListener('click', onMenuClick);
  menu.addEventListener('keydown', onMenuKeydown);
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onDocumentKeydown);
  const unsubscribe = onLocaleChange(() => render());

  return {
    sync: () => render(),
    open: () => setOpen(true),
    close: () => setOpen(false),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsubscribe();
      button.removeEventListener('click', onTriggerClick);
      menu.removeEventListener('click', onMenuClick);
      menu.removeEventListener('keydown', onMenuKeydown);
      document.removeEventListener('click', onDocumentClick);
      document.removeEventListener('keydown', onDocumentKeydown);
    },
  };
}
