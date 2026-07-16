import type { Scene } from '../core/scene/Scene';
import { openThemePicker } from './themePicker';
import { autoKeyState } from './timeline';
import { setTip } from './tooltip';
import { APP_VERSION } from '../version';
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
  exportIges(): void;
  importIges(): void;
  /** Toggle the keyboard-shortcut overlay (also bound to F1). */
  toggleHelp(): void;
  /** Toggle the path-traced render window (F12's reliable stand-in). */
  toggleRender(): void;
  /** Open the Render Animation modal (WebM / PNG-sequence export, Ctrl+F12). */
  toggleRenderAnimation(): void;
  /** Undo / redo the last command (Edit menu; mirrors Ctrl+Z / Ctrl+Shift+Z). */
  undo(): void;
  redo(): void;
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
  private readonly autoKeyEl: HTMLButtonElement;
  private readonly fileEl: HTMLButtonElement;
  private lastSig = '';
  private lastDirty = false;

  constructor(
    private readonly scene: Scene,
    private readonly actions: TopbarActions,
  ) {
    const root = document.getElementById('topbar') as HTMLElement;
    root.replaceChildren();

    const title = document.createElement('span');
    title.className = 'topbar-title';
    title.textContent = 'Vibe Blender';

    // (Overlays dropdown moved to the 3D viewport header — see viewportHeader.ts.)

    // (💡 Lights moved to the viewport-header Object Types dropdown — lights
    // visibility now lives with the other per-type show/select toggles.)

    // ⏺ Auto-key toggle (P15-3): when on, confirming a G/R/S transform in
    // Object Mode auto-inserts LocRotScale keys (the Timeline pane polls the
    // undo stack). Runtime-only flag in the timeline module — never on Scene.
    const autoKey = Topbar.makeButton('⏺ Auto-Key', 'autokey', () => {
      autoKeyState.enabled = !autoKeyState.enabled;
      this.update();
    });
    setTip(autoKey, 'Auto-Keying: insert keyframes on transform');
    this.autoKeyEl = autoKey;

    // Blender-style top menu bar (File · Edit · Render · Window · Help), pinned
    // to the far left. Each is a dropdown built with the shared popover machinery
    // (like Overlays/Pivot). The dirty dot (UR14-1 item 18) lives on File — the
    // home for save-state.
    const fileBtn = Topbar.makeMenuButton('File', 'file-menu', () => this.toggleFileMenu(fileBtn));
    setTip(fileBtn, 'File — Save / Open / Import / Export');
    this.fileEl = fileBtn;
    const editBtn = Topbar.makeMenuButton('Edit', 'edit-menu', () => this.toggleEditMenu(editBtn));
    setTip(editBtn, 'Edit — Undo / Redo');
    const renderMenuBtn = Topbar.makeMenuButton('Render', 'render-menu', () => this.toggleRenderMenu(renderMenuBtn));
    setTip(renderMenuBtn, 'Render — Image / Animation');
    const windowBtn = Topbar.makeMenuButton('Window', 'window-menu', () => this.toggleWindowMenu(windowBtn));
    setTip(windowBtn, 'Window — Fullscreen / Theme');
    const helpMenuBtn = Topbar.makeMenuButton('Help', 'help-menu', () => this.toggleHelpMenu(helpMenuBtn));
    setTip(helpMenuBtn, 'Help — Shortcuts / About');

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

    // Visually separated clusters (spacing + hairline):
    //   [Brand + menu bar] · [Workspace tabs] · [Mode + toggles] · [Render]
    //   … spacer … [status] · [theme / help]
    // The menu bar (File/Edit/Render/Window/Help) sits on the far left next to
    // the title; the workspace tab strip is injected into cl-tabs by mountTabs().
    const clBrand = Topbar.cluster('cl-brand', title, fileBtn, editBtn, renderMenuBtn, windowBtn, helpMenuBtn);
    const clTabs = Topbar.cluster('cl-tabs');
    // Mode chip, Snap, X-ray and Pivot moved into the 3D Viewport header
    // (viewportHeader.ts); the topbar keeps the scene-wide toggles.
    const clView = Topbar.cluster('cl-view', autoKey);
    const clRender = Topbar.cluster('cl-render', renderBtn, renderAnimBtn);
    const clRight = Topbar.cluster('cl-right', themeBtn, helpBtn);

    root.append(
      clBrand, Topbar.sep(),
      clTabs, Topbar.sep(),
      clView, Topbar.sep(),
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

  /** Insert the workspace tab strip into its dedicated cluster (right of the
   *  brand + menu bar). */
  mountTabs(tabs: HTMLElement): void {
    const root = document.getElementById('topbar') as HTMLElement;
    const clTabs = root.querySelector('[data-cluster="cl-tabs"]');
    clTabs?.appendChild(tabs);
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
      // NB-D1: NURBS interchange — curves/surfaces as IGES 126/128 (+trims).
      ['import-iges', 'Import IGES', () => this.actions.importIges()],
      ['export-iges', 'Export IGES', () => this.actions.exportIges()],
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

  /** Shared label→action dropdown builder for the Edit / Render / Window / Help
   *  menus (File keeps its own so its per-row action ids stay stable). Each row
   *  fires its `run` then closes the menu; `disabled` greys a row out. */
  private simpleMenu(
    anchor: HTMLElement,
    heading: string,
    items: { label: string; action: string; run: () => void; disabled?: boolean }[],
  ): void {
    if (this.openMenu) { this.openMenu.close(); return; }
    const root = this.popover(anchor);
    const h = document.createElement('div');
    h.className = 'topbar-menu-heading';
    h.textContent = heading;
    root.appendChild(h);
    for (const it of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'topbar-menu-row';
      btn.dataset.action = it.action;
      btn.textContent = it.label;
      if (it.disabled) btn.disabled = true;
      btn.addEventListener('click', () => { this.openMenu?.close(); it.run(); });
      root.appendChild(btn);
    }
  }

  /** Edit menu: Undo / Redo (mirrors Ctrl+Z / Ctrl+Shift+Z). */
  private toggleEditMenu(anchor: HTMLElement): void {
    this.simpleMenu(anchor, 'Edit', [
      { label: 'Undo', action: 'edit-undo', run: () => this.actions.undo() },
      { label: 'Redo', action: 'edit-redo', run: () => this.actions.redo() },
    ]);
  }

  /** Render menu: still image (F12) / animation (Ctrl+F12). */
  private toggleRenderMenu(anchor: HTMLElement): void {
    this.simpleMenu(anchor, 'Render', [
      { label: 'Render Image', action: 'render-image', run: () => this.actions.toggleRender() },
      { label: 'Render Animation', action: 'render-anim', run: () => this.actions.toggleRenderAnimation() },
    ]);
  }

  /** Window menu: browser fullscreen + theme picker. */
  private toggleWindowMenu(anchor: HTMLElement): void {
    this.simpleMenu(anchor, 'Window', [
      { label: 'Toggle Fullscreen', action: 'toggle-fullscreen', run: () => Topbar.toggleFullscreen() },
      { label: 'Theme…', action: 'open-theme', run: () => openThemePicker(anchor) },
    ]);
  }

  /** Help menu: keyboard shortcuts + an About row carrying the version. */
  private toggleHelpMenu(anchor: HTMLElement): void {
    this.simpleMenu(anchor, 'Help', [
      { label: 'Keyboard Shortcuts', action: 'help-shortcuts', run: () => this.actions.toggleHelp() },
      { label: `About — Vibe Blender v${APP_VERSION}`, action: 'help-about', run: () => this.actions.toggleHelp() },
    ]);
  }

  /** Enter/exit browser fullscreen (best-effort; ignored where unsupported). */
  private static toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void document.documentElement.requestFullscreen().catch(() => {});
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

  private static makeButton(label: string, action: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'topbar-btn';
    btn.dataset.action = action;
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  /** A flat menu-bar button (File/Edit/Render/Window/Help) — borderless text, not
   *  the pill-shaped chip that {@link makeButton} produces. */
  private static makeMenuButton(label: string, action: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'topbar-menu-btn';
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
    const sig = `${active ? active.name : ''}#${count}#${autoKeyState.enabled}`;
    if (sig === this.lastSig) return;
    this.lastSig = sig;

    // Auto-key ⏺ glows red when on.
    this.autoKeyEl.classList.toggle('topbar-btn-on', autoKeyState.enabled);
    this.autoKeyEl.setAttribute('aria-pressed', String(autoKeyState.enabled));
    this.autoKeyEl.style.color = autoKeyState.enabled ? '#ff3b30' : '';

    const noun = count === 1 ? 'object' : 'objects';
    this.statusEl.textContent = active
      ? `${active.name} — ${count} ${noun}`
      : `${count} ${noun}`;
  }
}
