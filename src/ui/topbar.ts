import type { Scene } from '../core/scene/Scene';

/**
 * Callbacks the topbar chip-buttons fire. Phase 3 tasks extend this as they add
 * more buttons (import/export/help); keep every entry point explicit — no globals.
 */
export interface TopbarActions {
  saveScene(): void;
  openScene(): void;
  exportObj(): void;
  importObj(): void;
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
  private lastSig = '';

  constructor(private readonly scene: Scene, actions: TopbarActions) {
    const root = document.getElementById('topbar') as HTMLElement;
    root.replaceChildren();

    const title = document.createElement('span');
    title.className = 'topbar-title';
    title.textContent = 'Vibe Blender';

    const chip = document.createElement('span');
    chip.className = 'topbar-chip';
    this.chipEl = chip;

    const spacer = document.createElement('div');
    spacer.className = 'topbar-spacer';

    const saveBtn = Topbar.makeButton('Save', 'save-scene', () => actions.saveScene());
    const openBtn = Topbar.makeButton('Open', 'open-scene', () => actions.openScene());
    const exportObjBtn = Topbar.makeButton('Export OBJ', 'export-obj', () => actions.exportObj());
    const importObjBtn = Topbar.makeButton('Import OBJ', 'import-obj', () => actions.importObj());

    this.statusEl = document.createElement('span');
    this.statusEl.className = 'topbar-status';

    // Action chips sit on the RIGHT, before the status span (P3 conventions).
    root.append(title, chip, spacer, saveBtn, openBtn, exportObjBtn, importObjBtn, this.statusEl);
    this.update();
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
    const mode = edit ? `Edit Mode · ${edit.elementMode}` : 'Object Mode';
    const sig = `${active ? active.name : ''}#${count}#${mode}`;
    if (sig === this.lastSig) return;
    this.lastSig = sig;

    this.chipEl.textContent = mode;
    this.chipEl.classList.toggle('topbar-chip-edit', !!edit);
    const noun = count === 1 ? 'object' : 'objects';
    this.statusEl.textContent = active
      ? `${active.name} — ${count} ${noun}`
      : `${count} ${noun}`;
  }
}
