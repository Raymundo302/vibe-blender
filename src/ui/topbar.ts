import type { Scene } from '../core/scene/Scene';
import type { Renderer } from '../render/Renderer';
import { snapState } from '../core/snap';
import { xrayState } from '../render/passes/elementPickPass';
import { sculptState } from '../tools/sculptBrushes';

/**
 * Callbacks the topbar chip-buttons fire. Phase 3 tasks extend this as they add
 * more buttons (import/export/help); keep every entry point explicit — no globals.
 */
export interface TopbarActions {
  saveScene(): void;
  openScene(): void;
  exportObj(): void;
  importObj(): void;
  /** Toggle the keyboard-shortcut overlay (also bound to F1). */
  toggleHelp(): void;
  /** Toggle the path-traced render window (F12's reliable stand-in). */
  toggleRender(): void;
}

/**
 * The application header bar. Fills the existing #topbar mount with an app
 * title, a mode chip, right-side action buttons (Save / Open), and a live
 * status showing the active object name + object count.
 *
 * Not a shell Panel — it lives outside the sidebar — so main.ts calls update()
 * directly in the frame loop. update() uses the same signature-diff pattern the
 * panels use: it only rewrites the status text when the name or count changed.
 */
export class Topbar {
  private readonly statusEl: HTMLSpanElement;
  private readonly chipEl: HTMLSpanElement;
  private readonly shadingEl: HTMLButtonElement;
  private readonly snapEl: HTMLButtonElement;
  private readonly xrayEl: HTMLButtonElement;
  private lastSig = '';

  constructor(
    private readonly scene: Scene,
    private readonly renderer: Renderer,
    actions: TopbarActions,
  ) {
    const root = document.getElementById('topbar') as HTMLElement;
    root.replaceChildren();

    const title = document.createElement('span');
    title.className = 'topbar-title';
    title.textContent = 'Vibe Blender';

    const chip = document.createElement('span');
    chip.className = 'topbar-chip';
    this.chipEl = chip;

    // Shading-mode chip: clickable, cycles matcap → wireframe → studio like Z.
    const shading = Topbar.makeButton('Matcap', 'shading-mode', () => {
      this.renderer.cycleShadingMode();
      this.update();
    });
    this.shadingEl = shading;

    // Snap chip: 🧲 magnet toggling grid snapping (also Shift+Tab). Clickable;
    // its highlighted state mirrors snapState.enabled (updated every frame).
    const snap = Topbar.makeButton('🧲 Snap', 'snap-toggle', () => {
      snapState.enabled = !snapState.enabled;
      this.update();
    });
    snap.title = 'Grid snapping (Shift+Tab)';
    this.snapEl = snap;

    // X-ray chip: select-through toggle (also Alt+Z). Highlighted state mirrors
    // xrayState.enabled (updated every frame).
    const xray = Topbar.makeButton('👓 X-ray', 'xray-toggle', () => {
      xrayState.enabled = !xrayState.enabled;
      this.update();
    });
    xray.title = 'X-ray / select-through (Alt+Z)';
    this.xrayEl = xray;

    const spacer = document.createElement('div');
    spacer.className = 'topbar-spacer';

    const saveBtn = Topbar.makeButton('Save', 'save-scene', () => actions.saveScene());
    const openBtn = Topbar.makeButton('Open', 'open-scene', () => actions.openScene());
    const exportObjBtn = Topbar.makeButton('Export OBJ', 'export-obj', () => actions.exportObj());
    const importObjBtn = Topbar.makeButton('Import OBJ', 'import-obj', () => actions.importObj());
    // 🎬 opens the path-traced render window. Also bound to F12, but browsers
    // reserve F12 for devtools, so the button is the reliable entry point.
    const renderBtn = Topbar.makeButton('🎬 Render', 'render', () => actions.toggleRender());
    renderBtn.title = 'Render image (F12)';
    // "?" opens the shortcut cheat-sheet (same overlay as F1).
    const helpBtn = Topbar.makeButton('?', 'help', () => actions.toggleHelp());
    helpBtn.title = 'Keyboard shortcuts (F1)';

    this.statusEl = document.createElement('span');
    this.statusEl.className = 'topbar-status';

    // Action chips sit on the RIGHT, before the status span (P3 conventions).
    // The shading chip sits next to the mode chip on the left.
    root.append(title, chip, shading, snap, xray, spacer, saveBtn, openBtn, exportObjBtn, importObjBtn, renderBtn, helpBtn, this.statusEl);
    this.update();
  }

  /** Insert the workspace tab strip right after the app title. */
  mountTabs(tabs: HTMLElement): void {
    const root = document.getElementById('topbar') as HTMLElement;
    const title = root.querySelector('.topbar-title');
    title?.after(tabs);
  }

  private static makeButton(label: string, action: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'topbar-btn';
    btn.dataset.action = action;
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  /** Called every animation frame; cheap no-op when nothing visible changed. */
  update(): void {
    const active = this.scene.activeObject;
    const count = this.scene.objects.length;
    const edit = this.scene.editMode;
    // A sculpt brush is a tool overlay inside Edit Mode — the chip reflects it.
    const sculpt = edit && sculptState.tool !== 'none' ? sculptState.tool : null;
    const mode = edit
      ? sculpt ? `Sculpt · ${sculpt}` : `Edit Mode · ${edit.elementMode}`
      : 'Object Mode';
    const shading = this.renderer.shadingMode;
    const sig = `${active ? active.name : ''}#${count}#${mode}#${shading}#${snapState.enabled}#${xrayState.enabled}`;
    if (sig === this.lastSig) return;
    this.lastSig = sig;

    this.chipEl.textContent = mode;
    this.chipEl.classList.toggle('topbar-chip-edit', !!edit);
    this.snapEl.classList.toggle('topbar-btn-on', snapState.enabled);
    this.snapEl.setAttribute('aria-pressed', String(snapState.enabled));
    this.xrayEl.classList.toggle('topbar-btn-on', xrayState.enabled);
    this.xrayEl.setAttribute('aria-pressed', String(xrayState.enabled));
    // Capitalize the shading label for display (matcap → Matcap).
    this.shadingEl.textContent = shading.charAt(0).toUpperCase() + shading.slice(1);
    const noun = count === 1 ? 'object' : 'objects';
    this.statusEl.textContent = active
      ? `${active.name} — ${count} ${noun}`
      : `${count} ${noun}`;
  }
}
