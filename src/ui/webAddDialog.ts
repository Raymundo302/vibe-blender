import type { Scene } from '../core/scene/Scene';
import type { UndoStack } from '../core/undo/UndoStack';
import { addUrlPlane } from '../tools/urlPlane';
import { pickHtmlLive } from '../tools/htmlPlane';
import './webAddDialog.css';

/**
 * "HTML / Website…" add dialog (UR7-3 A) — the single Shift+A ▸ Image entry that
 * replaces UR4-4's two HTML items. A small centered modal (house theme):
 *  - a text input for a web address (placeholder "https://…") + **Load** →
 *    creates a live URL portal plane (tools/urlPlane.ts → ui/htmlPortals.ts);
 *  - **Open…** → the existing local-file picker (tools/htmlPlane.pickHtmlLive,
 *    which keeps the on-disk live-reload watcher when showOpenFilePicker exists
 *    and falls back to a one-shot snapshot otherwise).
 * Esc or a click outside cancels. Self-contained teardown (owns its element +
 * listeners, removes them all on close) — the AddMenu contract.
 */

/** Build the dialog DOM (pure — no scene wiring). Exported for unit tests. */
export function buildWebAddDialogDom(): {
  backdrop: HTMLDivElement;
  dialog: HTMLDivElement;
  input: HTMLInputElement;
  loadBtn: HTMLButtonElement;
  openBtn: HTMLButtonElement;
  transparentCheck: HTMLInputElement;
  cropCheck: HTMLInputElement;
} {
  const backdrop = document.createElement('div');
  backdrop.className = 'web-add-backdrop';

  const dialog = document.createElement('div');
  dialog.className = 'web-add-dialog';
  backdrop.append(dialog);

  const title = document.createElement('div');
  title.className = 'web-add-title';
  title.textContent = 'HTML / Website';
  dialog.append(title);

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'web-add-input';
  input.placeholder = 'https://…';
  input.spellcheck = false;
  dialog.append(input);

  // UR8-3 A — Open… (local .html) raster options. Both default UNCHECKED and
  // untouched, which means "auto": addHtmlPlaneFromText applies the bare-fragment
  // heuristic (a source with no <body>/<html> becomes transparent + auto-cropped;
  // a full document stays opaque full-page). Toggling a box FORCES that value.
  const opts = document.createElement('div');
  opts.className = 'web-add-opts';
  const mkCheck = (label: string): HTMLInputElement => {
    const wrap = document.createElement('label');
    wrap.className = 'web-add-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.addEventListener('change', () => { cb.dataset.touched = '1'; });
    const span = document.createElement('span');
    span.textContent = label;
    wrap.append(cb, span);
    opts.append(wrap);
    return cb;
  };
  const transparentCheck = mkCheck('Transparent');
  const cropCheck = mkCheck('Crop to content');
  dialog.append(opts);

  const row = document.createElement('div');
  row.className = 'web-add-row';
  dialog.append(row);

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'web-add-btn web-add-open';
  openBtn.textContent = 'Open…';

  const loadBtn = document.createElement('button');
  loadBtn.type = 'button';
  loadBtn.className = 'web-add-btn web-add-load';
  loadBtn.textContent = 'Load';

  row.append(openBtn, loadBtn);

  const hint = document.createElement('div');
  hint.className = 'web-add-hint';
  hint.textContent = 'Load = live iframe portal · Open… = local .html file';
  dialog.append(hint);

  return { backdrop, dialog, input, loadBtn, openBtn, transparentCheck, cropCheck };
}

/** A checkbox's value only when the user TOUCHED it — else undefined ("auto"). */
function overrideOf(cb: HTMLInputElement): boolean | undefined {
  return cb.dataset.touched === '1' ? cb.checked : undefined;
}

export interface WebAddDialogOptions {
  parent: HTMLElement;
  scene: Scene;
  undo: UndoStack;
  setStatus: (text: string) => void;
  /** Fired exactly once on teardown (so the owner drops its ref). */
  onClose: () => void;
}

export class WebAddDialog {
  private readonly backdrop: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly transparentCheck: HTMLInputElement;
  private readonly cropCheck: HTMLInputElement;
  private closed = false;

  constructor(private readonly opts: WebAddDialogOptions) {
    const dom = buildWebAddDialogDom();
    this.backdrop = dom.backdrop;
    this.input = dom.input;
    this.transparentCheck = dom.transparentCheck;
    this.cropCheck = dom.cropCheck;

    dom.loadBtn.addEventListener('click', this.onLoad);
    dom.openBtn.addEventListener('click', this.onOpen);
    // Enter in the address field = Load.
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.onLoad(); }
    });

    opts.parent.appendChild(this.backdrop);
    // Click outside the dialog (on the backdrop) cancels.
    this.backdrop.addEventListener('pointerdown', this.onBackdropDown);
    window.addEventListener('keydown', this.onKeyDown, true);
    // Focus the field so the user can type immediately.
    setTimeout(() => this.input.focus(), 0);
  }

  private readonly onLoad = (): void => {
    const address = this.input.value.trim();
    if (!address) { this.input.focus(); return; }
    const { scene, undo, setStatus } = this.opts;
    this.close();
    void addUrlPlane(scene, undo, address, setStatus);
  };

  private readonly onOpen = (): void => {
    const { scene, undo, setStatus } = this.opts;
    // Raster options: forced only when the user touched the checkbox; otherwise
    // undefined so the bare-fragment heuristic decides (UR8-3 A).
    const rasterOpts = { transparent: overrideOf(this.transparentCheck), autoCrop: overrideOf(this.cropCheck) };
    this.close();
    // Live keeps the on-disk watcher where showOpenFilePicker exists; else it
    // gracefully degrades to a one-shot snapshot (tools/htmlPlane.pickHtmlLive).
    void pickHtmlLive(scene, undo, setStatus, rasterOpts);
  };

  private readonly onBackdropDown = (e: PointerEvent): void => {
    if (e.target === this.backdrop) this.close();
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); this.close(); }
  };

  /** Idempotent teardown: removes the element + every listener exactly once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    window.removeEventListener('keydown', this.onKeyDown, true);
    this.backdrop.remove();
    this.opts.onClose();
  }
}
