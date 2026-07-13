import type { Scene } from '../core/scene/Scene';
import type { UndoStack, Command } from '../core/undo/UndoStack';
import { registerPropertiesTab } from './propertiesEditor';
import { propRow } from './propRow';
import {
  viewPrefs, saveViewPrefs, clampRenderSamples,
  type RenderEngine, type AnimFormat,
} from '../render/viewPrefs';
import { probeSupportedMp4 } from '../renderEngine/animRender';
import './renderTab.css';

/**
 * UR16-3 — the **Render** Properties tab (sits above Object). Blender's Output
 * properties for this app: the canonical controls for the F12 / Ctrl+F12 render.
 *
 *  - **Engine** (CPU|GPU) — writes viewPrefs.renderEngine, the SAME value the
 *    render window's Engine select and the Ctrl+F12 GPU option read. Their local
 *    selects stay; this tab syncs both directions.
 *  - **Samples** — the F12 spp cap (viewPrefs.renderSamples; the render window's
 *    field syncs).
 *  - **Resolution X/Y** — MOVED here from the Camera tab (still scene.renderSettings,
 *    same SetRenderResolutionCommand undo).
 *  - **Output** — still format (PNG placeholder) + animation format (WebM/MP4/
 *    PNG-seq → viewPrefs.animFormat; the Ctrl+F12 modal defaults to it).
 *  - **Transparent background** — scene.renderSettings.transparent (undoable).
 *  - **Limit GPU load** — viewPrefs.limitGpuLoad (a machine pref, not undoable).
 *
 * Engine + Samples reach the live render window through the app-wide
 * `window.__renderEngine` handle (created by initRenderEngine) so an open render
 * re-runs on the new setting; that handle is also how the render window pushes
 * changes back (this tab re-reads viewPrefs every frame, unless a field is focused).
 */

/** Minimal shape of the render-engine debug handle this tab drives. */
interface RenderEngineHandle {
  isOpen(): boolean;
  start(): void;
  setEngine(e: RenderEngine): void;
  setSamples(n: number): void;
}

function renderEngineHandle(): RenderEngineHandle | null {
  const h = (window as unknown as { __renderEngine?: RenderEngineHandle }).__renderEngine;
  return h ?? null;
}

/**
 * One undoable change of the scene's output resolution (UR5-5; moved to the
 * Render tab in UR16-3). Snapshots the WHOLE renderSettings object so undo
 * restores transparent too. Full snapshots keep it a plain before/after swap.
 */
class SetRenderResolutionCommand implements Command {
  readonly name = 'Set Resolution';
  constructor(
    private readonly scene: Scene,
    private readonly before: Scene['renderSettings'],
    private readonly after: Scene['renderSettings'],
  ) {}
  undo(): void { this.scene.renderSettings = { ...this.before }; }
  redo(): void { this.scene.renderSettings = { ...this.after }; }
}

/** One undoable toggle of the scene's transparent-film flag (UR16-3). */
class SetTransparentCommand implements Command {
  readonly name = 'Set Transparent Film';
  constructor(private readonly scene: Scene, private readonly after: boolean) {}
  private apply(v: boolean): void {
    this.scene.renderSettings = { ...this.scene.renderSettings, transparent: v };
  }
  undo(): void { this.apply(!this.after); }
  redo(): void { this.apply(this.after); }
}

class RenderTab {
  private readonly body: HTMLDivElement;
  private readonly engineSel: HTMLSelectElement;
  private readonly samplesInput: HTMLInputElement;
  private readonly resWInput: HTMLInputElement;
  private readonly resHInput: HTMLInputElement;
  private readonly stillSel: HTMLSelectElement;
  private readonly animSel: HTMLSelectElement;
  private readonly transparentInput: HTMLInputElement;
  private readonly limitInput: HTMLInputElement;

