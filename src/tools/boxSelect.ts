import type { Operator, OperatorContext, PointerState } from '../core/operator/Operator';
import type { EditableMesh } from '../core/mesh/EditableMesh';
import type { ElementMode, EditModeState } from '../core/scene/EditMode';
import type { Mat4 } from '../core/math/mat4';
import type { Vec3 } from '../core/math/vec3';
import { elementIndexMaps } from '../core/mesh/editOverlayData';

/** A screen-space rectangle in CSS pixels, normalized so x0<=x1 and y0<=y1. */
export interface ScreenRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Project a LOCAL vert coordinate to CSS pixels through a full model-view-
 * projection matrix. Returns null when the point is outside the clip depth
 * range [-1, 1] (behind the camera or past the far plane) — such points are
 * never "inside" the box. Uses the conventions projection formula.
 */
export function projectToScreen(
  local: Vec3,
  mvp: Mat4,
  width: number,
  height: number,
): { x: number; y: number } | null {
  const ndc = mvp.transformPoint(local);
  if (ndc.z < -1 || ndc.z > 1) return null;
  return { x: ((ndc.x + 1) / 2) * width, y: ((1 - ndc.y) / 2) * height };
}

function inRect(p: { x: number; y: number } | null, r: ScreenRect): boolean {
  return p !== null && p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;
}

/**
 * Pure inside-rect test for the current element mode. `mvp` = proj·view·model so
 * local vert coordinates map straight to CSS pixels. Membership rules match
 * Blender's box select: a vert counts when its projected point is inside; an
 * edge when BOTH endpoints are inside; a face when ALL its corners are inside.
 *
 * Box select is a pure screen-projection test with NO depth/occlusion, so it
 * behaves the same under X-ray or not (X-ray select-through is implemented in
 * the element-pick click path — see elementPickPass — because adding occlusion
 * here would change the frozen whole-cube box-select behavior other suites rely
 * on).
 */
export function elementsInRect(
  mesh: EditableMesh,
  mode: ElementMode,
  mvp: Mat4,
  width: number,
  height: number,
  rect: ScreenRect,
): { verts: number[]; edges: string[]; faces: number[] } {
  const maps = elementIndexMaps(mesh);
  const proj = new Map<number, { x: number; y: number } | null>();
  for (const [id, v] of mesh.verts) proj.set(id, projectToScreen(v.co, mvp, width, height));
  const inside = (id: number): boolean => inRect(proj.get(id) ?? null, rect);

  const out = { verts: [] as number[], edges: [] as string[], faces: [] as number[] };
  if (mode === 'vert') {
    for (const id of maps.vertIds) if (inside(id)) out.verts.push(id);
  } else if (mode === 'edge') {
    const edges = mesh.edges();
    for (const key of maps.edgeKeys) {
      const e = edges.get(key);
      if (e && inside(e.v0) && inside(e.v1)) out.edges.push(key);
    }
  } else {
    for (const fid of maps.faceIds) {
      const f = mesh.faces.get(fid);
      if (f && f.verts.every((v) => inside(v))) out.faces.push(fid);
    }
  }
  return out;
}

/**
 * Ctrl+I — invert the current element mode's selection against the full element
 * list. Elements currently selected become deselected and vice versa.
 */
export function invertSelection(sel: EditModeState, mesh: EditableMesh): void {
  const maps = elementIndexMaps(mesh);
  if (sel.elementMode === 'vert') {
    const cur = new Set(sel.verts);
    sel.verts.clear();
    for (const id of maps.vertIds) if (!cur.has(id)) sel.verts.add(id);
  } else if (sel.elementMode === 'edge') {
    const cur = new Set(sel.edges);
    sel.edges.clear();
    for (const key of maps.edgeKeys) if (!cur.has(key)) sel.edges.add(key);
  } else {
    const cur = new Set(sel.faces);
    sel.faces.clear();
    for (const id of maps.faceIds) if (!cur.has(id)) sel.faces.add(id);
  }
  sel.touch();
}

