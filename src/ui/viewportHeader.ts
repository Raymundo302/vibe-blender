import type { Scene } from '../core/scene/Scene';
import type { ShadingMenu } from './shadingMenu';
import { snapState } from '../core/snap';
import { xrayState } from '../render/passes/elementPickPass';
import { overlays, saveOverlayPrefs, type OverlayPrefs, type RGB } from '../render/overlayPrefs';
import { objectTypes, saveObjectTypePrefs } from '../render/objectTypePrefs';
import type { ObjectKind } from '../core/scene/objectData';
import { setTip } from './tooltip';
import './viewportHeader.css';

/** Boolean-valued overlay pref keys bound to the panel's checkboxes. */
type BoolKey = { [K in keyof OverlayPrefs]: OverlayPrefs[K] extends boolean ? K : never }[keyof OverlayPrefs];
/** RGB-valued overlay pref keys bound to the panel's color inputs. */
type ColorKey = { [K in keyof OverlayPrefs]: OverlayPrefs[K] extends RGB ? K : never }[keyof OverlayPrefs];

const CHECK_ROWS: [BoolKey, string][] = [
  ['grid', 'Grid'],
  ['floor', 'Floor'],
  ['originPoints', 'Origin Points'],
  ['icons', 'Light & Camera Icons'],
  ['frustums', 'Camera Frustums'],
  ['cursor3d', '3D Cursor'],
  ['gizmo', 'Transform Gizmo'],
];

const COLOR_ROWS: [ColorKey, string][] = [
  ['gridColor', 'Grid Lines'],
  ['axisX', 'Axis X'],
  ['axisY', 'Axis Y'],
  ['axisZ', 'Axis Z'],
];

/** Object-type dropdown rows: icon + plural label per kind, in display order. */
const TYPE_ROWS: [ObjectKind, string, string][] = [
  ['mesh', '▦', 'Meshes'],
  ['curve', '〰', 'Curves'],
  ['text', 'T', 'Text'],
  ['light', '💡', 'Lights'],
  ['camera', '🎥', 'Cameras'],
  ['empty', '✛', 'Empties'],
];

/** RGB (0..1 display channels, no gamma) → "#rrggbb" for a native color input. */
const toHex = (c: RGB): string => '#' + c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');
/** "#rrggbb" → RGB (0..1 display channels, no gamma). */
const fromHex = (h: string): RGB => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];

/**
 * The 3D Viewport's area header controls (Blender's viewport header), laid out
 * left / center / right and travelling with the viewport editor (it's the
 * editor's `headerExtra`, so it sits right of the "3D Viewport ▾" editor-type
 * selector):
 *   LEFT   — mode selector (Object / Edit)
 *   CENTER — transform orientation ▾ · pivot point ▾ · 🧲 Snap
 *   RIGHT  — ◉ Show ▾ (object-type visibility/selectability) · ⬒ Overlays ▾ · 👓 X-ray · shading dropdown
 *
 * Purely reflects/drives Scene + snap/xray state; update() is ticked from the
 * frame loop (signature-diffed so it's a cheap no-op when nothing changed), and
 * it also drives the shading menu's own update().
 */
export class ViewportHeader {
  readonly element: HTMLElement;
  private readonly modeSel: HTMLSelectElement;
  private readonly orientSel: HTMLSelectElement;
  private readonly pivotSel: HTMLSelectElement;
  private readonly snapBtn: HTMLButtonElement;
  private readonly xrayBtn: HTMLButtonElement;
  private readonly overlaysBtn: HTMLButtonElement;
  private overlaysPanel: HTMLElement | null = null;
  private overlaysCleanup: (() => void) | null = null;
  private readonly visBtn: HTMLButtonElement;
  private visPanel: HTMLElement | null = null;
  private visCleanup: (() => void) | null = null;
  private lastSig = '';

