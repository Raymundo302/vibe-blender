import type { Scene } from '../core/scene/Scene';
import type { ShadingMenu } from './shadingMenu';
import { snapState } from '../core/snap';
import { xrayState } from '../render/passes/elementPickPass';
import { setTip } from './tooltip';
import './viewportHeader.css';

/**
 * The 3D Viewport's area header controls (Blender's viewport header), laid out
 * left / center / right and travelling with the viewport editor (it's the
 * editor's `headerExtra`, so it sits right of the "3D Viewport ▾" editor-type
 * selector):
 *   LEFT   — mode selector (Object / Edit)
 *   CENTER — transform orientation ▾ · pivot point ▾ · 🧲 Snap
 *   RIGHT  — 👓 X-ray · shading dropdown
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
  private lastSig = '';

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

    // --- RIGHT: x-ray · shading ---------------------------------------------
    this.xrayBtn = ViewportHeader.button('vh-xray', '👓 X-ray', () => {
      xrayState.enabled = !xrayState.enabled;
      this.update();
    });
    setTip(this.xrayBtn, 'X-ray / select-through', 'Alt+Z');
    const right = ViewportHeader.group('vh-right', this.xrayBtn, shadingMenu.element);

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
}
