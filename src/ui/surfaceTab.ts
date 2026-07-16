import type { Scene, SceneObject } from '../core/scene/Scene';
import type { UndoStack } from '../core/undo/UndoStack';
import {
  cloneSurfaceData,
  clampSurfaceSegs,
  type SurfaceData,
  type SurfaceTess,
} from '../core/scene/objectData';
import { registerPropertiesTab, type PropertiesTabContext } from './propertiesEditor';
import { SurfaceCommand } from '../core/undo/surfaceCommands';
import { setSurfaceDegree, rebuildSurfaceData, insertSurfaceKnotAt } from '../core/nurbs/edit';
import { fromSurfaceData, type NSurface } from '../core/nurbs/surface';
import { interiorKnots, knotDomain } from '../core/nurbs/basis';
import { tessStats } from '../core/nurbs/tessellate';
import { isoparmsOn, setIsoparms } from '../render/isoparmPrefs';
import './surfaceTab.css';

/**
 * Surface properties tab (NB-A3) — Blender's Surface data panel. Edits the
 * ACTIVE object's SurfaceData live when that object is a NURBS surface; otherwise
 * an empty state (mirroring the Text/Light tabs). Every geometry/tess edit pushes
 * ONE SurfaceCommand (whole-payload before/after snapshot); the surface driver
 * re-tessellates automatically whenever the payload's signature changes.
 *
 * Sections: Shape (degree per direction + point/span readout), Rebuild
 * (re-approximate at a fresh net), Insert Span (exact knot insert at the largest
 * span's midpoint), Tessellation (mode/segs/tolerance + mesh readout), Display
 * (control-net toggle), and Selected Point (weight of the edit-mode selection).
 *
 * Field convention follows textTab: dark number inputs that commit on `change`,
 * refreshes skipped while a field is focused so mid-edit values aren't clobbered.
 */

/** Number of distinct knot spans in a direction = interior distinct knots + 1. */
function spanCount(s: NSurface, dir: 'u' | 'v'): number {
  const count = dir === 'u' ? s.nu : s.nv;
  const p = dir === 'u' ? s.pu : s.pv;
  const U = dir === 'u' ? s.U : s.V;
  return interiorKnots(count, p, U).length + 1;
}

/** Parametric midpoint of the LARGEST span in a direction (for Insert Span). */
function largestSpanMid(s: NSurface, dir: 'u' | 'v'): number {
  const count = dir === 'u' ? s.nu : s.nv;
  const p = dir === 'u' ? s.pu : s.pv;
  const U = dir === 'u' ? s.U : s.V;
  const [lo, hi] = knotDomain(count, p, U);
  const bounds = [lo, ...interiorKnots(count, p, U).map((k) => k.u), hi];
  let bestA = lo, bestB = hi, best = -1;
  for (let i = 0; i < bounds.length - 1; i++) {
    const w = bounds[i + 1] - bounds[i];
    if (w > best) { best = w; bestA = bounds[i]; bestB = bounds[i + 1]; }
  }
  return (bestA + bestB) / 2;
}

class SurfaceTab {
  private readonly empty: HTMLDivElement;
  private readonly body: HTMLDivElement;

  // Shape
  private readonly degreeU: HTMLInputElement;
  private readonly degreeV: HTMLInputElement;
  private readonly shapeInfo: HTMLDivElement;

  // Rebuild (staging inputs — applied only on the Rebuild button)
  private readonly rbPointsU: HTMLInputElement;
  private readonly rbPointsV: HTMLInputElement;
  private readonly rbDegreeU: HTMLInputElement;
  private readonly rbDegreeV: HTMLInputElement;

  // Tessellation
  private readonly tessMode: HTMLSelectElement;
  private readonly segsU: HTMLInputElement;
  private readonly segsV: HTMLInputElement;
  private readonly tolInput: HTMLInputElement;
  private readonly tolRow: HTMLElement;
  private readonly tessInfo: HTMLDivElement;

  // Display
  private readonly showNet: HTMLInputElement;
  private readonly showIsoparms: HTMLInputElement;

  // Selected Point
  private readonly selSection: HTMLDivElement;
  private readonly weightInput: HTMLInputElement;

  /** Active object id shown last frame; -1 means "force reseed the rebuild fields". */
  private lastId: number | null = -1 as unknown as number;

  /** Memoize the tess info row: writeInfo runs every frame while the tab is
   *  open, so only re-run tessStats (a full grid build) when the payload changes. */
  private tessInfoKey = '';
  private tessInfoText = '';

