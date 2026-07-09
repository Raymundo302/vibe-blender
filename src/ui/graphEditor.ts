/**
 * Graph Editor — Blender's F-curve editor as a workspace pane.
 *
 * Draws the SELECTED objects' fcurves on a 2D canvas (x = frame, y = value),
 * sampling evalFCurve per pixel column so every interpolation mode renders
 * exactly. Keys are diamonds you can click-select (shift adds) and drag in
 * both frame (snapped to integers) and value. When a selected key's own interp
 * or its incoming span is 'bezier', its handles show as lines + small squares;
 * dragging a handle sets handleMode='free' and that side's offset.
 *
 * View: wheel zooms (uniform, Ctrl+wheel = y only) about the cursor, MMB drag
 * pans, Home / the ⌂ button frames all visible keys.
 *
 * Every edit (key drag, handle drag) becomes one undoable EditCurveKeysCommand
 * via the pointerdown-snapshot / pointerup-restore-then-capture pattern: the
 * live drag mutates the curves for immediate feedback; on release we restore
 * the pre-drag state and re-run the mutation inside capture() so undo/redo swap
 * whole key arrays exactly (frame collisions and all).
 */
import type { Scene, SceneObject } from '../core/scene/Scene';
import type { UndoStack } from '../core/undo/UndoStack';
import { evalFCurve, findCurve, type FCurve, type Keyframe } from '../core/anim/fcurve';
import { EditCurveKeysCommand } from '../core/anim/keyEditCommands';
import { applyAnimation } from '../core/anim/sampler';
import './graphEditor.css';

export interface GraphDeps {
  scene: Scene;
  undo: UndoStack;
}

/** Left gutter (value labels), right margin, top margin, bottom frame ruler. */
const PAD_LEFT = 46;
const PAD_RIGHT = 12;
const PAD_TOP = 10;
const RULER_H = 20;

/** Hit radius (px) for keys and handle squares. */
const HIT_R = 7;

/** A curve currently drawn, tied back to its owning object. */
interface DrawnCurve {
  object: SceneObject;
  curve: FCurve;
}

/** Channel color by path suffix: .x red, .y green, .z blue, else gold. */
export function channelColor(path: string): string {
  if (path.endsWith('.x')) return '#e5484d';
  if (path.endsWith('.y')) return '#4caf50';
  if (path.endsWith('.z')) return '#4c8dff';
  return '#e6b400';
}

/** A "nice" grid step (1/2/5 × 10ⁿ) for `range` split into ~`target` divisions. */
export function niceStep(range: number, target: number): number {
  if (!(range > 0) || !(target > 0)) return 1;
  const raw = range / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return step * mag;
}

/** The auto (Catmull-Rom) tangent at keys[i], value-per-frame — mirrors fcurve. */
function autoTangent(keys: Keyframe[], i: number): number {
  const prev = keys[i - 1] ?? keys[i];
  const next = keys[i + 1] ?? keys[i];
  if (next.frame === prev.frame) return 0;
  return (next.value - prev.value) / (next.frame - prev.frame);
}

/** Selection identity: object + channel + frame (frames unique within a curve). */
function selId(objectId: number, channelPath: string, frame: number): string {
  return `${objectId}:${channelPath}:${frame}`;
}

function copyKeys(keys: Keyframe[]): Keyframe[] {
  return keys.map((k) => ({
    ...k,
    hl: k.hl ? [k.hl[0], k.hl[1]] as [number, number] : undefined,
    hr: k.hr ? [k.hr[0], k.hr[1]] as [number, number] : undefined,
  }));
}

/** One handle square the editor drew (screen px), for e2e + hit testing. */
interface HandleInfo {
  object: SceneObject;
  channelPath: string;
  frame: number;
  side: 'l' | 'r';
  /** Value-space handle position (key + offset). */
  vf: number;
  vv: number;
}

type DragState =
  | {
      kind: 'key';
      targets: { object: SceneObject; channelPath: string; start: Keyframe[]; movedFrames: Set<number> }[];
      grabFrame: number;
      grabValue: number;
    }
  | {
      kind: 'handle';
      object: SceneObject;
      channelPath: string;
      start: Keyframe[];
      frame: number;
      side: 'l' | 'r';
    }
  | { kind: 'pan'; lastX: number; lastY: number };

