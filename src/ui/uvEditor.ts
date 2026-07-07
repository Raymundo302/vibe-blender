/**
 * UV Editor (P11-2) — a second workspace editor type with its OWN 2D canvas.
 *
 * Draws the active mesh object's per-corner UVs over the [0,1]² frame with a
 * procedural checker background, lets you select islands (connected faces that
 * share UV-space corners), and run modal G/R/S transforms that mutate
 * `mesh.uvs` through ONE MeshEditCommand per confirmed gesture.
 *
 * Interactions live on the editor element (NOT InputManager): click selects the
 * island under the cursor, shift-click adds, A / Alt+A select-all / clear, the
 * wheel zooms, MMB pans. Selection is one-way synced into the 3D edit-mode face
 * selection when edit mode is active on the same object.
 *
 * The pure geometry helpers (island detection, point-in-polygon pick, transform
 * math) are exported for unit testing and carry no DOM dependency.
 */
import type { EditableMesh } from '../core/mesh/EditableMesh';
import type { Scene } from '../core/scene/Scene';
import type { UndoStack } from '../core/undo/UndoStack';
import { MeshEditCommand } from '../core/undo/meshCommands';
import './uvEditor.css';

export type UV = [number, number];

/** Corners within this UV-space distance are treated as the same point. */
export const UV_EPSILON = 1e-4;

// --- Pure geometry helpers (unit-tested) -----------------------------------

/**
 * Group the mesh's UV-carrying faces into islands: two faces belong to the same
 * island when they share at least one UV corner (within UV_EPSILON). Returns an
 * array of faceId arrays, ordered by first face appearance (deterministic).
 */
export function computeUVIslands(mesh: EditableMesh): number[][] {
  const faceIds = [...mesh.uvs.keys()];
  const parent = new Map<number, number>();
  for (const f of faceIds) parent.set(f, f);
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) { const n = parent.get(x)!; parent.set(x, r); x = n; }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a); const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const q = (n: number): number => Math.round(n / UV_EPSILON);
  const cornerOwner = new Map<string, number>();
  for (const f of faceIds) {
    for (const [u, v] of mesh.uvs.get(f)!) {
      const key = `${q(u)},${q(v)}`;
      const owner = cornerOwner.get(key);
      if (owner === undefined) cornerOwner.set(key, f);
      else union(owner, f);
    }
  }

  const groups = new Map<number, number[]>();
  const order: number[] = [];
  for (const f of faceIds) {
    const r = find(f);
    if (!groups.has(r)) { groups.set(r, []); order.push(r); }
    groups.get(r)!.push(f);
  }
  return order.map((r) => groups.get(r)!);
}