  constructor(
    container: HTMLElement,
    private readonly scene: Scene,
    private readonly undo: UndoStack,
  ) {
    this.empty = document.createElement('div');
    this.empty.className = 'properties-empty';
    this.empty.textContent = 'No surface object selected';

    this.body = document.createElement('div');
    this.body.className = 'properties-body surface-tab';

    // --- Shape -------------------------------------------------------------
    this.body.append(this.sectionTitle('Shape'));
    this.degreeU = this.numInput('degree-u', '1', '1', '5');
    this.degreeU.addEventListener('change', () => this.commitDegree('u', this.degreeU));
    this.body.append(this.row('Degree U', this.degreeU));
    this.degreeV = this.numInput('degree-v', '1', '1', '5');
    this.degreeV.addEventListener('change', () => this.commitDegree('v', this.degreeV));
    this.body.append(this.row('Degree V', this.degreeV));
    this.shapeInfo = this.infoRow('shape-info');
    this.body.append(this.shapeInfo);

    // --- Rebuild -----------------------------------------------------------
    this.body.append(this.sectionTitle('Rebuild'));
    this.rbPointsU = this.numInput('rb-points-u', '1', '2', '');
    this.rbPointsV = this.numInput('rb-points-v', '1', '2', '');
    this.rbDegreeU = this.numInput('rb-degree-u', '1', '1', '5');
    this.rbDegreeV = this.numInput('rb-degree-v', '1', '1', '5');
    this.body.append(this.row('Points U', this.rbPointsU));
    this.body.append(this.row('Points V', this.rbPointsV));
    this.body.append(this.row('Degree U', this.rbDegreeU));
    this.body.append(this.row('Degree V', this.rbDegreeV));
    const rebuildBtn = this.button('rebuild', 'Rebuild');
    rebuildBtn.addEventListener('click', () => this.doRebuild());
    this.body.append(rebuildBtn);

    // --- Insert Span -------------------------------------------------------
    this.body.append(this.sectionTitle('Insert Span'));
    const spanRow = document.createElement('div');
    spanRow.className = 'surface-tab-btn-row';
    const insU = this.button('insert-u', 'Insert U');
    insU.addEventListener('click', () => this.insertSpan('u'));
    const insV = this.button('insert-v', 'Insert V');
    insV.addEventListener('click', () => this.insertSpan('v'));
    spanRow.append(insU, insV);
    this.body.append(spanRow);

    // --- Tessellation ------------------------------------------------------
    this.body.append(this.sectionTitle('Tessellation'));
    this.tessMode = document.createElement('select');
    this.tessMode.className = 'surface-tab-select';
    this.tessMode.dataset.field = 'tess-mode';
    for (const [value, label] of [['spans', 'Spans'], ['adaptive', 'Adaptive']] as const) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      this.tessMode.append(opt);
    }
    this.tessMode.addEventListener('change', () => {
      const mode = this.tessMode.value as SurfaceTess['mode'];
      this.commitTess('Surface Tess Mode', (t) => { t.mode = mode; });
    });
    this.body.append(this.row('Mode', this.tessMode));

    this.segsU = this.numInput('segs-u', '1', '1', '64');
    this.segsU.addEventListener('change', () => this.commitSegs('u'));
    this.body.append(this.row('Segs U', this.segsU));
    this.segsV = this.numInput('segs-v', '1', '1', '64');
    this.segsV.addEventListener('change', () => this.commitSegs('v'));
    this.body.append(this.row('Segs V', this.segsV));

    this.tolInput = this.numInput('tol', '0.001', '0.00001', '');
    this.tolInput.addEventListener('change', () => {
      const v = parseFloat(this.tolInput.value);
      if (!Number.isFinite(v) || v <= 0) return this.refresh();
      this.commitTess('Surface Tolerance', (t) => { t.tol = v; });
    });
    this.tolRow = this.row('Tolerance', this.tolInput);
    this.body.append(this.tolRow);

    this.tessInfo = this.infoRow('tess-info');
    this.body.append(this.tessInfo);

    // --- Display -----------------------------------------------------------
    this.body.append(this.sectionTitle('Display'));
    this.showNet = document.createElement('input');
    this.showNet.type = 'checkbox';
    this.showNet.dataset.field = 'show-net';
    this.showNet.addEventListener('change', () => {
      const on = this.showNet.checked;
      // showNet is NOT in the surface signature, so this commit does not
      // re-tessellate — the driver only rebuilds on geometry/tess/trim change.
      this.apply('Show Net', (d) => { const n = cloneSurfaceData(d); n.showNet = on; return n; });
    });
    this.body.append(this.row('Show Net', this.showNet));