export class GraphEditor {
  readonly element: HTMLElement;
  private readonly scene: Scene;
  private readonly undo: UndoStack;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx2d: CanvasRenderingContext2D;
  private readonly titleEl: HTMLElement;

  private cssW = 0;
  private cssH = 0;

  // View transform: (frame x0 at PAD_LEFT, value y0 at PAD_TOP) + px scales.
  private x0 = -2;
  private y0 = 2;
  private pxPerFrame = 12;
  private pxPerValue = 60;
  private didInitialFit = false;

  private drawn: DrawnCurve[] = [];
  private handles: HandleInfo[] = [];
  private selection = new Set<string>();
  private drag: DragState | null = null;
  private hovered = false;

  private accent = '#fe730f';
  private accentTick = 0;

  private readonly onPointerDown: (e: PointerEvent) => void;
  private readonly onPointerMove: (e: PointerEvent) => void;
  private readonly onPointerUp: () => void;
  private readonly onWheel: (e: WheelEvent) => void;
  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly onEnter: () => void;
  private readonly onLeave: () => void;

  constructor(deps: GraphDeps) {
    this.scene = deps.scene;
    this.undo = deps.undo;

    this.element = document.createElement('div');
    this.element.className = 'graph';

    const header = document.createElement('div');
    header.className = 'graph-header';
    const fitBtn = document.createElement('button');
    fitBtn.className = 'graph-btn';
    fitBtn.textContent = '⌂';
    fitBtn.title = 'Frame all keys (Home)';
    fitBtn.addEventListener('click', () => { this.fit(); });
    this.titleEl = document.createElement('span');
    this.titleEl.className = 'graph-title';
    this.titleEl.textContent = 'Graph Editor';
    const hint = document.createElement('span');
    hint.className = 'graph-hint';
    hint.textContent = 'wheel zoom · MMB pan · Home fit';
    header.append(fitBtn, this.titleEl, hint);

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'graph-canvas';
    this.ctx2d = this.canvas.getContext('2d')!;

    this.element.append(header, this.canvas);

    this.onPointerDown = (e) => this.handlePointerDown(e);
    this.onPointerMove = (e) => this.handlePointerMove(e);
    this.onPointerUp = () => this.handlePointerUp();
    this.onWheel = (e) => this.handleWheel(e);
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });

    this.onEnter = () => { this.hovered = true; };
    this.onLeave = () => { this.hovered = false; };
    this.element.addEventListener('pointerenter', this.onEnter);
    this.element.addEventListener('pointerleave', this.onLeave);

    this.onKeyDown = (e) => this.handleKeyDown(e);
    window.addEventListener('keydown', this.onKeyDown);

    (window as unknown as Record<string, unknown>).__graph = {
      canvas: this.canvas,
      viewToPx: (f: number, v: number): [number, number] => this.viewToPx(f, v),
      pxToView: (x: number, y: number): [number, number] => this.pxToView(x, y),
      keysShown: (): { channelPath: string; frame: number; value: number; selected: boolean }[] => this.keysShown(),
      handlesShown: (): { channelPath: string; frame: number; side: 'l' | 'r'; x: number; y: number }[] => this.handlesShownScreen(),
      fit: (): void => this.fit(),
    };
  }

  destroy(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.element.removeEventListener('pointerenter', this.onEnter);
    this.element.removeEventListener('pointerleave', this.onLeave);
    window.removeEventListener('keydown', this.onKeyDown);
    const w = window as unknown as { __graph?: { canvas: HTMLCanvasElement } };
    if (w.__graph && w.__graph.canvas === this.canvas) delete (window as unknown as Record<string, unknown>).__graph;
  }

  // --- View transform ------------------------------------------------------

  viewToPx(frame: number, value: number): [number, number] {
    return [
      PAD_LEFT + (frame - this.x0) * this.pxPerFrame,
      PAD_TOP + (this.y0 - value) * this.pxPerValue,
    ];
  }

  pxToView(x: number, y: number): [number, number] {
    return [
      this.x0 + (x - PAD_LEFT) / this.pxPerFrame,
      this.y0 - (y - PAD_TOP) / this.pxPerValue,
    ];
  }

  private localX(e: { clientX: number }): number {
    return e.clientX - this.canvas.getBoundingClientRect().left;
  }

  private localY(e: { clientY: number }): number {
    return e.clientY - this.canvas.getBoundingClientRect().top;
  }

  // --- Fit -----------------------------------------------------------------

  fit(): void {
    let fmin = Infinity, fmax = -Infinity, vmin = Infinity, vmax = -Infinity;
    for (const { curve } of this.drawn) {
      for (const k of curve.keys) {
        fmin = Math.min(fmin, k.frame); fmax = Math.max(fmax, k.frame);
        vmin = Math.min(vmin, k.value); vmax = Math.max(vmax, k.value);
      }
    }
    if (!Number.isFinite(fmin)) {
      fmin = this.scene.frameStart; fmax = this.scene.frameEnd; vmin = -1; vmax = 1;
    }
    if (fmax - fmin < 1e-6) { fmin -= 5; fmax += 5; }
    if (vmax - vmin < 1e-6) { vmin -= 1; vmax += 1; }
    const fpad = (fmax - fmin) * 0.08;
    const vpad = (vmax - vmin) * 0.1;
    fmin -= fpad; fmax += fpad; vmin -= vpad; vmax += vpad;
    const plotW = Math.max(1, this.cssW - PAD_LEFT - PAD_RIGHT);
    const plotH = Math.max(1, this.cssH - PAD_TOP - RULER_H);
    this.pxPerFrame = plotW / (fmax - fmin);
    this.pxPerValue = plotH / (vmax - vmin);
    this.x0 = fmin;
    this.y0 = vmax;
    this.didInitialFit = true;
  }

  // --- Interaction ---------------------------------------------------------

  private handleWheel(e: WheelEvent): void {
    e.preventDefault();
    const mx = this.localX(e), my = this.localY(e);
    const [bf, bv] = this.pxToView(mx, my);
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    if (!e.ctrlKey) this.pxPerFrame *= factor;
    this.pxPerValue *= factor;
    // Keep the view coordinate under the cursor fixed.
    this.x0 = bf - (mx - PAD_LEFT) / this.pxPerFrame;
    this.y0 = bv + (my - PAD_TOP) / this.pxPerValue;
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (!this.hovered) return;
    const a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
    if (e.key === 'Home') {
      e.preventDefault();
      this.fit();
    }
  }

  private handlePointerDown(e: PointerEvent): void {
    const x = this.localX(e), y = this.localY(e);
    if (e.button === 1) {
      e.preventDefault();
      this.drag = { kind: 'pan', lastX: e.clientX, lastY: e.clientY };
      return;
    }
    if (e.button !== 0) return;

    // 1. Handles (only exist for selected keys) take priority.
    const h = this.hitHandle(x, y);
    if (h) {
      this.drag = {
        kind: 'handle',
        object: h.object,
        channelPath: h.channelPath,
        start: copyKeys(findCurve(h.object.anim!, h.channelPath)!.keys),
        frame: h.frame,
        side: h.side,
      };
      return;
    }

    // 2. Keys — select then begin a move drag.
    const hit = this.hitKey(x, y);
    if (hit) {
      const id = selId(hit.object.id, hit.curve.channelPath, hit.key.frame);
      if (e.shiftKey) {
        if (this.selection.has(id)) this.selection.delete(id);
        else this.selection.add(id);
      } else if (!this.selection.has(id)) {
        this.selection.clear();
        this.selection.add(id);
      }
      if (!this.selection.has(id)) return; // shift-deselected — no drag
      this.beginKeyDrag(x, y);
      return;
    }

    // 3. Empty space — clear selection unless shift-adding.
    if (!e.shiftKey) this.selection.clear();
  }

  /** Snapshot every curve that owns a selected key and start a move drag. */
  private beginKeyDrag(x: number, y: number): void {
    const byCurve = new Map<string, { object: SceneObject; channelPath: string; start: Keyframe[]; movedFrames: Set<number> }>();
    for (const { object, curve, key } of this.selectedKeyRefs()) {
      const ck = `${object.id}:${curve.channelPath}`;
      let t = byCurve.get(ck);
      if (!t) {
        t = { object, channelPath: curve.channelPath, start: copyKeys(curve.keys), movedFrames: new Set() };
        byCurve.set(ck, t);
      }
      t.movedFrames.add(key.frame);
    }
    if (byCurve.size === 0) return;
    const [gf, gv] = this.pxToView(x, y);
    this.drag = { kind: 'key', targets: [...byCurve.values()], grabFrame: gf, grabValue: gv };
  }

  private handlePointerMove(e: PointerEvent): void {
    if (!this.drag) return;
    if (this.drag.kind === 'pan') {
      const dx = e.clientX - this.drag.lastX;
      const dy = e.clientY - this.drag.lastY;
      this.drag.lastX = e.clientX; this.drag.lastY = e.clientY;
      this.x0 -= dx / this.pxPerFrame;
      this.y0 += dy / this.pxPerValue;
      return;
    }
    const x = this.localX(e), y = this.localY(e);
    if (this.drag.kind === 'key') this.applyKeyDrag(x, y);
    else this.applyHandleDrag(x, y);
    applyAnimation(this.scene, this.scene.frameCurrent);
  }

  private applyKeyDrag(x: number, y: number): void {
    if (!this.drag || this.drag.kind !== 'key') return;
    const [pf, pv] = this.pxToView(x, y);
    const dframe = Math.round(pf - this.drag.grabFrame);
    const dvalue = pv - this.drag.grabValue;
    const newSelection = new Set<string>();
    for (const tgt of this.drag.targets) {
      const keys = copyKeys(tgt.start);
      const moved: Keyframe[] = [];
      const stationary: Keyframe[] = [];
      for (const k of keys) {
        if (tgt.movedFrames.has(k.frame)) {
          k.frame += dframe;
          k.value += dvalue;
          moved.push(k);
          newSelection.add(selId(tgt.object.id, tgt.channelPath, k.frame));
        } else {
          stationary.push(k);
        }
      }
      this.writeCurve(tgt.object, tgt.channelPath, this.normalize(stationary, moved));
    }
    // Selection follows the keys to their new frames.
    this.selection = newSelection;
  }

  private applyHandleDrag(x: number, y: number): void {
    if (!this.drag || this.drag.kind !== 'handle') return;
    const keys = copyKeys(this.drag.start);
    const target = keys.find((k) => k.frame === (this.drag as { frame: number }).frame);
    if (!target) return;
    const [pf, pv] = this.pxToView(x, y);
    target.handleMode = 'free';
    const offset: [number, number] = [pf - target.frame, pv - target.value];
    if (this.drag.side === 'l') target.hl = offset;
    else target.hr = offset;
    this.writeCurve(this.drag.object, this.drag.channelPath, keys);
  }

  /** Merge stationary + moved keys, last-write-wins on frame collisions. */
  private normalize(stationary: Keyframe[], moved: Keyframe[]): Keyframe[] {
    const map = new Map<number, Keyframe>();
    for (const k of stationary) map.set(k.frame, k);
    for (const k of moved) map.set(k.frame, k); // moved overwrite collided stationary
    return [...map.values()].sort((a, b) => a.frame - b.frame);
  }

  private writeCurve(object: SceneObject, channelPath: string, keys: Keyframe[]): void {
    if (!object.anim) object.anim = { fcurves: [] };
    let curve = findCurve(object.anim, channelPath);
    if (keys.length === 0) {
      if (curve) object.anim.fcurves = object.anim.fcurves.filter((c) => c !== curve);
      return;
    }
    if (!curve) { curve = { channelPath, keys: [] }; object.anim.fcurves.push(curve); }
    curve.keys = keys;
  }

  private handlePointerUp(): void {
    const drag = this.drag;
    this.drag = null;
    if (!drag || drag.kind === 'pan') return;

    // Gather the final (post-drag) state, restore the pre-drag start, then
    // re-run the mutation inside capture() so the edit is one undoable command.
    const targets =
      drag.kind === 'key'
        ? drag.targets.map((t) => ({ object: t.object, channelPath: t.channelPath, start: t.start }))
        : [{ object: drag.object, channelPath: drag.channelPath, start: drag.start }];

    const finals = targets.map((t) => {
      const c = t.object.anim && findCurve(t.object.anim, t.channelPath);
      return c ? copyKeys(c.keys) : [];
    });
    // Restore start state.
    targets.forEach((t) => this.writeCurve(t.object, t.channelPath, copyKeys(t.start)));

    const cmd = EditCurveKeysCommand.capture(
      drag.kind === 'key' ? 'Move Keyframes' : 'Edit Handle',
      targets.map((t) => ({ object: t.object, channelPath: t.channelPath })),
      () => targets.forEach((t, i) => this.writeCurve(t.object, t.channelPath, finals[i])),
    );
    if (cmd) this.undo.push(cmd);
    applyAnimation(this.scene, this.scene.frameCurrent);
  }

  // --- Hit testing ---------------------------------------------------------

  private hitKey(x: number, y: number): { object: SceneObject; curve: FCurve; key: Keyframe } | null {
    let best: { object: SceneObject; curve: FCurve; key: Keyframe } | null = null;
    let bestD = HIT_R * HIT_R;
    for (const { object, curve } of this.drawn) {
      for (const key of curve.keys) {
        const [kx, ky] = this.viewToPx(key.frame, key.value);
        const d = (kx - x) * (kx - x) + (ky - y) * (ky - y);
        if (d <= bestD) { bestD = d; best = { object, curve, key }; }
      }
    }
    return best;
  }

  private hitHandle(x: number, y: number): HandleInfo | null {
    for (const h of this.handles) {
      const [hx, hy] = this.viewToPx(h.vf, h.vv);
      if ((hx - x) * (hx - x) + (hy - y) * (hy - y) <= HIT_R * HIT_R) return h;
    }
    return null;
  }

  // --- Data ----------------------------------------------------------------

  private computeDrawn(): DrawnCurve[] {
    const out: DrawnCurve[] = [];
    for (const object of this.scene.selectedObjects) {
      if (!object.anim) continue;
      for (const curve of object.anim.fcurves) {
        if (curve.keys.length) out.push({ object, curve });
      }
    }
    return out;
  }

  /** Selected keys resolved to live references in the current curves. */
  private selectedKeyRefs(): { object: SceneObject; curve: FCurve; key: Keyframe }[] {
    const out: { object: SceneObject; curve: FCurve; key: Keyframe }[] = [];
    for (const { object, curve } of this.drawn) {
      for (const key of curve.keys) {
        if (this.selection.has(selId(object.id, curve.channelPath, key.frame))) {
          out.push({ object, curve, key });
        }
      }
    }
    return out;
  }

  /** Handle squares to show: for each SELECTED key whose own interp (outgoing
   *  span) or incoming span is bezier, the corresponding side's handle. */
  private computeHandles(): HandleInfo[] {
    const out: HandleInfo[] = [];
    for (const { object, curve } of this.drawn) {
      const keys = curve.keys;
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (!this.selection.has(selId(object.id, curve.channelPath, key.frame))) continue;
        const prev = keys[i - 1];
        const next = keys[i + 1];
        // Left handle: incoming span (prev key's interp) is bezier.
        if (prev && prev.interp === 'bezier') {
          const [vf, vv] = this.handlePos(keys, i, 'l');
          out.push({ object, channelPath: curve.channelPath, frame: key.frame, side: 'l', vf, vv });
        }
        // Right handle: outgoing span (this key's interp) is bezier.
        if (next && key.interp === 'bezier') {
          const [vf, vv] = this.handlePos(keys, i, 'r');
          out.push({ object, channelPath: curve.channelPath, frame: key.frame, side: 'r', vf, vv });
        }
      }
    }
    return out;
  }

  /** Value-space position of key i's handle on `side` (auto rule, or free). */
  private handlePos(keys: Keyframe[], i: number, side: 'l' | 'r'): [number, number] {
    const key = keys[i];
    const free = key.handleMode === 'free';
    if (side === 'l') {
      if (free && key.hl) return [key.frame + key.hl[0], key.value + key.hl[1]];
      const prev = keys[i - 1] ?? key;
      const dt = key.frame - prev.frame;
      const tan = autoTangent(keys, i);
      return [key.frame - dt / 3, key.value - (tan * dt) / 3];
    }
    if (free && key.hr) return [key.frame + key.hr[0], key.value + key.hr[1]];
    const next = keys[i + 1] ?? key;
    const dt = next.frame - key.frame;
    const tan = autoTangent(keys, i);
    return [key.frame + dt / 3, key.value + (tan * dt) / 3];
  }

  // --- e2e handles ---------------------------------------------------------

  private keysShown(): { channelPath: string; frame: number; value: number; selected: boolean }[] {
    const out: { channelPath: string; frame: number; value: number; selected: boolean }[] = [];
    for (const { object, curve } of this.drawn) {
      for (const key of curve.keys) {
        out.push({
          channelPath: curve.channelPath,
          frame: key.frame,
          value: key.value,
          selected: this.selection.has(selId(object.id, curve.channelPath, key.frame)),
        });
      }
    }
    return out;
  }

  private handlesShownScreen(): { channelPath: string; frame: number; side: 'l' | 'r'; x: number; y: number }[] {
    const r = this.canvas.getBoundingClientRect();
    return this.handles.map((h) => {
      const [x, y] = this.viewToPx(h.vf, h.vv);
      return { channelPath: h.channelPath, frame: h.frame, side: h.side, x: r.left + x, y: r.top + y };
    });
  }

  // --- Frame loop ----------------------------------------------------------

  update(): void {
    this.resize();
    if (this.accentTick-- <= 0) {
      this.accentTick = 60;
      const a = getComputedStyle(document.documentElement).getPropertyValue('--vb-accent').trim();
      if (a) this.accent = a;
    }
    this.drawn = this.computeDrawn();
    this.handles = this.computeHandles();
    if (!this.didInitialFit && this.drawn.length && this.cssW > 0) this.fit();
    const names = [...new Set(this.scene.selectedObjects.map((o) => o.name))];
    this.titleEl.textContent = names.length ? names.join(', ') : 'Graph Editor';
    this.draw();
  }

  private resize(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    const dpr = window.devicePixelRatio || 1;
    if (w !== this.cssW || h !== this.cssH || this.canvas.width !== Math.round(w * dpr)) {
      this.cssW = w;
      this.cssH = h;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  private draw(): void {
    const c = this.ctx2d;
    const W = this.cssW, H = this.cssH;
    if (W === 0 || H === 0) return;
    const plotBottom = H - RULER_H;

    c.clearRect(0, 0, W, H);
    c.fillStyle = '#1c1c1c';
    c.fillRect(0, 0, W, H);

    // --- Value grid (horizontal) + left labels ---
    const [, vTop] = this.pxToView(0, PAD_TOP);
    const [, vBot] = this.pxToView(0, plotBottom);
    const vStep = niceStep(vTop - vBot, Math.max(2, plotBottom / 50));
    c.font = '10px monospace';
    c.textBaseline = 'middle';
    const vFirst = Math.ceil(vBot / vStep) * vStep;
    for (let v = vFirst; v <= vTop; v += vStep) {
      const [, y] = this.viewToPx(0, v);
      c.strokeStyle = Math.abs(v) < vStep / 2 ? '#454545' : '#2c2c2c';
      c.beginPath();
      c.moveTo(PAD_LEFT, y + 0.5);
      c.lineTo(W - PAD_RIGHT, y + 0.5);
      c.stroke();
      c.fillStyle = '#8a8a8a';
      c.textAlign = 'right';
      c.fillText(formatValue(v, vStep), PAD_LEFT - 5, y);
    }

    // --- Frame grid (vertical) + bottom ruler ---
    const [fLeft] = this.pxToView(PAD_LEFT, 0);
    const [fRight] = this.pxToView(W - PAD_RIGHT, 0);
    const fStep = Math.max(1, Math.round(niceStep(fRight - fLeft, Math.max(2, (W - PAD_LEFT - PAD_RIGHT) / 70))));
    c.fillStyle = '#262626';
    c.fillRect(0, plotBottom, W, RULER_H);
    const fFirst = Math.ceil(fLeft / fStep) * fStep;
    for (let f = fFirst; f <= fRight; f += fStep) {
      const [x] = this.viewToPx(f, 0);
      if (x < PAD_LEFT) continue;
      c.strokeStyle = '#2c2c2c';
      c.beginPath();
      c.moveTo(x + 0.5, PAD_TOP);
      c.lineTo(x + 0.5, plotBottom);
      c.stroke();
      c.fillStyle = '#9a9a9a';
      c.textAlign = 'center';
      c.fillText(String(f), x, plotBottom + RULER_H / 2);
    }

    // --- Current frame line ---
    const [cfx] = this.viewToPx(this.scene.frameCurrent, 0);
    if (cfx >= PAD_LEFT && cfx <= W - PAD_RIGHT) {
      c.strokeStyle = this.accent;
      c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(cfx + 0.5, PAD_TOP);
      c.lineTo(cfx + 0.5, plotBottom);
      c.stroke();
      c.lineWidth = 1;
    }

    // --- Curves (clip to plot) ---
    c.save();
    c.beginPath();
    c.rect(PAD_LEFT, PAD_TOP, W - PAD_LEFT - PAD_RIGHT, plotBottom - PAD_TOP);
    c.clip();
    for (const { curve } of this.drawn) {
      c.strokeStyle = channelColor(curve.channelPath);
      c.lineWidth = 1.5;
      c.beginPath();
      let started = false;
      for (let px = PAD_LEFT; px <= W - PAD_RIGHT; px++) {
        const [f] = this.pxToView(px, 0);
        const [, y] = this.viewToPx(0, evalFCurve(curve, f));
        if (!started) { c.moveTo(px, y); started = true; } else c.lineTo(px, y);
      }
      c.stroke();
    }
    c.lineWidth = 1;

    // --- Handles (behind keys) for selected keys ---
    for (const h of this.handles) {
      const [kx, ky] = this.viewToPx(h.frame, this.keyValueOf(h));
      const [hx, hy] = this.viewToPx(h.vf, h.vv);
      c.strokeStyle = '#7a7a7a';
      c.beginPath();
      c.moveTo(kx, ky);
      c.lineTo(hx, hy);
      c.stroke();
      c.fillStyle = '#d8d8d8';
      c.fillRect(hx - 2.5, hy - 2.5, 5, 5);
    }

    // --- Keys (diamonds) ---
    for (const { object, curve } of this.drawn) {
      const color = channelColor(curve.channelPath);
      for (const key of curve.keys) {
        const [x, y] = this.viewToPx(key.frame, key.value);
        const selected = this.selection.has(selId(object.id, curve.channelPath, key.frame));
        this.drawDiamond(x, y, color, selected);
      }
    }
    c.restore();
  }

  /** The value of the key a handle belongs to (for drawing its stem). */
  private keyValueOf(h: HandleInfo): number {
    const curve = h.object.anim && findCurve(h.object.anim, h.channelPath);
    const key = curve?.keys.find((k) => k.frame === h.frame);
    return key ? key.value : h.vv;
  }

  private drawDiamond(x: number, y: number, color: string, selected: boolean): void {
    const c = this.ctx2d;
    const r = selected ? 5.5 : 4;
    c.beginPath();
    c.moveTo(x, y - r);
    c.lineTo(x + r, y);
    c.lineTo(x, y + r);
    c.lineTo(x - r, y);
    c.closePath();
    if (selected) {
      c.fillStyle = '#ffffff';
      c.fill();
      c.strokeStyle = color;
      c.lineWidth = 1.5;
      c.stroke();
      c.lineWidth = 1;
    } else {
      c.fillStyle = color;
      c.fill();
      c.strokeStyle = '#111';
      c.stroke();
    }
  }
}

/** Compact value label — integers when the step is whole, else 2–3 decimals. */
function formatValue(v: number, step: number): string {
  const snapped = Math.abs(v) < step / 2 ? 0 : v;
  if (Number.isInteger(step)) return String(Math.round(snapped));
  const dec = step < 0.1 ? 3 : 2;
  return snapped.toFixed(dec);
}
