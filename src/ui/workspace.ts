/**
 * Workspace/area system (Phase 4) — Blender's screen model, simplified to a
 * column grid: the workspace splits into resizable COLUMNS, each column into
 * resizable AREAS, and every area hosts one EDITOR (3D Viewport, Outliner,
 * Properties, ...) switchable from its header. Areas can go fullscreen.
 * Workspace tabs (Layout / Modeling / ...) each remember their own layout,
 * persisted to localStorage.
 *
 * The 3D Viewport is a SINGLETON editor: it wraps the one #viewport-wrap
 * (canvas + WebGL context survive DOM reparenting). Choosing "3D Viewport" in
 * another area SWAPS editors with wherever the viewport currently lives —
 * that's how you move it around.
 */

import { setTip } from './tooltip';

export interface EditorInstance {
  element: HTMLElement;
  update(): void;
  /** Optional right-aligned control cluster for the area header (e.g. the 3D
   *  viewport's shading dropdown). Re-parented with the editor. */
  headerExtra?: HTMLElement;
  /** Non-singleton editors are destroyed when switched away from. */
  destroy?(): void;
}

export interface EditorFactory {
  type: string;
  title: string;
  /** Singleton editors are parked (not destroyed) when switched away. */
  singleton?: boolean;
  create(): EditorInstance;
}

export interface AreaConfig { editor: string; size: number }
export interface ColumnConfig { size: number; areas: AreaConfig[] }
export interface WorkspaceConfig { name: string; columns: ColumnConfig[] }

// v2: Timeline docked in the default Layout (2026-07-09) — new key so stored
// v1 layouts don't hide the new default row.
const STORAGE_KEY = 'vibe-blender-workspaces-v2';

class Area {
  readonly root = document.createElement('section');
  private readonly body = document.createElement('div');
  private readonly select = document.createElement('select');
  /** Right-aligned host for the editor's headerExtra controls. */
  private readonly headerSlot = (() => {
    const d = document.createElement('div');
    d.className = 'wsp-area-header-extra';
    return d;
  })();
  private instance: EditorInstance | null = null;
  editorType = '';

  constructor(
    private readonly manager: WorkspaceManager,
    editor: string,
  ) {
    this.root.className = 'wsp-area';
    const header = document.createElement('header');
    header.className = 'wsp-area-header';
    this.select.className = 'wsp-area-select';
    for (const f of manager.factories) {
      const opt = document.createElement('option');
      opt.value = f.type;
      opt.textContent = f.title;
      this.select.append(opt);
    }
    this.select.addEventListener('change', () => manager.requestEditor(this, this.select.value));

    const fullBtn = document.createElement('button');
    fullBtn.className = 'wsp-area-full-btn';
    fullBtn.textContent = '⛶';
    setTip(fullBtn, 'Toggle fullscreen', 'Ctrl+Space');
    fullBtn.addEventListener('click', () => manager.toggleFullscreen(this));

    const menuBtn = document.createElement('button');
    menuBtn.className = 'wsp-area-menu-btn';
    menuBtn.textContent = '⋮';
    setTip(menuBtn, 'Area options — split / close');
    menuBtn.addEventListener('click', (e) => { e.stopPropagation(); this.openMenu(menuBtn); });

    header.append(this.select, this.headerSlot, fullBtn, menuBtn);
    this.body.className = 'wsp-area-body';
    this.root.append(header, this.body, this.makeCorner());
    this.setEditor(editor);
  }