    // Isoparms — an app-level pref (isoparmPrefs), not payload state: it does
    // NOT re-tessellate and is not undoable. The net pass reads it each frame.
    this.showIsoparms = document.createElement('input');
    this.showIsoparms.type = 'checkbox';
    this.showIsoparms.dataset.field = 'show-isoparms';
    this.showIsoparms.addEventListener('change', () => {
      const obj = this.activeSurface();
      if (obj) setIsoparms(obj.id, this.showIsoparms.checked);
    });
    this.body.append(this.row('Isoparms', this.showIsoparms));

    // --- Selected Point (edit mode with a selection) -----------------------
    this.selSection = document.createElement('div');
    this.selSection.className = 'surface-tab-sel';
    this.selSection.append(this.sectionTitle('Selected Point'));
    this.weightInput = this.numInput('weight', '0.1', '0.01', '100');
    this.weightInput.addEventListener('change', () => this.commitWeight());
    this.selSection.append(this.row('Weight', this.weightInput));
    this.body.append(this.selSection);

    container.append(this.empty, this.body);
    this.update();
  }

  // --- DOM builders --------------------------------------------------------

  private numInput(field: string, step: string, min: string, max: string): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'surface-tab-input';
    input.dataset.field = field;
    input.step = step;
    if (min) input.min = min;
    if (max) input.max = max;
    return input;
  }

  private button(action: string, text: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'surface-tab-btn';
    btn.dataset.action = action;
    btn.textContent = text;
    return btn;
  }

  private sectionTitle(text: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'properties-group-title surface-tab-section';
    el.textContent = text;
    return el;
  }

  private infoRow(field: string): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'surface-tab-info';
    el.dataset.field = field;
    return el;
  }

  private row(text: string, control: HTMLElement): HTMLElement {
    const row = document.createElement('label');
    row.className = 'surface-tab-row';
    const label = document.createElement('span');
    label.className = 'properties-group-title surface-tab-label';
    label.textContent = text;
    label.style.marginBottom = '0';
    row.append(label, control);
    return row;
  }

  // --- State access --------------------------------------------------------

  /** The active object iff it is a surface with a payload, else null. */
  private activeSurface(): SceneObject | null {
    const obj = this.scene.activeObject;
    return obj && obj.kind === 'surface' && obj.surface ? obj : null;
  }

  // --- Commit helpers ------------------------------------------------------

  /** Push one SurfaceCommand that swaps in a freshly-produced payload. */
  private apply(name: string, produce: (d: SurfaceData) => SurfaceData): void {
    const obj = this.activeSurface();
    if (!obj || !obj.surface) return;
    this.undo.push(SurfaceCommand.capture(name, obj, () => {
      obj.surface = produce(obj.surface!);
    }));
    this.refresh();
  }

  private commitDegree(dir: 'u' | 'v', input: HTMLInputElement): void {
    const v = parseFloat(input.value);
    if (!Number.isFinite(v)) return this.refresh();
    this.apply(dir === 'u' ? 'Set Degree U' : 'Set Degree V', (d) => setSurfaceDegree(d, dir, v));
  }

  private commitSegs(dir: 'u' | 'v'): void {
    const input = dir === 'u' ? this.segsU : this.segsV;
    const v = parseFloat(input.value);
    if (!Number.isFinite(v)) return this.refresh();
    const n = clampSurfaceSegs(v);
    this.commitTess(dir === 'u' ? 'Surface Segs U' : 'Surface Segs V', (t) => {
      if (dir === 'u') t.segsU = n; else t.segsV = n;
    });
  }

  private commitTess(name: string, mutate: (t: SurfaceTess) => void): void {
    this.apply(name, (d) => {
      const n = cloneSurfaceData(d);
      mutate(n.tess);
      return n;
    });
  }

  private doRebuild(): void {
    const pu = parseFloat(this.rbPointsU.value);
    const pv = parseFloat(this.rbPointsV.value);
    const du = parseFloat(this.rbDegreeU.value);
    const dv = parseFloat(this.rbDegreeV.value);
    if (![pu, pv, du, dv].every(Number.isFinite)) return this.refresh();
    this.apply('Rebuild Surface', (d) => rebuildSurfaceData(d, pu, pv, du, dv));
  }

  private insertSpan(dir: 'u' | 'v'): void {
    const obj = this.activeSurface();
    if (!obj || !obj.surface) return;
    const s = fromSurfaceData(obj.surface);
    if (!s) return;
    const t = largestSpanMid(s, dir);
    this.apply(dir === 'u' ? 'Insert U Span' : 'Insert V Span', (d) => insertSurfaceKnotAt(d, dir, t));
  }

  private commitWeight(): void {
    const sel = this.scene.surfaceEdit;
    if (!sel || sel.points.size === 0) return;
    const raw = parseFloat(this.weightInput.value);
    if (!Number.isFinite(raw)) return this.refresh();
    const w = Math.max(0.01, Math.min(100, raw));
    const selected = [...sel.points];
    this.apply('Point Weight', (d) => {
      const n = cloneSurfaceData(d);
      for (const i of selected) if (n.points[i]) n.points[i].w = w;
      return n;
    });
  }

  // --- Refresh -------------------------------------------------------------

  update(): void {
    const obj = this.activeSurface();
    if (!obj || !obj.surface) {
      this.empty.style.display = '';
      this.body.style.display = 'none';
      this.lastId = null;
      return;
    }
    this.empty.style.display = 'none';
    this.body.style.display = '';
    const switched = obj.id !== this.lastId;
    this.lastId = obj.id;
    if (!switched && this.isPanelFocused()) {
      // Still keep the always-live readouts + the selection section fresh.
      this.writeInfo(obj);
      this.writeSelection();
      return;
    }
    this.writeFields(obj, switched);
  }

  private isPanelFocused(): boolean {
    const a = document.activeElement;
    return a instanceof HTMLInputElement && this.body.contains(a);
  }

  private writeFields(obj: SceneObject, switched: boolean): void {
    const d = obj.surface!;
    this.setNum(this.degreeU, d.degreeU);
    this.setNum(this.degreeV, d.degreeV);

    // Rebuild staging fields seed from the payload only on object switch, so a
    // half-typed rebuild config isn't reset every frame.
    if (switched) {
      this.setNum(this.rbPointsU, d.pointsU);
      this.setNum(this.rbPointsV, d.pointsV);
      this.setNum(this.rbDegreeU, d.degreeU);
      this.setNum(this.rbDegreeV, d.degreeV);
    }

    if (this.tessMode.value !== d.tess.mode) this.tessMode.value = d.tess.mode;
    this.setNum(this.segsU, d.tess.segsU);
    this.setNum(this.segsV, d.tess.segsV);
    this.setNum(this.tolInput, d.tess.tol);
    this.tolRow.style.display = d.tess.mode === 'adaptive' ? '' : 'none';

    this.showNet.checked = !!d.showNet;
    this.showIsoparms.checked = isoparmsOn(obj.id);

    this.writeInfo(obj);
    this.writeSelection();
  }

  /** Points/Spans + tessellation vert/face readouts. Tess counts come from
   *  tessStats (the same grid step tessellateSurface uses), so the row updates
   *  live as tess fields change — before the driver re-tessellates the mesh. */
  private writeInfo(obj: SceneObject): void {
    const d = obj.surface!;
    const s = fromSurfaceData(d);
    if (s) {
      this.shapeInfo.textContent =
        `Points: ${s.nu} × ${s.nv}   Spans: ${spanCount(s, 'u')} × ${spanCount(s, 'v')}`;
    } else {
      this.shapeInfo.textContent = `Points: ${d.pointsU} × ${d.pointsV}`;
    }
    const key = JSON.stringify(d);
    if (key !== this.tessInfoKey) {
      this.tessInfoKey = key;
      const st = tessStats(d);
      this.tessInfoText = `${st.verts} verts / ${st.faces} faces (grid ${st.us}×${st.vs})`;
    }
    this.tessInfo.textContent = this.tessInfoText;
  }

  /** Show the Selected Point section only while edit mode has a selection. */
  private writeSelection(): void {
    const sel = this.scene.surfaceEdit;
    const obj = this.activeSurface();
    if (!sel || sel.points.size === 0 || !obj || !obj.surface) {
      this.selSection.style.display = 'none';
      return;
    }
    this.selSection.style.display = '';
    if (document.activeElement === this.weightInput) return;
    // Show the first selected point's weight (default 1) as the representative.
    const first = [...sel.points][0];
    const w = obj.surface.points[first]?.w ?? 1;
    this.setNum(this.weightInput, w);
  }

  private setNum(input: HTMLInputElement, value: number): void {
    if (document.activeElement === input) return;
    const s = String(value);
    if (input.value !== s) input.value = s;
  }

  private refresh(): void {
    const obj = this.activeSurface();
    if (obj && obj.surface) this.writeFields(obj, false);
  }
}

registerPropertiesTab({
  id: 'surface',
  icon: '◧', // ◧
  title: 'Surface',
  build: (container: HTMLElement, ctx: PropertiesTabContext) =>
    new SurfaceTab(container, ctx.scene, ctx.undo),
});
