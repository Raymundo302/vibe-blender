/**
 * Theme picker popup (P10-3). A self-contained DOM widget in the AddMenu mold:
 * it owns its element and listeners and tears them all down on close. One row
 * per registered theme — name + tagline + a swatch strip (panel / accent / text)
 * — with the active theme highlighted. Clicking a row applies the theme
 * (applyTheme sets the CSS vars, swaps the viewport palette, and persists it to
 * localStorage) and closes the popup.
 *
 * Theme choice is an APP PREFERENCE, not scene state: it is intentionally NOT
 * pushed onto the undo stack (Ctrl+Z never reverts a theme) and it survives
 * scene load / new file. Persistence lives entirely in applyTheme's localStorage
 * write, replayed at boot by applyStoredTheme.
 */
import './themePicker.css';
import { themes, currentThemeId, applyTheme } from './themes';

let openPicker: ThemePicker | null = null;

/** Toggle the picker anchored under `anchor` (the topbar 🎨 button). */
export function openThemePicker(anchor: HTMLElement): void {
  if (openPicker) { openPicker.close(); return; }
  openPicker = new ThemePicker(anchor, () => { openPicker = null; });
}

class ThemePicker {
  private readonly root: HTMLDivElement;
  private closed = false;

  constructor(anchor: HTMLElement, private readonly onClose: () => void) {
    this.root = document.createElement('div');
    this.root.className = 'theme-picker';

    const heading = document.createElement('div');
    heading.className = 'theme-picker-heading';
    heading.textContent = 'Theme';
    this.root.appendChild(heading);

    const active = currentThemeId();
    for (const theme of themes()) {
      this.root.appendChild(this.row(theme.id, theme.name, theme.tagline,
        theme.css.panel, theme.css.accent, theme.css.text, theme.id === active));
    }

    document.body.appendChild(this.root);

    // Anchor under the button, right-aligned, clamped to the viewport.
    const r = anchor.getBoundingClientRect();
    const w = this.root.offsetWidth;
    const left = Math.max(4, Math.min(r.right - w, window.innerWidth - w - 4));
    const top = Math.min(r.bottom + 4, window.innerHeight - this.root.offsetHeight - 4);
    this.root.style.left = `${left}px`;
    this.root.style.top = `${Math.max(4, top)}px`;

    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('pointerdown', this.onOutsidePointer, true);
  }

  private row(
    id: string, name: string, tagline: string,
    panel: string, accent: string, text: string, isActive: boolean,
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-picker-row' + (isActive ? ' theme-picker-active' : '');
    btn.dataset.theme = id;

    const swatch = document.createElement('span');
    swatch.className = 'theme-picker-swatch';
    for (const color of [panel, accent, text]) {
      const chip = document.createElement('span');
      chip.className = 'theme-picker-chip';
      chip.style.background = color;
      swatch.appendChild(chip);
    }

    const label = document.createElement('span');
    label.className = 'theme-picker-label';
    const nameEl = document.createElement('span');
    nameEl.className = 'theme-picker-name';
    nameEl.textContent = name;
    const tagEl = document.createElement('span');
    tagEl.className = 'theme-picker-tag';
    tagEl.textContent = tagline;
    label.append(nameEl, tagEl);

    const check = document.createElement('span');
    check.className = 'theme-picker-check';
    check.textContent = isActive ? '✓' : '';

    btn.append(swatch, label, check);
    btn.addEventListener('click', () => {
      applyTheme(id); // sets CSS vars + viewport palette + persists
      this.close();
    });
    return btn;
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); this.close(); }
  };

  private readonly onOutsidePointer = (e: PointerEvent): void => {
    if (!this.root.contains(e.target as Node)) this.close();
  };

  /** Idempotent teardown: removes the element and every listener exactly once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('pointerdown', this.onOutsidePointer, true);
    this.root.remove();
    this.onClose();
  }
}