  constructor(
    container: HTMLElement,
    private readonly scene: Scene,
    private readonly undo: UndoStack,
  ) {
    this.body = document.createElement('div');
    this.body.className = 'properties-body render-tab';

    // --- Engine (canonical CPU|GPU) ---
    this.engineSel = this.select('render-engine', [['gpu', 'GPU'], ['cpu', 'CPU']]);
    this.engineSel.addEventListener('change', () => {
      const e: RenderEngine = this.engineSel.value === 'cpu' ? 'cpu' : 'gpu';
      const h = renderEngineHandle();
      if (h) h.setEngine(e); // updates the render window + viewPrefs + persists
      else { viewPrefs.renderEngine = e; saveViewPrefs(); }
    });
    this.body.append(propRow({ label: 'Engine', controls: [this.engineSel], rowClass: 'render-tab-engine-row' }));

    // --- Samples (F12 spp cap) ---
    this.samplesInput = this.numberInput('render-samples', 1, 4096, 1);
    this.samplesInput.addEventListener('change', () => {
      const n = clampRenderSamples(parseInt(this.samplesInput.value, 10));
      this.samplesInput.value = String(n);
      const h = renderEngineHandle();
      if (h) h.setSamples(n);
      else { viewPrefs.renderSamples = n; saveViewPrefs(); }
    });
    this.body.append(propRow({ label: 'Samples', controls: [this.samplesInput], rowClass: 'render-tab-samples-row' }));

    // --- Resolution X/Y (moved from Camera ▸ Format) ---
    this.resWInput = this.numberInput('res-x', 1, undefined, 1);
    this.resWInput.addEventListener('change', () => this.commitResolution('x'));
    this.body.append(propRow({ label: 'Resolution X', controls: [this.resWInput], rowClass: 'render-tab-resx-row' }));
    this.resHInput = this.numberInput('res-y', 1, undefined, 1);
    this.resHInput.addEventListener('change', () => this.commitResolution('y'));
    this.body.append(propRow({ label: 'Resolution Y', controls: [this.resHInput], rowClass: 'render-tab-resy-row' }));

    // --- Output ---
    this.body.append(this.sectionTitle('Output'));
    // Still format: PNG placeholder (only option for now).
    this.stillSel = this.select('still-format', [['png', 'PNG']]);
    this.stillSel.disabled = true;
    this.stillSel.title = 'Still image format (PNG for now)';
    this.body.append(propRow({ label: 'Still', controls: [this.stillSel], rowClass: 'render-tab-still-row' }));
    // Animation format: WebM / MP4 (when supported) / PNG sequence — syncs Ctrl+F12.
    const animOpts: [string, string][] = [['webm', 'WebM']];
    const mp4 = typeof MediaRecorder !== 'undefined'
      ? probeSupportedMp4((t) => MediaRecorder.isTypeSupported(t)) : null;
    if (mp4) animOpts.push(['mp4', 'MP4']);
    animOpts.push(['png', 'PNG sequence']);
    this.animSel = this.select('anim-format', animOpts);
    this.animSel.title = 'Animation container (Ctrl+F12 defaults to this)';
    this.animSel.addEventListener('change', () => {
      const v = this.animSel.value;
      if (v === 'webm' || v === 'mp4' || v === 'png') { viewPrefs.animFormat = v as AnimFormat; saveViewPrefs(); }
    });
    this.body.append(propRow({ label: 'Animation', controls: [this.animSel], rowClass: 'render-tab-anim-row' }));

    // --- Transparent background (undoable scene setting) ---
    this.transparentInput = this.checkbox('transparent');
    this.transparentInput.addEventListener('change', () => {
      const want = this.transparentInput.checked;
      if ((this.scene.renderSettings.transparent ?? false) === want) return;
      this.scene.renderSettings = { ...this.scene.renderSettings, transparent: want };
      this.undo.push(new SetTransparentCommand(this.scene, want));
      const h = renderEngineHandle();
      if (h && h.isOpen()) h.start(); // re-render with the new film
    });
    const trWrap = this.checkboxControl(this.transparentInput,
      'Skip the world backdrop and output alpha (PNG keeps it; WebM composites black)');
    this.body.append(propRow({ label: 'Transparent', controls: [trWrap], rowClass: 'render-tab-transparent-row' }));

    // --- Limit GPU load (machine pref, no undo) ---
    this.limitInput = this.checkbox('limit-gpu');
    this.limitInput.addEventListener('change', () => {
      viewPrefs.limitGpuLoad = this.limitInput.checked;
      saveViewPrefs();
    });
    const lgWrap = this.checkboxControl(this.limitInput,
      'Keeps the desktop responsive on weaker GPUs; renders a bit slower.');
    this.body.append(propRow({ label: 'Limit GPU load', controls: [lgWrap], rowClass: 'render-tab-limit-row' }));

    container.append(this.body);
    this.update();
  }