  /** Blender's corner-drag widget (top-right): drag INTO the area to split
   *  (left = horizontal, down = vertical), drag OUT to merge over the adjacent
   *  area (up = the area above in this column, right = the next column if it is
   *  single-area). One gesture per pointerdown, resolved by dominant axis once
   *  a ~12px threshold is crossed. */
  private makeCorner(): HTMLElement {
    const corner = document.createElement('div');
    corner.className = 'wsp-area-corner';
    setTip(corner, 'Drag to split / merge areas');
    corner.addEventListener('pointerdown', (down) => {
      down.preventDefault();
      try { corner.setPointerCapture(down.pointerId); } catch { /* synthetic pointer */ }
      const startX = down.clientX, startY = down.clientY;
      const THRESH = 12;
      let resolved = false;
      const onMove = (move: PointerEvent): void => {
        if (resolved) return;
        const dx = move.clientX - startX, dy = move.clientY - startY;
        if (Math.abs(dx) < THRESH && Math.abs(dy) < THRESH) return;
        resolved = true;
        if (Math.abs(dx) >= Math.abs(dy)) {
          if (dx < 0) this.manager.splitArea(this, 'h'); // into the area → split
          else this.manager.mergeArea(this, 'right');    // out → merge neighbor
        } else {
          if (dy > 0) this.manager.splitArea(this, 'v'); // into the area → split
          else this.manager.mergeArea(this, 'up');       // out → merge neighbor
        }
      };
      const onUp = (): void => {
        corner.removeEventListener('pointermove', onMove);
        corner.removeEventListener('pointerup', onUp);
      };
      corner.addEventListener('pointermove', onMove);
      corner.addEventListener('pointerup', onUp);
    });
    return corner;
  }

  /** Detach the current editor (parking singletons so they survive). */
  release(): void {
    if (!this.instance) return;
    const oldFactory = this.manager.factory(this.editorType);
    if (oldFactory?.singleton) this.manager.parkSingleton(this.editorType, this.instance);
    else this.instance.destroy?.();
    this.instance.element.remove();
    this.instance.headerExtra?.remove();
    this.instance = null;
    this.editorType = '';
  }

  setEditor(type: string): void {
    if (type === this.editorType) return;
    this.release();
    this.editorType = type;
    this.select.value = type;
    this.instance = this.manager.instanceFor(type);
    this.body.append(this.instance.element);
    if (this.instance.headerExtra) this.headerSlot.append(this.instance.headerExtra);
  }

  update(): void {
    this.instance?.update();
  }

  /** Popup with Split Horizontal / Split Vertical / Close Area, styled like the
   *  app's other dropdowns (topbar-menu). Closes on Escape / outside click. */
  private menuCleanup: (() => void) | null = null;

  private openMenu(anchor: HTMLElement): void {
    if (this.menuCleanup) { this.closeMenu(); return; }
    const root = document.createElement('div');
    root.className = 'topbar-menu wsp-area-menu';
    document.body.appendChild(root);

    const rows: [action: string, label: string][] = [
      ['split-h', 'Split Horizontal'],
      ['split-v', 'Split Vertical'],
      ['close', 'Close Area'],
    ];
    for (const [action, label] of rows) {
      const row = document.createElement('button');
      row.className = 'topbar-menu-row';
      row.dataset.areaAction = action;
      row.textContent = label;
      row.addEventListener('click', () => {
        this.closeMenu();
        if (action === 'split-h') this.manager.splitArea(this, 'h');
        else if (action === 'split-v') this.manager.splitArea(this, 'v');
        else this.manager.closeArea(this);
      });
      root.appendChild(row);
    }

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); this.closeMenu(); }
    };
    const onOutside = (e: PointerEvent): void => {
      if (!root.contains(e.target as Node) && e.target !== anchor) this.closeMenu();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onOutside, true);
    this.menuCleanup = () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onOutside, true);
      root.remove();
    };

    requestAnimationFrame(() => {
      const r = anchor.getBoundingClientRect();
      root.style.top = `${r.bottom + 4}px`;
      root.style.left = `${Math.max(4, r.right - root.offsetWidth)}px`;
    });
  }

  private closeMenu(): void {
    this.menuCleanup?.();
    this.menuCleanup = null;
  }
}

export class WorkspaceManager {
  readonly factories: EditorFactory[];
  private readonly root: HTMLElement;
  private readonly workspaces: WorkspaceConfig[];
  private readonly tabButtons = new Map<string, HTMLButtonElement>();
  private areas: Area[] = [];
  private fullArea: Area | null = null;
  private singletonPark = new Map<string, EditorInstance>();
  active = '';