  /** Set by main.ts — flips the 3D-cursor DOM overlay's visibility (the overlay
   *  is constructed after this header, so it's wired in via this callback). */
  onCursorVisibility?: (visible: boolean) => void;

  constructor(
    private readonly scene: Scene,
    private readonly shadingMenu: ShadingMenu,
  ) {
    const el = document.createElement('div');
    el.className = 'viewport-header';

    // --- LEFT: mode selector -------------------------------------------------
    this.modeSel = ViewportHeader.select('vh-mode', [
      ['object', 'Object Mode'],
      ['edit', 'Edit Mode'],
    ], (v) => this.setMode(v));
    setTip(this.modeSel, 'Interaction mode', 'Tab');
    const left = ViewportHeader.group('vh-left', this.modeSel);

    // --- CENTER: orientation · pivot · snap ---------------------------------
    this.orientSel = ViewportHeader.select('vh-orient', [
      ['global', 'Global'],
      ['local', 'Local'],
      ['normal', 'Normal'],
    ], (v) => { this.scene.transformOrientation = v as Scene['transformOrientation']; });
    setTip(this.orientSel, 'Transform orientation');

    this.pivotSel = ViewportHeader.select('vh-pivot', [
      ['median', 'Median Point'],
      ['individual', 'Individual Origins'],
      ['active', 'Active Element'],
      ['cursor', '3D Cursor'],
    ], (v) => { this.scene.pivotMode = v as Scene['pivotMode']; });
    setTip(this.pivotSel, 'Transform pivot point');

    this.snapBtn = ViewportHeader.button('vh-snap', '🧲 Snap', () => {
      snapState.enabled = !snapState.enabled;
      this.update();
    });
    setTip(this.snapBtn, 'Grid snapping', 'Shift+Tab');
    const center = ViewportHeader.group('vh-center', this.orientSel, this.pivotSel, this.snapBtn);

    // --- RIGHT: visibility · overlays · x-ray · shading ---------------------
    this.visBtn = ViewportHeader.button('vh-vis', '◉ Show ▾', () => this.toggleVisibility());
    setTip(this.visBtn, 'Object types visibility & selectability');

    this.overlaysBtn = ViewportHeader.button('vh-overlays', '⬒ Overlays ▾', () => this.toggleOverlays());
    setTip(this.overlaysBtn, 'Viewport overlays');

    this.xrayBtn = ViewportHeader.button('vh-xray', '👓 X-ray', () => {
      xrayState.enabled = !xrayState.enabled;
      this.update();
    });
    setTip(this.xrayBtn, 'X-ray / select-through', 'Alt+Z');
    const right = ViewportHeader.group('vh-right', this.visBtn, this.overlaysBtn, this.xrayBtn, shadingMenu.element);

    el.append(left, ViewportHeader.spacer(), center, ViewportHeader.spacer(), right);
    this.element = el;
    this.update();
  }

  /** Mode dropdown → enter/exit mesh Edit Mode (Blender: only meshes edit). */
  private setMode(v: string): void {
    if (v === 'edit') {
      const a = this.scene.activeObject;
      if (a && a.kind === 'mesh') this.scene.enterEditMode(a.id);
      else this.modeSel.value = this.scene.editMode ? 'edit' : 'object'; // no-op revert
    } else if (this.scene.editMode) {
      this.scene.exitEditMode();
    }
  }