  private select(testid: string, opts: [string, string][]): HTMLSelectElement {
    const sel = document.createElement('select');
    sel.dataset.testid = testid;
    for (const [val, label] of opts) {
      const o = document.createElement('option');
      o.value = val; o.textContent = label;
      sel.appendChild(o);
    }
    return sel;
  }

  private numberInput(testid: string, min?: number, max?: number, step?: number): HTMLInputElement {
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.dataset.testid = testid;
    if (min !== undefined) inp.min = String(min);
    if (max !== undefined) inp.max = String(max);
    if (step !== undefined) inp.step = String(step);
    return inp;
  }

  private checkbox(testid: string): HTMLInputElement {
    const inp = document.createElement('input');
    inp.type = 'checkbox';
    inp.dataset.testid = testid;
    return inp;
  }

  /** Wrap a checkbox so the control column holds it left-aligned (not stretched). */
  private checkboxControl(input: HTMLInputElement, tooltip: string): HTMLElement {
    const wrap = document.createElement('label');
    wrap.className = 'render-tab-check';
    wrap.title = tooltip;
    wrap.append(input);
    return wrap;
  }

  private sectionTitle(text: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'properties-group-title render-tab-section';
    el.textContent = text;
    return el;
  }

  /** Push one undoable resolution change (clamped to a positive integer). */
  private commitResolution(axis: 'x' | 'y'): void {
    const input = axis === 'x' ? this.resWInput : this.resHInput;
    const raw = parseFloat(input.value);
    if (!Number.isFinite(raw) || raw < 1) return this.writeResolution();
    const v = Math.max(1, Math.round(raw));
    const before = { ...this.scene.renderSettings };
    const after = axis === 'x' ? { ...before, width: v } : { ...before, height: v };
    if (after.width === before.width && after.height === before.height) return this.writeResolution();
    this.scene.renderSettings = after;
    this.undo.push(new SetRenderResolutionCommand(this.scene, before, after));
    this.writeResolution();
  }

  private writeResolution(): void {
    const active = document.activeElement;
    const rs = this.scene.renderSettings;
    if (active !== this.resWInput) this.resWInput.value = String(rs.width);
    if (active !== this.resHInput) this.resHInput.value = String(rs.height);
  }

  update(): void {
    const active = document.activeElement;
    // Engine + Samples mirror viewPrefs (the render window / Ctrl+F12 write it too).
    if (active !== this.engineSel && this.engineSel.value !== viewPrefs.renderEngine) {
      this.engineSel.value = viewPrefs.renderEngine;
    }
    if (active !== this.samplesInput) {
      const s = String(viewPrefs.renderSamples);
      if (this.samplesInput.value !== s) this.samplesInput.value = s;
    }
    if (active !== this.animSel && this.animSel.value !== viewPrefs.animFormat) {
      // Only when the option exists (MP4 may be absent this session).
      if (Array.from(this.animSel.options).some((o) => o.value === viewPrefs.animFormat)) {
        this.animSel.value = viewPrefs.animFormat;
      }
    }
    this.writeResolution();
    const transp = this.scene.renderSettings.transparent ?? false;
    if (this.transparentInput.checked !== transp) this.transparentInput.checked = transp;
    if (this.limitInput.checked !== viewPrefs.limitGpuLoad) this.limitInput.checked = viewPrefs.limitGpuLoad;
  }
}

// Register at the FRONT of the strip — the Render tab sits above Object (UR16-3).
registerPropertiesTab(
  {
    id: 'render',
    icon: '🎦',
    title: 'Render',
    build: (container, ctx) => new RenderTab(container, ctx.scene, ctx.undo),
  },
  true,
);
