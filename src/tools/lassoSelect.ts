import type { Operator, OperatorContext, PointerState } from '../core/operator/Operator';
import type { EditableMesh } from '../core/mesh/EditableMesh';
import type { ElementMode } from '../core/scene/EditMode';
import type { Mat4 } from '../core/math/mat4';
import { Vec3 } from '../core/math/vec3';
import { elementIndexMaps } from '../core/mesh/editOverlayData';
import { projectToScreen } from './boxSelect';
import { captureSelection, commitSelectionChange, type SelectionSnapshot } from './circleSelect';

/** A screen-space point in CSS pixels. */
export interface Pt {
  x: number;
  y: number;
}

/**
 * Even-odd (ray-cast) point-in-polygon test. Casts a ray to +x from `pt` and
 * counts polygon edge crossings; an odd count means inside. Pure and
 * unit-testable — handles convex, concave and self-touching loops. A point
 * exactly on an edge is treated by the standard half-open crossing rule (result
 * is deterministic but boundary-membership is not guaranteed, matching the usual
 * even-odd convention).
 */
export function pointInPolygon(pt: Pt, poly: Pt[]): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = poly[i];
    const b = poly[j];
    const intersects =
      a.y > pt.y !== b.y > pt.y &&
      pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Pure inside-lasso test. Each element contributes ONE projected test point —
 * vert position / edge midpoint / face centroid — and joins the result when
 * that point is inside the polygon. `mvp` = proj·view·model so local coordinates
 * project straight to CSS pixels. Like box select this is a screen-projection
 * test with NO depth/occlusion (selects through geometry, same as box today).
 */
export function elementsInLasso(
  mesh: EditableMesh,
  mode: ElementMode,
  mvp: Mat4,
  width: number,
  height: number,
  poly: Pt[],
): { verts: number[]; edges: string[]; faces: number[] } {
  const maps = elementIndexMaps(mesh);
  const test = (local: Vec3): boolean => {
    const p = projectToScreen(local, mvp, width, height);
    return p !== null && pointInPolygon(p, poly);
  };

  const out = { verts: [] as number[], edges: [] as string[], faces: [] as number[] };
  if (mode === 'vert') {
    for (const id of maps.vertIds) {
      const v = mesh.verts.get(id);
      if (v && test(v.co)) out.verts.push(id);
    }
  } else if (mode === 'edge') {
    const edges = mesh.edges();
    for (const key of maps.edgeKeys) {
      const e = edges.get(key);
      if (!e) continue;
      const a = mesh.verts.get(e.v0);
      const b = mesh.verts.get(e.v1);
      if (a && b && test(a.co.add(b.co).scale(0.5))) out.edges.push(key);
    }
  } else {
    for (const fid of maps.faceIds) {
      const f = mesh.faces.get(fid);
      if (!f || f.verts.length === 0) continue;
      let c = Vec3.ZERO;
      let ok = true;
      for (const vid of f.verts) {
        const v = mesh.verts.get(vid);
        if (!v) { ok = false; break; }
        c = c.add(v.co);
      }
      if (ok && test(c.scale(1 / f.verts.length))) out.faces.push(fid);
    }
  }
  return out;
}

/**
 * Lasso ("random squiggle") select — LMB-drag draws a freehand polyline
 * (preview overlay like knife's); on release the loop closes and every element
 * whose projected test point falls inside the polygon joins the selection.
 * SHIFT (held at release) EXTENDS the current selection; a plain lasso REPLACES
 * it — matching box select's read-modifier-at-release convention (box reads
 * Shift at release too). The whole thing is ONE undo entry (or none when the
 * selection is unchanged). Esc/RMB before release cancels with the selection
 * untouched.
 */
export class LassoSelectOperator implements Operator {
  readonly name = 'Lasso Select';
  readonly continuousGrab = false;

  private points: Pt[] = [];
  drawing = false;
  private extend = false;
  private before: SelectionSnapshot | null = null;
  private svg: SVGSVGElement | null = null;

  constructor(private readonly parent: HTMLElement) {}

