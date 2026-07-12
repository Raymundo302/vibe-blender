import type { Scene } from '../core/scene/Scene';
import { snapState } from '../core/snap';
import { xrayState } from '../render/passes/elementPickPass';
import { sculptState } from '../tools/sculptBrushes';
import { openThemePicker } from './themePicker';
import type { CursorOverlay } from './cursorOverlay';
import { overlays, saveOverlayPrefs, type OverlayPrefs } from '../render/overlayPrefs';
import { autoKeyState } from './timeline';
import { setTip } from './tooltip';
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
  /** Open the Render Animation modal (WebM / PNG-sequence export, Ctrl+F12). */
  toggleRenderAnimation(): void;
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
  private readonly snapEl: HTMLButtonElement;
  private readonly xrayEl: HTMLButtonElement;
  private readonly pivotEl: HTMLButtonElement;
  private readonly lightsEl: HTMLButtonElement;
  private readonly autoKeyEl: HTMLButtonElement;
  private readonly fileEl: HTMLButtonElement;
  private lastSig = '';
  private lastDirty = false;

  constructor(
    private readonly scene: Scene,
    private readonly actions: TopbarActions,
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

    // Snap chip: 🧲 magnet toggling grid snapping (also Shift+Tab). Clickable;
    // its highlighted state mirrors snapState.enabled (updated every frame).
    const snap = Topbar.makeButton('🧲 Snap', 'snap-toggle', () => {
      snapState.enabled = !snapState.enabled;
      this.update();
    });
    setTip(snap, 'Grid snapping', 'Shift+Tab');
    this.snapEl = snap;

    // X-ray chip: select-through toggle (also Alt+Z). Highlighted state mirrors
    // xrayState.enabled (updated every frame).
    const xray = Topbar.makeButton('👓 X-ray', 'xray-toggle', () => {
      xrayState.enabled = !xrayState.enabled;
      this.update();
    });
    setTip(xray, 'X-ray / select-through', 'Alt+Z');
    this.xrayEl = xray;

    // Overlays dropdown (P12-2): a checkbox popover toggling viewport
    // decorations (grid / origin points / icons / frustums / 3D cursor).
    const overlaysBtn = Topbar.makeButton('⬒ Overlays', 'overlays', () => {
      this.toggleOverlaysMenu(overlaysBtn);
    });
    setTip(overlaysBtn, 'Viewport overlays');

    // Pivot dropdown (P12-2): median point ↔ 3D cursor. A viewport setting
    // (like shading mode) — writes scene.pivotMode, never undoable.
    const pivot = Topbar.makeButton('Pivot: Median ▾', 'pivot', () => {
      this.togglePivotMenu(pivot);
    });
    setTip(pivot, 'Transform pivot point');
    this.pivotEl = pivot;

    // 💡 Lights toggle (P12-2): flips visibility on ALL light objects at once.
    // Off if any light is on (turn them all off), else turn them all on. Not
    // undoable; the highlight reflects whether any light is currently visible.
    const lights = Topbar.makeButton('💡 Lights', 'lights-toggle', () => {
      this.toggleAllLights();
      this.update();
    });
    setTip(lights, 'Toggle all lights');
    this.lightsEl = lights;

    // ⏺ Auto-key toggle (P15-3): when on, confirming a G/R/S transform in
    // Object Mode auto-inserts LocRotScale keys (the Timeline pane polls the
    // undo stack). Runtime-only flag in the timeline module — never on Scene.
    const autoKey = Topbar.makeButton('⏺ Auto-Key', 'autokey', () => {
      autoKeyState.enabled = !autoKeyState.enabled;
      this.update();
    });
    setTip(autoKey, 'Auto-Keying: insert keyframes on transform');
    this.autoKeyEl = autoKey;

    // UR14-2 item 5: Save / Open / Import OBJ / Export OBJ collapse into ONE
    // "File ▾" menu button (the topbar popover pattern, like Overlays/Pivot).
    // The dirty dot (UR14-1 item 18) moves onto this button — it's now the home
    // for save-state.
    const fileBtn = Topbar.makeButton('File ▾', 'file-menu', () => this.toggleFileMenu(fileBtn));
    setTip(fileBtn, 'File — Save / Open / Import / Export');
    this.fileEl = fileBtn;

    // 🎬 opens the path-traced render window. Also bound to F12, but browsers
    // reserve F12 for devtools, so the button is the reliable entry point.
    const renderBtn = Topbar.makeButton('🎬 Render', 'render', () => actions.toggleRender());
    setTip(renderBtn, 'Render image', 'F12');
    // 🎞 opens the Render Animation modal (WebM video / PNG-sequence export).
    const renderAnimBtn = Topbar.makeButton('🎞', 'render-animation', () => actions.toggleRenderAnimation());
    setTip(renderAnimBtn, 'Render Animation', 'Ctrl+F12');
    // 🎨 opens the theme picker popup, anchored under the button.
    const themeBtn = Topbar.makeButton('🎨', 'theme-picker', () => openThemePicker(themeBtn));
    setTip(themeBtn, 'Theme');

    // "?" opens the shortcut cheat-sheet (same overlay as F1).
    const helpBtn = Topbar.makeButton('?', 'help', () => actions.toggleHelp());
    setTip(helpBtn, 'Keyboard shortcuts', 'F1');

    this.statusEl = document.createElement('span');
    this.statusEl.className = 'topbar-status';

    const spacer = document.createElement('div');
    spacer.className = 'topbar-spacer';

    // UR14-2 item 5: four visually separated clusters (spacing + hairline).
    //   [Workspace tabs] · [Mode + viewport toggles] · [File] · [Render]
    //   … spacer … [status] · [theme / help]
    // The workspace tab strip is injected into the first cluster by mountTabs().
    const clWorkspace = Topbar.cluster('cl-workspace', title);
    const clView = Topbar.cluster('cl-view', chip, snap, xray, overlaysBtn, pivot, lights, autoKey);
    const clFile = Topbar.cluster('cl-file', fileBtn);
    const clRender = Topbar.cluster('cl-render', renderBtn, renderAnimBtn);
    const clRight = Topbar.cluster('cl-right', themeBtn, helpBtn);

    root.append(
      clWorkspace, Topbar.sep(),
      clView, Topbar.sep(),
      clFile, Topbar.sep(),
      clRender,
      spacer, this.statusEl, Topbar.sep(),
      clRight,
    );
    this.update();
  }

  /** A labelled flex cluster grouping related topbar controls. */
  private static cluster(id: string, ...children: HTMLElement[]): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'topbar-cluster';
    el.dataset.cluster = id;
    el.append(...children);
    return el;
  }

  /** A thin vertical hairline separating two clusters. */
  private static sep(): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'topbar-sep';
    return el;
  }

  /** Insert the workspace tab strip into the first cluster, after the title. */
  mountTabs(tabs: HTMLElement): void {
    const root = document.getElementById('topbar') as HTMLElement;
    const title = root.querySelector('.topbar-title');
    title?.after(tabs);
  }

  // --- UR14-2 File menu ------------------------------------------------------
  /** The File popover: Save / Open / Import OBJ / Export OBJ, each firing its
   *  action then closing. Same popover machinery as Overlays/Pivot. */
  private toggleFileMenu(anchor: HTMLElement): void {
    if (this.openMenu) { this.openMenu.close(); return; }
    const root = this.popover(anchor);
    const heading = document.createElement('div');
    heading.className = 'topbar-menu-heading';
    heading.textContent = 'File';
    root.appendChild(heading);

    const items: [string, string, () => void][] = [
      ['save-scene', 'Save', () => this.actions.saveScene()],
      ['open-scene', 'Open', () => this.actions.openScene()],
      ['import-obj', 'Import OBJ', () => this.actions.importObj()],
      ['export-obj', 'Export OBJ', () => this.actions.exportObj()],
    ];
    for (const [action, label, run] of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'topbar-menu-row';
      btn.dataset.action = action;
      btn.textContent = label;
      btn.addEventListener('click', () => {
        this.openMenu?.close();
        run();
      });
      root.appendChild(btn);
    }
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

  /**
   * UR14-1 item 18: reflect unsaved-edits state as a dot on the Save button.
   * Driven from main.ts's frame loop (undo position vs last save/load). Diffed
   * so the class only toggles when the state actually flips. `title` mirrors it
   * so the affordance is discoverable on hover.
   */
  setDirty(dirty: boolean): void {
    if (dirty === this.lastDirty) return;
    this.lastDirty = dirty;
    // The dirty dot lives on the File menu button (Save now lives inside it).
    this.fileEl.classList.toggle('topbar-dirty', dirty);
    setTip(this.fileEl, dirty
      ? 'Unsaved changes — File'
      : 'File — Save / Open / Import / Export');
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
    const pivot = this.scene.pivotMode;
    const lights = this.scene.objects.filter((o) => o.kind === 'light');
    const lightsOn = lights.some((l) => l.visible);
    const sig = `${active ? active.name : ''}#${count}#${mode}#${snapState.enabled}#${xrayState.enabled}#${pivot}#${lightsOn}#${autoKeyState.enabled}`;
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
    const noun = count === 1 ? 'object' : 'objects';
    this.statusEl.textContent = active
      ? `${active.name} — ${count} ${noun}`
      : `${count} ${noun}`;
  }
}
