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

const STORAGE_KEY = 'vibe-blender-workspaces-v1';

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
    fullBtn.title = 'Toggle fullscreen (Ctrl+Space over the area)';
    fullBtn.addEventListener('click', () => manager.toggleFullscreen(this));

    header.append(this.select, this.headerSlot, fullBtn);
    this.body.className = 'wsp-area-body';
    this.root.append(header, this.body);
    this.setEditor(editor);
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

  private buildLayout(ws: WorkspaceConfig): void {
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
