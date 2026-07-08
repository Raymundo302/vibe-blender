import type { Scene } from '../core/scene/Scene';
import type { Renderer } from '../render/Renderer';
import { snapState } from '../core/snap';
import { xrayState } from '../render/passes/elementPickPass';
import { sculptState } from '../tools/sculptBrushes';
import { openThemePicker } from './themePicker';
import type { CursorOverlay } from './cursorOverlay';
import { overlays, saveOverlayPrefs, type OverlayPrefs } from '../render/overlayPrefs';
import { autoKeyState } from './timeline';
import './overlaysMenu.css';

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
  private readonly pivotEl: HTMLButtonElement;
  private readonly lightsEl: HTMLButtonElement;
  private readonly autoKeyEl: HTMLButtonElement;
  private lastSig = '';

  constructor(
    private readonly scene: Scene,
    private readonly renderer: Renderer,
    actions: TopbarActions,
    private readonly cursorOverlay: CursorOverlay,
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

    // Overlays dropdown (P12-2): a checkbox popover toggling viewport
    // decorations (grid / origin points / icons / frustums / 3D cursor).
    const overlaysBtn = Topbar.makeButton('⬒ Overlays', 'overlays', () => {
      this.toggleOverlaysMenu(overlaysBtn);
    });
    overlaysBtn.title = 'Viewport overlays';

    // Pivot dropdown (P12-2): median point ↔ 3D cursor. A viewport setting
    // (like shading mode) — writes scene.pivotMode, never undoable.
    const pivot = Topbar.makeButton('Pivot: Median ▾', 'pivot', () => {
      this.togglePivotMenu(pivot);
    });
    pivot.title = 'Transform pivot point';
    this.pivotEl = pivot;

    // 💡 Lights toggle (P12-2): flips visibility on ALL light objects at once.
    // Off if any light is on (turn them all off), else turn them all on. Not
    // undoable; the highlight reflects whether any light is currently visible.
    const lights = Topbar.makeButton('💡', 'lights-toggle', () => {
      this.toggleAllLights();
      this.update();
    });
    lights.title = 'Toggle all lights';
    this.lightsEl = lights;

    // ⏺ Auto-key toggle (P15-3): when on, confirming a G/R/S transform in
    // Object Mode auto-inserts LocRotScale keys (the Timeline pane polls the
    // undo stack). Runtime-only flag in the timeline module — never on Scene.
    const autoKey = Topbar.makeButton('⏺', 'autokey', () => {
      autoKeyState.enabled = !autoKeyState.enabled;
      this.update();
    });
    autoKey.title = 'Auto-Keying: insert keyframes on transform';
    this.autoKeyEl = autoKey;

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
    // 🎨 opens the theme picker popup, anchored under the button.
    const themeBtn = Topbar.makeButton('🎨', 'theme-picker', () => openThemePicker(themeBtn));
    themeBtn.title = 'Theme';

    // "?" opens the shortcut cheat-sheet (same overlay as F1).
    const helpBtn = Topbar.makeButton('?', 'help', () => actions.toggleHelp());
    helpBtn.title = 'Keyboard shortcuts (F1)';

    this.statusEl = document.createElement('span');
    this.statusEl.className = 'topbar-status';

    // Action chips sit on the RIGHT, before the status span (P3 conventions).
    // The shading chip sits next to the mode chip on the left.
    root.append(title, chip, shading, snap, xray, overlaysBtn, pivot, lights, autoKey, spacer, saveBtn, openBtn, exportObjBtn, importObjBtn, renderBtn, themeBtn, helpBtn, this.statusEl);
    this.update();
  }

  /** Insert the workspace tab strip right after the app title. */
  mountTabs(tabs: HTMLElement): void {
    const root = document.getElementById('topbar') as HTMLElement;
    const title = root.querySelector('.topbar-title');
    title?.after(tabs);
  }

  // --- P12-2 dropdowns -------------------------------------------------------
  // One popover open at a time; a second click on the same button closes it.
  private openMenu: { root: HTMLElement; close: () => void } | null = null;

  /** Build + anchor a popover under `anchor`; teardown wired to outside-click,
   *  Escape, and re-click. Returns the root so callers can fill it with rows. */
  private popover(anchor: HTMLElement): HTMLDivElement {
    if (this.openMenu) { this.openMenu.close(); }
    const root = document.createElement('div');
    root.className = 'topbar-menu';
    document.body.appendChild(root);

    const close = (): void => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onOutside, true);
      root.remove();
      if (this.openMenu && this.openMenu.root === root) this.openMenu = null;
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    };
    const onOutside = (e: PointerEvent): void => {
      if (!root.contains(e.target as Node) && e.target !== anchor) close();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onOutside, true);
    this.openMenu = { root, close };

    // Position after the caller has appended rows (offsetWidth is then valid);
    // defer to a microtask via requestAnimationFrame keeps it simple here.
    requestAnimationFrame(() => {
      const r = anchor.getBoundingClientRect();
      const w = root.offsetWidth;
      const left = Math.max(4, Math.min(r.left, window.innerWidth - w - 4));
      const top = Math.min(r.bottom + 4, window.innerHeight - root.offsetHeight - 4);
      root.style.left = `${left}px`;
      root.style.top = `${Math.max(4, top)}px`;
    });
    return root;
  }

  private toggleOverlaysMenu(anchor: HTMLElement): void {
    if (this.openMenu) { this.openMenu.close(); return; }
    const root = this.popover(anchor);
    const heading = document.createElement('div');
    heading.className = 'topbar-menu-heading';
    heading.textContent = 'Overlays';
    root.appendChild(heading);

    const rows: [keyof OverlayPrefs, string][] = [
      ['grid', 'Grid'],
      ['originPoints', 'Origin Points'],
      ['icons', 'Light & Camera Icons'],
      ['frustums', 'Camera Frustums'],
      ['cursor3d', '3D Cursor'],
    ];
    for (const [key, label] of rows) {
      const row = document.createElement('label');
      row.className = 'topbar-menu-check';
      row.dataset.overlay = key;
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = overlays[key];
      const text = document.createElement('span');
      text.textContent = label;
      box.addEventListener('change', () => {
        overlays[key] = box.checked;
        if (key === 'cursor3d') this.cursorOverlay.visible = box.checked;
        saveOverlayPrefs();
      });
      row.append(box, text);
      root.appendChild(row);
    }
  }

  private togglePivotMenu(anchor: HTMLElement): void {
    if (this.openMenu) { this.openMenu.close(); return; }
    const root = this.popover(anchor);
    const heading = document.createElement('div');
    heading.className = 'topbar-menu-heading';
    heading.textContent = 'Pivot Point';
    root.appendChild(heading);

    const options: [Scene['pivotMode'], string][] = [
      ['median', 'Median Point'],
      ['cursor', '3D Cursor'],
    ];
    for (const [mode, label] of options) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'topbar-menu-row' + (this.scene.pivotMode === mode ? ' topbar-menu-active' : '');
      btn.dataset.pivot = mode;
      btn.textContent = (this.scene.pivotMode === mode ? '✓ ' : '') + label;
      btn.addEventListener('click', () => {
        this.scene.pivotMode = mode; // viewport setting — no undo entry
        this.openMenu?.close();
        this.update();
      });
      root.appendChild(btn);
    }
  }

  /** Flip visibility on every light: all off if any is on, else all on. */
  private toggleAllLights(): void {
    const lights = this.scene.objects.filter((o) => o.kind === 'light');
    if (lights.length === 0) return;
    const anyOn = lights.some((l) => l.visible);
    for (const l of lights) l.visible = !anyOn;
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
    const pivot = this.scene.pivotMode;
    const lights = this.scene.objects.filter((o) => o.kind === 'light');
    const lightsOn = lights.some((l) => l.visible);
    const sig = `${active ? active.name : ''}#${count}#${mode}#${shading}#${snapState.enabled}#${xrayState.enabled}#${pivot}#${lightsOn}#${autoKeyState.enabled}`;
    if (sig === this.lastSig) return;
    this.lastSig = sig;

    // Auto-key ⏺ glows red when on.
    this.autoKeyEl.classList.toggle('topbar-btn-on', autoKeyState.enabled);
    this.autoKeyEl.setAttribute('aria-pressed', String(autoKeyState.enabled));
    this.autoKeyEl.style.color = autoKeyState.enabled ? '#ff3b30' : '';

    this.pivotEl.textContent = pivot === 'cursor' ? 'Pivot: 3D Cursor ▾' : 'Pivot: Median ▾';
    this.lightsEl.classList.toggle('topbar-btn-on', lightsOn);
    this.lightsEl.setAttribute('aria-pressed', String(lightsOn));

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