  constructor(root: HTMLElement, factories: EditorFactory[], workspaces: WorkspaceConfig[]) {
    this.root = root;
    this.factories = factories;
    this.workspaces = this.loadOverrides(workspaces);
    // Ctrl+Space fullscreens the hovered area, like Blender.
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && e.ctrlKey) {
        const hovered = this.areas.find((a) => a.root.matches(':hover'));
        if (hovered) {
          e.preventDefault();
          this.toggleFullscreen(hovered);
        }
      }
    });
    this.switchTo(this.workspaces[0].name);
  }

  factory(type: string): EditorFactory | undefined {
    return this.factories.find((f) => f.type === type);
  }

  instanceFor(type: string): EditorInstance {
    const parked = this.singletonPark.get(type);
    if (parked) {
      this.singletonPark.delete(type);
      return parked;
    }
    const f = this.factory(type);
    if (!f) throw new Error(`Unknown editor "${type}"`);
    return f.create();
  }

  parkSingleton(type: string, instance: EditorInstance): void {
    this.singletonPark.set(type, instance);
  }

  /** Editor switch with singleton-swap semantics (see module doc). */
  requestEditor(area: Area, type: string): void {
    const f = this.factory(type);
    if (f?.singleton) {
      const holder = this.areas.find((a) => a !== area && a.editorType === type);
      if (holder) {
        // Swap: the holder gives up the singleton (parked by release inside
        // setEditor) and takes this area's editor type; we take the singleton.
        const displaced = area.editorType;
        holder.setEditor(displaced);
        area.setEditor(type);
        this.persist();
        return;
      }
    }
    area.setEditor(type);
    this.persist();
  }

  toggleFullscreen(area: Area): void {
    if (this.fullArea === area) {
      area.root.classList.remove('wsp-area-fullscreen');
      this.fullArea = null;
    } else {
      this.fullArea?.root.classList.remove('wsp-area-fullscreen');
      area.root.classList.add('wsp-area-fullscreen');
      this.fullArea = area;
    }
  }

  get workspaceNames(): string[] {
    return this.workspaces.map((w) => w.name);
  }

  switchTo(name: string): void {
    const ws = this.workspaces.find((w) => w.name === name);
    if (!ws || name === this.active) return;
    this.captureCurrentLayout();
    this.active = name;
    this.fullArea = null;
    // Park singletons before tearing down so they survive the rebuild.
    for (const area of this.areas) area.release();
    this.areas = [];
    this.root.replaceChildren();
    this.buildLayout(ws);
    for (const [n, btn] of this.tabButtons) btn.classList.toggle('wsp-tab-active', n === name);
    this.persist();
  }

  /**
   * Split an area in two. 'v' inserts a new area directly below it in the same
   * column; 'h' inserts a new single-area column immediately to its right. The
   * source's flexGrow is halved between the two. The new area mirrors the
   * source's editor unless that editor is a singleton (e.g. the 3D Viewport) —
   * then it defaults to the outliner so the singleton is never duplicated.
   */
  splitArea(area: Area, dir: 'v' | 'h'): void {
    const ws = this.workspaces.find((w) => w.name === this.active);
    if (!ws) return;
    this.captureCurrentLayout();
    const pos = this.locate(area);
    if (!pos) return;
    const { ci, ai } = pos;
    const col = ws.columns[ci];
    const src = col.areas[ai];
    const f = this.factory(src.editor);
    const newType = f?.singleton ? 'outliner' : src.editor;
    if (dir === 'v') {
      const half = src.size / 2;
      src.size = half;
      col.areas.splice(ai + 1, 0, { editor: newType, size: half });
    } else {
      const half = col.size / 2;
      col.size = half;
      ws.columns.splice(ci + 1, 0, { size: half, areas: [{ editor: newType, size: 1 }] });
    }
    this.rebuildActive(ws);
  }

  /**
   * Close an area, dropping it from its column (neighbors renormalize their
   * flexGrow); an emptied column is removed. Refuses when it is the very last
   * area. Singletons the closed area hosted survive via release()'s parking.
   */
  closeArea(area: Area): void {
    const ws = this.workspaces.find((w) => w.name === this.active);
    if (!ws || this.areas.length <= 1) return; // never close the last area
    this.captureCurrentLayout();
    const pos = this.locate(area);
    if (!pos) return;
    const { ci, ai } = pos;
    const col = ws.columns[ci];
    col.areas.splice(ai, 1);
    if (col.areas.length === 0) ws.columns.splice(ci, 1);
    this.rebuildActive(ws);
  }

  /**
   * Merge an area over its neighbor (the corner-drag "out" gesture): 'up'
   * consumes the area directly above it in the same column; 'right' consumes the
   * next column but ONLY when that column holds exactly one area (the column
   * grid can't merge into a multi-area column). No-op when no valid neighbor —
   * the neighbor is simply closed, so this area's flexGrow renormalizes over it.
   */
  mergeArea(area: Area, dir: 'up' | 'right'): void {
    const colEls = [...this.root.querySelectorAll(':scope > .wsp-col')] as HTMLElement[];
    const pos = this.locate(area);
    if (!pos) return;
    const { ci, ai } = pos;
    let neighborEl: HTMLElement | null = null;
    if (dir === 'up') {
      if (ai <= 0) return; // top of the column — nothing above
      const areaEls = [...colEls[ci].querySelectorAll(':scope > .wsp-area')] as HTMLElement[];
      neighborEl = areaEls[ai - 1] ?? null;
    } else {
      const nextCol = colEls[ci + 1];
      if (!nextCol) return; // rightmost column
      const areaEls = [...nextCol.querySelectorAll(':scope > .wsp-area')] as HTMLElement[];
      if (areaEls.length !== 1) return; // can't merge into a multi-area column
      neighborEl = areaEls[0];
    }
    const neighbor = neighborEl && this.areas.find((a) => a.root === neighborEl);
    if (neighbor) this.closeArea(neighbor);
  }

  /** DOM position (column + area index) of an area, matching ws.columns order
   *  as captureCurrentLayout() reconstructs it. */
  private locate(area: Area): { ci: number; ai: number } | null {
    const colEls = [...this.root.querySelectorAll(':scope > .wsp-col')] as HTMLElement[];
    for (let ci = 0; ci < colEls.length; ci++) {
      const areaEls = [...colEls[ci].querySelectorAll(':scope > .wsp-area')] as HTMLElement[];
      const ai = areaEls.indexOf(area.root);
      if (ai >= 0) return { ci, ai };
    }
    return null;
  }

  /** Tear down and rebuild the active workspace from its (mutated) config —
   *  the same release → clear → buildLayout dance switchTo() uses. */
  private rebuildActive(ws: WorkspaceConfig): void {
    this.fullArea = null;
    for (const area of this.areas) area.release();
    this.areas = [];
    this.root.replaceChildren();
    this.buildLayout(ws);
    this.persist();
  }

  /** Renormalize column/area sizes to sum to 1. Flexbox distributes only a
   *  FRACTION of the free space when grow factors sum below 1 (spec behavior),
   *  so a close/merge that removes a 0.4-grow column would leave 40% of the
   *  window as dead space (Ray hit exactly this). Normalizing on every build
   *  also heals drifted stored configs. */
  private normalizeSizes(ws: WorkspaceConfig): void {
    const colSum = ws.columns.reduce((s, c) => s + (c.size > 0 ? c.size : 0), 0) || 1;
    for (const col of ws.columns) {
      col.size = (col.size > 0 ? col.size : 0.01) / colSum;
      const areaSum = col.areas.reduce((s, a) => s + (a.size > 0 ? a.size : 0), 0) || 1;
      for (const a of col.areas) a.size = (a.size > 0 ? a.size : 0.01) / areaSum;
    }
  }

  private buildLayout(ws: WorkspaceConfig): void {
    this.normalizeSizes(ws);
    ws.columns.forEach((col, ci) => {
      if (ci > 0) this.root.append(this.makeGutter('v', ci));
      const colEl = document.createElement('div');
      colEl.className = 'wsp-col';
      colEl.style.flexGrow = String(col.size);
      col.areas.forEach((areaCfg, ai) => {
        if (ai > 0) colEl.append(this.makeGutter('h', ci, ai));
        const area = new Area(this, areaCfg.editor);
        area.root.style.flexGrow = String(areaCfg.size);
        this.areas.push(area);
        colEl.append(area.root);
      });
      this.root.append(colEl);
    });
  }

  /** Drag a gutter to trade flex-grow between the two adjacent columns/areas. */
  private makeGutter(dir: 'v' | 'h', ...key: number[]): HTMLElement {
    const g = document.createElement('div');
    g.className = dir === 'v' ? 'wsp-gutter wsp-gutter-v' : 'wsp-gutter wsp-gutter-h';
    g.dataset.gutter = `${dir}:${key.join(':')}`;
    g.addEventListener('pointerdown', (down) => {
      const prev = g.previousElementSibling as HTMLElement | null;
      const next = g.nextElementSibling as HTMLElement | null;
      if (!prev || !next) return;
      down.preventDefault();
      g.setPointerCapture(down.pointerId);
      const horizontal = dir === 'v';
      const total = horizontal
        ? prev.getBoundingClientRect().width + next.getBoundingClientRect().width
        : prev.getBoundingClientRect().height + next.getBoundingClientRect().height;
      const growSum = parseFloat(prev.style.flexGrow || '1') + parseFloat(next.style.flexGrow || '1');
      const start = horizontal ? down.clientX : down.clientY;
      const startPrev = horizontal ? prev.getBoundingClientRect().width : prev.getBoundingClientRect().height;
      const onMove = (move: PointerEvent) => {
        const delta = (horizontal ? move.clientX : move.clientY) - start;
        const frac = Math.min(0.9, Math.max(0.1, (startPrev + delta) / total));
        prev.style.flexGrow = String(growSum * frac);
        next.style.flexGrow = String(growSum * (1 - frac));
      };
      const onUp = () => {
        g.removeEventListener('pointermove', onMove);
        g.removeEventListener('pointerup', onUp);
        this.persist();
      };
      g.addEventListener('pointermove', onMove);
      g.addEventListener('pointerup', onUp);
    });
    return g;
  }

  /** Tab strip, mounted into the topbar by main.ts. */
  createTabs(): HTMLElement {
    const wrap = document.createElement('nav');
    wrap.className = 'wsp-tabs';
    for (const name of this.workspaceNames) {
      const btn = document.createElement('button');
      btn.className = 'wsp-tab';
      btn.dataset.workspace = name;
      btn.textContent = name;
      btn.addEventListener('click', () => this.switchTo(name));
      this.tabButtons.set(name, btn);
      wrap.append(btn);
    }
    this.tabButtons.get(this.active)?.classList.add('wsp-tab-active');
    return wrap;
  }

  update(): void {
    for (const area of this.areas) area.update();
  }

  /** Write the live DOM state (editors + sizes) back into the active config. */
  private captureCurrentLayout(): void {
    const ws = this.workspaces.find((w) => w.name === this.active);
    if (!ws || this.areas.length === 0) return;
    const cols = [...this.root.querySelectorAll(':scope > .wsp-col')] as HTMLElement[];
    ws.columns = cols.map((colEl) => ({
      size: parseFloat(colEl.style.flexGrow || '1'),
      areas: ([...colEl.querySelectorAll(':scope > .wsp-area')] as HTMLElement[]).map((areaEl) => {
        const area = this.areas.find((a) => a.root === areaEl)!;
        return { editor: area.editorType, size: parseFloat(areaEl.style.flexGrow || '1') };
      }),
    }));
  }

  private persist(): void {
    this.captureCurrentLayout();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ active: this.active, workspaces: this.workspaces }));
    } catch { /* storage may be unavailable; layouts just won't persist */ }
  }

  private loadOverrides(defaults: WorkspaceConfig[]): WorkspaceConfig[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaults;
      const saved = JSON.parse(raw) as { workspaces: WorkspaceConfig[] };
      // Only accept overrides that structurally match a known workspace + editors.
      return defaults.map((d) => {
        const s = saved.workspaces?.find((w) => w.name === d.name);
        if (!s || !Array.isArray(s.columns)) return d;
        const editorsOk = s.columns.every((c) =>
          Array.isArray(c.areas) && c.areas.every((a) => this.factories.some((f) => f.type === a.editor)));
        return editorsOk ? s : d;
      });
    } catch {
      return defaults;
    }
  }
}