/** Standard even-odd ray-cast point-in-polygon test (polygon in UV space). */
export function pointInPolygon(poly: UV[], p: UV): boolean {
  let inside = false;
  const [px, py] = p;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersect = (yi > py) !== (yj > py)
      && px < ((xj - xi) * (py - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Pick the island (index into `islands`) whose any face contains the UV point,
 * or -1. Scans back-to-front so later-drawn islands win on overlap.
 */
export function pickUVIsland(mesh: EditableMesh, islands: number[][], p: UV): number {
  for (let i = islands.length - 1; i >= 0; i--) {
    for (const f of islands[i]) {
      const poly = mesh.uvs.get(f);
      if (poly && pointInPolygon(poly, p)) return i;
    }
  }
  return -1;
}

/** Centroid of every UV corner across the given faces (pivot for R / S). */
export function facesCentroid(mesh: EditableMesh, faceIds: Iterable<number>): UV {
  let sx = 0; let sy = 0; let n = 0;
  for (const f of faceIds) {
    const poly = mesh.uvs.get(f);
    if (!poly) continue;
    for (const [u, v] of poly) { sx += u; sy += v; n++; }
  }
  return n === 0 ? [0.5, 0.5] : [sx / n, sy / n];
}

export type UVXform = (uv: UV) => UV;

export const translateUV = (du: number, dv: number): UVXform =>
  ([u, v]) => [u + du, v + dv];

export const scaleUV = (factor: number, [px, py]: UV): UVXform =>
  ([u, v]) => [px + (u - px) * factor, py + (v - py) * factor];

export const rotateUV = (angle: number, [px, py]: UV): UVXform => {
  const c = Math.cos(angle); const s = Math.sin(angle);
  return ([u, v]) => {
    const dx = u - px; const dy = v - py;
    return [px + dx * c - dy * s, py + dx * s + dy * c];
  };
};

/**
 * Apply a UV transform to a set of faces, reading each face's ORIGINAL corners
 * from `orig` (so repeated live application during a modal gesture is absolute,
 * not cumulative). Returns a map faceId → new corner array; does not mutate.
 */
export function transformFaceUVs(
  faceIds: Iterable<number>,
  orig: Map<number, UV[]>,
  xform: UVXform,
): Map<number, UV[]> {
  const out = new Map<number, UV[]>();
  for (const f of faceIds) {
    const poly = orig.get(f);
    if (poly) out.set(f, poly.map((uv) => xform(uv)));
  }
  return out;
}

// --- The editor -------------------------------------------------------------

type TransformMode = 'translate' | 'rotate' | 'scale';

export interface UVEditorDeps {
  scene: Scene;
  undo: UndoStack;
}

export class UVEditor {
  readonly element: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx2d: CanvasRenderingContext2D;
  private readonly emptyEl: HTMLElement;
  private readonly scene: Scene;
  private readonly undo: UndoStack;

  // View transform: unit square centered, pan in CSS px, multiplicative zoom.
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private cssW = 0;
  private cssH = 0;

  /** Selected faces (island membership is derived each frame). */
  private readonly selectedFaces = new Set<number>();
  private islands: number[][] = [];
  private hoverIsland = -1;
  private pointerUV: UV = [0.5, 0.5];

  // Modal transform state.
  private transform: null | {
    mode: TransformMode;
    startUV: UV;
    pivot: UV;
    orig: Map<number, UV[]>;
    before: EditableMesh;
    mesh: EditableMesh;
  } = null;

  // MMB pan state.
  private panning: null | { x: number; y: number } = null;

  private accent = '#fe730f';
  private accentTick = 0;

  private readonly onWheel: (e: WheelEvent) => void;
  private readonly onPointerDown: (e: PointerEvent) => void;
  private readonly onPointerMove: (e: PointerEvent) => void;
  private readonly onPointerUp: (e: PointerEvent) => void;
  private readonly onPointerEnter: () => void;
  private readonly onPointerLeave: () => void;
  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private hovered = false;

  constructor(deps: UVEditorDeps) {
    this.scene = deps.scene;
    this.undo = deps.undo;

    this.element = document.createElement('div');
    this.element.className = 'uv-editor';
    this.element.tabIndex = 0;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'uv-editor-canvas';
    this.ctx2d = this.canvas.getContext('2d')!;
    this.element.append(this.canvas);

    this.emptyEl = document.createElement('div');
    this.emptyEl.className = 'uv-editor-empty';
    this.emptyEl.textContent = 'Select a mesh with UVs — U to unwrap in the viewport';
    this.element.append(this.emptyEl);

    // Interactions on the editor element (NOT InputManager).
    this.onWheel = (e) => this.handleWheel(e);
    this.onPointerDown = (e) => this.handlePointerDown(e);
    this.onPointerMove = (e) => this.handlePointerMove(e);
    this.onPointerUp = (e) => this.handlePointerUp(e);
    this.onPointerEnter = () => { this.hovered = true; };
    this.onPointerLeave = () => { this.hovered = false; };
    this.onKeyDown = (e) => this.handleKeyDown(e);

    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.element.addEventListener('pointerdown', this.onPointerDown);
    this.element.addEventListener('pointermove', this.onPointerMove);
    // Capture release + moves globally so drags survive leaving the element.
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointermove', this.onPointerMove);
    this.element.addEventListener('pointerenter', this.onPointerEnter);
    this.element.addEventListener('pointerleave', this.onPointerLeave);
    // Keys act only when this editor is hovered or focused (never globally).
    window.addEventListener('keydown', this.onKeyDown, true);

    // Debug handle for e2e (harmless in production).
    (this.element as unknown as Record<string, unknown>).__uvEditor = {
      islandCount: () => this.islands.length,
      selectedFaces: () => [...this.selectedFaces],
      hoverIsland: () => this.hoverIsland,
      canvas: this.canvas,
      pixelAt: (cssX: number, cssY: number) => this.pixelAt(cssX, cssY),
      selectAt: (cssX: number, cssY: number, additive = false) =>
        this.selectAt(cssX, cssY, additive),
      transforming: () => this.transform?.mode ?? null,
    };
  }

  destroy(): void {
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.element.removeEventListener('pointerdown', this.onPointerDown);
    this.element.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointermove', this.onPointerMove);
    this.element.removeEventListener('pointerenter', this.onPointerEnter);
    this.element.removeEventListener('pointerleave', this.onPointerLeave);
    window.removeEventListener('keydown', this.onKeyDown, true);
  }

  // --- Mesh resolution ------------------------------------------------------

  /** The active mesh object's BASE mesh (same rule as edit mode), or null. */
  private activeMesh(): EditableMesh | null {
    const obj = this.scene.activeObject;
    if (!obj || obj.kind !== 'mesh') return null;
    return obj.mesh;
  }

  // --- View math ------------------------------------------------------------

  private size(): number { return Math.min(this.cssW, this.cssH) * 0.8; }

  private uvToPx([u, v]: UV): UV {
    const s = this.size() * this.zoom;
    return [
      this.cssW / 2 + (u - 0.5) * s + this.panX,
      this.cssH / 2 - (v - 0.5) * s + this.panY,
    ];
  }

  private pxToUv(x: number, y: number): UV {
    const s = this.size() * this.zoom;
    return [
      (x - this.cssW / 2 - this.panX) / s + 0.5,
      0.5 - (y - this.cssH / 2 - this.panY) / s,
    ];
  }

  private localXY(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  // --- Interaction handlers -------------------------------------------------

  private isActiveContext(): boolean {
    const a = document.activeElement;
    if (a && a !== this.element && a !== this.canvas
      && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return false;
    return this.hovered || this.element.contains(a) || a === this.canvas;
  }

  private handleWheel(e: WheelEvent): void {
    e.preventDefault();
    const [mx, my] = this.localXY(e);
    const before = this.pxToUv(mx, my);
    const factor = Math.exp(-e.deltaY * 0.0015);
    this.zoom = Math.max(0.05, Math.min(50, this.zoom * factor));
    // Keep the UV under the cursor fixed.
    const s = this.size() * this.zoom;
    this.panX = mx - this.cssW / 2 - (before[0] - 0.5) * s;
    this.panY = my - this.cssH / 2 + (before[1] - 0.5) * s;
  }

  private handlePointerDown(e: PointerEvent): void {
    this.element.focus();
    if (e.button === 1) {
      // MMB pan.
      e.preventDefault();
      this.panning = { x: e.clientX, y: e.clientY };
      return;
    }
    if (this.transform) {
      if (e.button === 0) this.confirmTransform();
      else if (e.button === 2) this.cancelTransform();
      e.preventDefault();
      return;
    }
    if (e.button === 0) {
      const [mx, my] = this.localXY(e);
      this.selectAt(mx, my, e.shiftKey);
    }
  }

  private handlePointerMove(e: PointerEvent): void {
    const [mx, my] = this.localXY(e);
    this.pointerUV = this.pxToUv(mx, my);
    if (this.panning) {
      this.panX += e.clientX - this.panning.x;
      this.panY += e.clientY - this.panning.y;
      this.panning = { x: e.clientX, y: e.clientY };
      return;
    }
    if (this.transform) { this.updateTransform(); return; }
    // Hover highlight.
    const mesh = this.activeMesh();
    this.hoverIsland = mesh ? pickUVIsland(mesh, this.islands, this.pointerUV) : -1;
  }

  private handlePointerUp(e: PointerEvent): void {
    if (e.button === 1) this.panning = null;
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (!this.isActiveContext()) return;
    const mesh = this.activeMesh();

    if (this.transform) {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); this.confirmTransform(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.cancelTransform(); }
      return;
    }

    const k = e.key.toLowerCase();
    if (k === 'a' && e.altKey) {
      e.preventDefault(); e.stopPropagation();
      this.selectedFaces.clear();
      this.syncTo3D();
    } else if (k === 'a') {
      e.preventDefault(); e.stopPropagation();
      if (mesh) for (const f of mesh.uvs.keys()) this.selectedFaces.add(f);
      this.syncTo3D();
    } else if (k === 'g' || k === 'r' || k === 's') {
      if (!mesh || this.selectedFaces.size === 0) return;
      e.preventDefault(); e.stopPropagation();
      this.beginTransform(k === 'g' ? 'translate' : k === 'r' ? 'rotate' : 'scale', mesh);
    }
  }

  /** Select the island under a canvas-local point (additive with shift). */
  private selectAt(cssX: number, cssY: number, additive: boolean): void {
    const mesh = this.activeMesh();
    if (!mesh) return;
    const uv = this.pxToUv(cssX, cssY);
    const idx = pickUVIsland(mesh, this.islands, uv);
    if (!additive) this.selectedFaces.clear();
    if (idx >= 0) {
      for (const f of this.islands[idx]) this.selectedFaces.add(f);
    }
    this.syncTo3D();
  }

  // --- Modal transform ------------------------------------------------------

  private beginTransform(mode: TransformMode, mesh: EditableMesh): void {
    const faces = [...this.selectedFaces].filter((f) => mesh.uvs.has(f));
    if (faces.length === 0) return;
    const orig = new Map<number, UV[]>();
    for (const f of faces) orig.set(f, mesh.uvs.get(f)!.map(([u, v]) => [u, v] as UV));
    this.transform = {
      mode,
      startUV: [...this.pointerUV] as UV,
      pivot: facesCentroid(mesh, faces),
      orig,
      before: mesh.clone(),
      mesh,
    };
  }

  private updateTransform(): void {
    const tr = this.transform;
    if (!tr) return;
    let xform: UVXform;
    if (tr.mode === 'translate') {
      xform = translateUV(this.pointerUV[0] - tr.startUV[0], this.pointerUV[1] - tr.startUV[1]);
    } else if (tr.mode === 'scale') {
      const d0 = Math.hypot(tr.startUV[0] - tr.pivot[0], tr.startUV[1] - tr.pivot[1]);
      const d1 = Math.hypot(this.pointerUV[0] - tr.pivot[0], this.pointerUV[1] - tr.pivot[1]);
      xform = scaleUV(d0 < 1e-6 ? 1 : d1 / d0, tr.pivot);
    } else {
      const a0 = Math.atan2(tr.startUV[1] - tr.pivot[1], tr.startUV[0] - tr.pivot[0]);
      const a1 = Math.atan2(this.pointerUV[1] - tr.pivot[1], this.pointerUV[0] - tr.pivot[0]);
      xform = rotateUV(a1 - a0, tr.pivot);
    }
    for (const [f, poly] of transformFaceUVs(tr.orig.keys(), tr.orig, xform)) {
      tr.mesh.setFaceUVs(f, poly);
    }
  }

  private confirmTransform(): void {
    const tr = this.transform;
    if (!tr) return;
    this.transform = null;
    const label = tr.mode === 'translate' ? 'UV Move' : tr.mode === 'rotate' ? 'UV Rotate' : 'UV Scale';
    this.undo.push(MeshEditCommand.fromSnapshots(label, tr.mesh, tr.before, tr.mesh.clone()));
  }

  private cancelTransform(): void {
    const tr = this.transform;
    if (!tr) return;
    this.transform = null;
    tr.mesh.copyFrom(tr.before);
  }

  /**
   * One-way sync: mirror the selected islands into the 3D edit-mode face
   * selection when edit mode is active on this same object.
   */
  private syncTo3D(): void {
    const em = this.scene.editMode;
    const obj = this.scene.activeObject;
    if (!em || !obj || em.objectId !== obj.id) return;
    const mesh = obj.mesh;
    em.setElementMode('face', mesh);
    em.faces.clear();
    for (const f of this.selectedFaces) if (mesh.faces.has(f)) em.faces.add(f);
    em.touch();
  }

  // --- Rendering ------------------------------------------------------------

  update(): void {
    this.resizeToBody();
    if (this.accentTick-- <= 0) {
      this.accentTick = 60;
      const a = getComputedStyle(document.documentElement).getPropertyValue('--vb-accent').trim();
      if (a) this.accent = a;
    }
    const mesh = this.activeMesh();
    this.islands = mesh ? computeUVIslands(mesh) : [];
    // Drop selected faces that no longer carry UVs (topology/undo).
    for (const f of [...this.selectedFaces]) if (!mesh || !mesh.uvs.has(f)) this.selectedFaces.delete(f);
    this.emptyEl.style.display = mesh && mesh.uvs.size > 0 ? 'none' : '';
    this.draw(mesh);
  }

  private resizeToBody(): void {
    const w = this.element.clientWidth;
    const h = this.element.clientHeight;
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

  private draw(mesh: EditableMesh | null): void {
    const c = this.ctx2d;
    const W = this.cssW; const H = this.cssH;
    if (W === 0 || H === 0) return;
    c.clearRect(0, 0, W, H);
    c.fillStyle = '#1a1a1a';
    c.fillRect(0, 0, W, H);

    this.drawChecker();
    this.drawGridAndFrame();
    if (mesh) this.drawUVs(mesh);
  }

  /** Procedural 8×8 checker filling the [0,1]² square (canvas 2D). */
  private drawChecker(): void {
    const c = this.ctx2d;
    const N = 8;
    for (let iy = 0; iy < N; iy++) {
      for (let ix = 0; ix < N; ix++) {
        const light = (ix + iy) % 2 === 0;
        c.fillStyle = light ? '#4a4a4a' : '#3a3a3a';
        const p0 = this.uvToPx([ix / N, (iy + 1) / N]); // top-left in px (v up)
        const p1 = this.uvToPx([(ix + 1) / N, iy / N]); // bottom-right in px
        c.fillRect(p0[0], p0[1], p1[0] - p0[0], p1[1] - p0[1]);
      }
    }
  }

  private drawGridAndFrame(): void {
    const c = this.ctx2d;
    c.lineWidth = 1;
    c.strokeStyle = 'rgba(255,255,255,0.06)';
    c.beginPath();
    for (let i = 1; i < 8; i++) {
      const a = this.uvToPx([i / 8, 0]); const b = this.uvToPx([i / 8, 1]);
      c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]);
      const d = this.uvToPx([0, i / 8]); const e = this.uvToPx([1, i / 8]);
      c.moveTo(d[0], d[1]); c.lineTo(e[0], e[1]);
    }
    c.stroke();
    // [0,1]² frame.
    const tl = this.uvToPx([0, 1]); const br = this.uvToPx([1, 0]);
    c.strokeStyle = 'rgba(255,255,255,0.35)';
    c.lineWidth = 1.5;
    c.strokeRect(tl[0], tl[1], br[0] - tl[0], br[1] - tl[1]);
  }

  private drawUVs(mesh: EditableMesh): void {
    const c = this.ctx2d;
    const inIsland = (arr: number[]): boolean => arr.some((f) => this.selectedFaces.has(f));
    this.islands.forEach((island, idx) => {
      const selected = inIsland(island);
      const hovered = idx === this.hoverIsland;
      for (const f of island) {
        const poly = mesh.uvs.get(f);
        if (!poly || poly.length < 2) continue;
        c.beginPath();
        poly.forEach((uv, i) => {
          const [x, y] = this.uvToPx(uv);
          if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
        });
        c.closePath();
        c.fillStyle = selected ? this.rgba(this.accent, 0.22) : 'rgba(210,210,210,0.05)';
        c.fill();
        c.lineWidth = selected ? 1.6 : 1;
        c.strokeStyle = selected
          ? this.accent
          : hovered ? this.rgba(this.accent, 0.6) : 'rgba(220,220,220,0.5)';
        c.stroke();
      }
    });
  }

  /** Parse a #rrggbb (or existing rgb/rgba) accent to an rgba() with alpha. */
  private rgba(color: string, alpha: number): string {
    const m = /^#([0-9a-f]{6})$/i.exec(color);
    if (m) {
      const n = parseInt(m[1], 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
    }
    return color;
  }

  /** Read back a device pixel [r,g,b,a] at a canvas-local CSS coordinate. */
  private pixelAt(cssX: number, cssY: number): [number, number, number, number] {
    const dpr = window.devicePixelRatio || 1;
    const d = this.ctx2d.getImageData(Math.round(cssX * dpr), Math.round(cssY * dpr), 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  }
}