  start(ctx: OperatorContext, _pointer: PointerState): boolean {
    const sel = ctx.scene.editMode;
    if (!sel || !ctx.scene.editObject) return false;
    this.before = captureSelection(sel);
    this.createOverlay();
    ctx.setStatus('Lasso select — drag a loop, Shift+release extends, Esc/RMB: cancel');
    return true;
  }

  /** InputManager: LMB pressed → start collecting the freehand loop. */
  begin(pointer: PointerState): void {
    this.drawing = true;
    this.points = [{ x: pointer.x, y: pointer.y }];
    this.redraw();
  }

  /** InputManager: Shift state at LMB release (extend vs replace). */
  setExtend(extend: boolean): void {
    this.extend = extend;
  }

  onPointerMove(_ctx: OperatorContext, pointer: PointerState): void {
    if (this.drawing) {
      const last = this.points.at(-1);
      // Skip near-duplicate samples so the polygon stays lean.
      if (!last || Math.hypot(pointer.x - last.x, pointer.y - last.y) >= 2) {
        this.points.push({ x: pointer.x, y: pointer.y });
      }
      this.redraw();
    }
  }

  onKey(): boolean {
    return false;
  }

  confirm(ctx: OperatorContext): void {
    this.apply(ctx);
    this.cleanup(ctx);
  }

  cancel(ctx: OperatorContext): void {
    // Cancelled mid-draw (Esc/RMB): selection untouched.
    this.cleanup(ctx);
  }

  private apply(ctx: OperatorContext): void {
    const sel = ctx.scene.editMode;
    const obj = ctx.scene.editObject;
    if (!sel || !obj || this.points.length < 3 || !this.before) return;
    const { width, height } = ctx.viewportSize();
    const mvp = ctx.camera
      .projMatrix(width / height)
      .mul(ctx.camera.viewMatrix())
      .mul(ctx.scene.worldMatrix(obj));
    const hits = elementsInLasso(obj.mesh, sel.elementMode, mvp, width, height, this.points);

    if (!this.extend) {
      sel.verts.clear();
      sel.edges.clear();
      sel.faces.clear();
    }
    if (sel.elementMode === 'vert') {
      for (const id of hits.verts) sel.verts.add(id);
    } else if (sel.elementMode === 'edge') {
      for (const key of hits.edges) sel.edges.add(key);
    } else {
      for (const id of hits.faces) sel.faces.add(id);
    }
    sel.touch();
    commitSelectionChange(ctx.undo, sel, this.before, 'Lasso Select');
  }

  // --- SVG overlay (mirrors knife's screen-space overlay) --------------------

  private createOverlay(): void {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'lasso-select-overlay');
    Object.assign(svg.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      zIndex: '30',
    } as CSSStyleDeclaration);
    this.parent.appendChild(svg);
    this.svg = svg;
  }

  private redraw(): void {
    const svg = this.svg;
    if (!svg || this.points.length === 0) return;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const NS = 'http://www.w3.org/2000/svg';
    const YELLOW = '#ffd91a';
    // The freehand chain plus a dashed closing segment back to the start.
    const chain = this.points.map((p) => `${p.x},${p.y}`).join(' ');
    const poly = document.createElementNS(NS, 'polyline');
    poly.setAttribute('points', chain);
    poly.setAttribute('fill', 'rgba(255,217,26,0.08)');
    poly.setAttribute('stroke', YELLOW);
    poly.setAttribute('stroke-width', '1.5');
    svg.appendChild(poly);
    const first = this.points[0];
    const last = this.points.at(-1)!;
    const close = document.createElementNS(NS, 'line');
    close.setAttribute('x1', String(last.x));
    close.setAttribute('y1', String(last.y));
    close.setAttribute('x2', String(first.x));
    close.setAttribute('y2', String(first.y));
    close.setAttribute('stroke', YELLOW);
    close.setAttribute('stroke-width', '1.5');
    close.setAttribute('stroke-dasharray', '4 4');
    svg.appendChild(close);
  }

  private cleanup(ctx: OperatorContext): void {
    this.svg?.remove();
    this.svg = null;
    this.points = [];
    this.drawing = false;
    this.before = null;
    ctx.setStatus('');
  }
}