  // --- Overlays popover ------------------------------------------------------
  /** Toggle the Overlays panel anchored under its button. */
  private toggleOverlays(): void {
    if (this.overlaysPanel) { this.closeOverlays(); return; }

    const panel = document.createElement('div');
    panel.className = 'vh-overlays-panel';
    this.buildOverlaysPanel(panel);
    document.body.appendChild(panel);
    this.overlaysPanel = panel;

    // Anchor under the button, right-aligned, clamped on-screen.
    const r = this.overlaysBtn.getBoundingClientRect();
    panel.style.top = `${r.bottom + 4}px`;
    panel.style.left = `${Math.max(4, r.right - panel.offsetWidth)}px`;

    const onOutside = (e: PointerEvent): void => {
      const t = e.target as Node;
      if (!panel.contains(t) && t !== this.overlaysBtn) this.closeOverlays();
    };
    // Defer registration so the click that opened the panel doesn't close it.
    const register = (): void => document.addEventListener('pointerdown', onOutside, true);
    const raf = requestAnimationFrame(register);
    this.overlaysCleanup = () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('pointerdown', onOutside, true);
    };
    this.overlaysBtn.classList.add('vh-on');
  }

  private closeOverlays(): void {
    this.overlaysCleanup?.();
    this.overlaysCleanup = null;
    this.overlaysPanel?.remove();
    this.overlaysPanel = null;
    this.overlaysBtn.classList.remove('vh-on');
  }

  // --- Object-type visibility / selectability popover ------------------------
  /** Toggle the Show/Select panel anchored under its button. */
  private toggleVisibility(): void {
    if (this.visPanel) { this.closeVisibility(); return; }

    const panel = document.createElement('div');
    panel.className = 'vh-overlays-panel vh-vis-panel';
    this.buildVisibilityPanel(panel);
    document.body.appendChild(panel);
    this.visPanel = panel;

    const r = this.visBtn.getBoundingClientRect();
    panel.style.top = `${r.bottom + 4}px`;
    panel.style.left = `${Math.max(4, r.right - panel.offsetWidth)}px`;

    const onOutside = (e: PointerEvent): void => {
      const t = e.target as Node;
      if (!panel.contains(t) && t !== this.visBtn) this.closeVisibility();
    };
    const register = (): void => document.addEventListener('pointerdown', onOutside, true);
    const raf = requestAnimationFrame(register);
    this.visCleanup = () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('pointerdown', onOutside, true);
    };
    this.visBtn.classList.add('vh-on');
  }

  private closeVisibility(): void {
    this.visCleanup?.();
    this.visCleanup = null;
    this.visPanel?.remove();
    this.visPanel = null;
    this.visBtn.classList.remove('vh-on');
  }

  /** One row per object type: a Show (eye) toggle + a Select toggle, both
   *  initialized from `objectTypes` and persisted on change. */
  private buildVisibilityPanel(panel: HTMLElement): void {
    const heading = document.createElement('div');
    heading.className = 'vh-overlays-heading';
    heading.textContent = 'Object Types';
    panel.appendChild(heading);

    // Column header: 👁 = visible in viewport, ➤ = selectable (clickable).
    const head = document.createElement('div');
    head.className = 'vh-vis-row vh-vis-head';
    const hSpacer = document.createElement('span');
    hSpacer.className = 'vh-vis-label';
    const hShow = document.createElement('span');
    hShow.textContent = '👁';
    setTip(hShow, 'Visible in viewport');
    const hSel = document.createElement('span');
    hSel.textContent = '➤';
    setTip(hSel, 'Selectable');
    head.append(hSpacer, hShow, hSel);
    panel.appendChild(head);

    for (const [kind, icon, label] of TYPE_ROWS) {
      const row = document.createElement('div');
      row.className = 'vh-vis-row';
      row.dataset.kind = kind;

      const name = document.createElement('span');
      name.className = 'vh-vis-label';
      name.textContent = `${icon}  ${label}`;

      const show = ViewportHeader.checkbox(objectTypes[kind].show, (on) => {
        objectTypes[kind].show = on;
        // A hidden type can't be picked either (typePickable requires show), so
        // grey the Select box out — but keep its stored value so re-showing
        // restores the previous selectability.
        sel.disabled = !on;
        saveObjectTypePrefs();
      });
      show.dataset.role = 'show';

      const sel = ViewportHeader.checkbox(objectTypes[kind].select, (on) => {
        objectTypes[kind].select = on;
        saveObjectTypePrefs();
      });
      sel.dataset.role = 'select';
      sel.disabled = !objectTypes[kind].show;

      row.append(name, show, sel);
      panel.appendChild(row);
    }
  }

  /** Populate the panel with rows initialized from the current `overlays`. */
  private buildOverlaysPanel(panel: HTMLElement): void {
    const heading = document.createElement('div');
    heading.className = 'vh-overlays-heading';
    heading.textContent = 'Overlays';
    panel.appendChild(heading);

    // Checkboxes.
    for (const [key, label] of CHECK_ROWS) {
      const row = document.createElement('label');
      row.className = 'vh-overlays-row';
      row.dataset.overlay = key;
      const span = document.createElement('span');
      span.textContent = label;
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = overlays[key];
      box.addEventListener('change', () => {
        overlays[key] = box.checked;
        if (key === 'cursor3d') this.onCursorVisibility?.(box.checked);
        saveOverlayPrefs();
      });
      row.append(span, box);
      panel.appendChild(row);
    }

    // Color rows.
    for (const [key, label] of COLOR_ROWS) {
      const row = document.createElement('label');
      row.className = 'vh-overlays-row';
      row.dataset.color = key;
      const span = document.createElement('span');
      span.textContent = label;
      const inp = document.createElement('input');
      inp.type = 'color';
      inp.value = toHex(overlays[key]);
      inp.addEventListener('input', () => {
        overlays[key] = fromHex(inp.value);
        saveOverlayPrefs();
      });
      row.append(span, inp);
      panel.appendChild(row);
    }

    // Grid Fade slider with live readout.
    const fadeRow = document.createElement('label');
    fadeRow.className = 'vh-overlays-row vh-overlays-slider';
    const fadeLabel = document.createElement('span');
    fadeLabel.textContent = 'Grid Fade';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '20';
    range.max = '500';
    range.step = '5';
    range.value = String(overlays.gridFade);
    const readout = document.createElement('span');
    readout.className = 'vh-overlays-readout';
    readout.textContent = String(Math.round(overlays.gridFade));
    range.addEventListener('input', () => {
      overlays.gridFade = Number(range.value);
      readout.textContent = String(Math.round(overlays.gridFade));
      saveOverlayPrefs();
    });
    fadeRow.append(fadeLabel, range, readout);
    panel.appendChild(fadeRow);
  }

  update(): void {
    const mode = this.scene.editMode ? 'edit' : 'object';
    const sig = `${mode}#${this.scene.transformOrientation}#${this.scene.pivotMode}#${snapState.enabled}#${xrayState.enabled}`;
    if (sig !== this.lastSig) {
      this.lastSig = sig;
      this.modeSel.value = mode;
      this.orientSel.value = this.scene.transformOrientation;
      this.pivotSel.value = this.scene.pivotMode;
      this.snapBtn.classList.toggle('vh-on', snapState.enabled);
      this.xrayBtn.classList.toggle('vh-on', xrayState.enabled);
    }
    this.shadingMenu.update();
  }

  // --- element helpers -------------------------------------------------------
  private static group(cls: string, ...children: HTMLElement[]): HTMLDivElement {
    const g = document.createElement('div');
    g.className = cls;
    g.append(...children);
    return g;
  }

  private static spacer(): HTMLDivElement {
    const s = document.createElement('div');
    s.className = 'vh-spacer';
    return s;
  }

  private static select(cls: string, opts: [string, string][], onChange: (v: string) => void): HTMLSelectElement {
    const sel = document.createElement('select');
    sel.className = `vh-select ${cls}`;
    for (const [value, label] of opts) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      sel.append(o);
    }
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  }

  private static button(cls: string, label: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = `vh-btn ${cls}`;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  private static checkbox(checked: boolean, onChange: (on: boolean) => void): HTMLInputElement {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = checked;
    box.addEventListener('change', () => onChange(box.checked));
    return box;
  }
}