/**
 * B — box select. Unlike G, pressing B doesn't move anything and records no
 * anchor: the following LMB *drag* defines the box. InputManager anchors on the
 * first pointerdown (see `anchor`), resizes on pointer move, and confirms on
 * pointer *release* (like the gizmo drag). Elements inside are ADDED to the
 * current-mode selection, or REMOVED when Shift is held at release. Esc/RMB
 * cancels with the selection untouched.
 */
export class BoxSelectOperator implements Operator {
  readonly name = 'Box Select';

  /** True once the LMB has anchored the rectangle. */
  anchored = false;
  private subtract = false;
  private ax = 0;
  private ay = 0;
  private cx = 0;
  private cy = 0;
  private overlay: HTMLDivElement | null = null;

  constructor(private readonly parent: HTMLElement) {}

  start(ctx: OperatorContext, _pointer: PointerState): boolean {
    if (!ctx.scene.editMode || !ctx.scene.editObject) return false;
    ctx.setStatus('Box select — drag to add, Shift+release to remove, Esc/RMB cancel');
    return true;
  }

  /** First pointerdown: fix one corner and start drawing the overlay rect. */
  anchor(pointer: PointerState): void {
    this.ax = this.cx = pointer.x;
    this.ay = this.cy = pointer.y;
    this.anchored = true;
    this.overlay = document.createElement('div');
    this.overlay.className = 'box-select-rect';
    this.parent.appendChild(this.overlay);
    this.updateOverlay();
  }

  onPointerMove(_ctx: OperatorContext, pointer: PointerState): void {
    if (!this.anchored) return;
    this.cx = pointer.x;
    this.cy = pointer.y;
    this.updateOverlay();
  }

  onKey(_ctx: OperatorContext, _key: string): boolean {
    return false;
  }

  /** Set by InputManager from the release event's Shift state, then confirm. */
  setSubtract(subtract: boolean): void {
    this.subtract = subtract;
  }

  private rect(): ScreenRect {
    return {
      x0: Math.min(this.ax, this.cx),
      y0: Math.min(this.ay, this.cy),
      x1: Math.max(this.ax, this.cx),
      y1: Math.max(this.ay, this.cy),
    };
  }

  private updateOverlay(): void {
    if (!this.overlay) return;
    const r = this.rect();
    this.overlay.style.left = `${r.x0}px`;
    this.overlay.style.top = `${r.y0}px`;
    this.overlay.style.width = `${r.x1 - r.x0}px`;
    this.overlay.style.height = `${r.y1 - r.y0}px`;
  }

  private cleanup(): void {
    this.overlay?.remove();
    this.overlay = null;
  }

  confirm(ctx: OperatorContext): void {
    if (this.anchored) this.apply(ctx);
    this.cleanup();
    ctx.setStatus('');
  }

  cancel(ctx: OperatorContext): void {
    this.cleanup();
    ctx.setStatus('');
  }

  private apply(ctx: OperatorContext): void {
    const sel = ctx.scene.editMode;
    const obj = ctx.scene.editObject;
    if (!sel || !obj) return;
    const { width, height } = ctx.viewportSize();
    // mvp = proj · view · model — verts are local, so the model matrix goes first.
    const mvp = ctx.camera
      .projMatrix(width / height)
      .mul(ctx.camera.viewMatrix())
      .mul(ctx.scene.worldMatrix(obj));
    const hits = elementsInRect(obj.mesh, sel.elementMode, mvp, width, height, this.rect());

    if (sel.elementMode === 'vert') {
      for (const id of hits.verts) this.subtract ? sel.verts.delete(id) : sel.verts.add(id);
    } else if (sel.elementMode === 'edge') {
      for (const key of hits.edges) this.subtract ? sel.edges.delete(key) : sel.edges.add(key);
    } else {
      for (const id of hits.faces) this.subtract ? sel.faces.delete(id) : sel.faces.add(id);
    }
    sel.touch();
  }
}
