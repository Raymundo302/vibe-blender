import type { Operator, OperatorContext, PointerState } from '../core/operator/Operator';
import { Vec3 } from '../core/math/vec3';
import type { Mat4 } from '../core/math/mat4';
import { rayPlane } from '../core/math/ray';
import { cloneCurveData, type CurveData, type CurvePoint } from '../core/scene/objectData';
import { leftHandle, rightHandle } from '../core/curve/eval';
import { parseHandleKey } from '../core/curve/CurveEdit';
import { CurveCommand } from '../core/undo/curveCommands';
import type { SceneObject } from '../core/scene/Scene';

type AxisLock = 'x' | 'y' | 'z' | null;

const v = (a: [number, number, number]): Vec3 => new Vec3(a[0], a[1], a[2]);
const arr = (p: Vec3): [number, number, number] => [p.x, p.y, p.z];

/**
 * G in curve edit mode (UR11-1): move the selected control points / handles.
 * Mirrors TranslateOperator (view-plane drag, X/Y/Z world-axis locks) but writes
 * the curve payload instead of object transforms, wrapped in ONE CurveCommand.
 *
 * Moving an anchor (co) drags its two handles along; moving one handle mirrors
 * the other when they were mirrored at the start of the drag.
 */
export class CurveMoveOperator implements Operator {
  readonly name = 'Move';
  readonly continuousGrab = true;

  private obj!: SceneObject;
  private snapshot!: CurveData;
  private world!: Mat4;
  private invWorld!: Mat4;
  private pointIdx = new Set<number>();
  private handleKeys: { index: number; side: 'hl' | 'hr' }[] = [];
  private pivot = Vec3.ZERO;
  private startHit = Vec3.ZERO;
  private delta = Vec3.ZERO;
  private axis: AxisLock = null;
  private lastPointer: PointerState = { x: 0, y: 0 };

  start(ctx: OperatorContext, pointer: PointerState): boolean {
    const scene = ctx.scene;
    const sel = scene.curveEdit;
    const obj = scene.curveEditObject;
    if (!sel || !obj || !obj.curve || !sel.hasAnySelection()) return false;
    this.obj = obj;
    this.snapshot = cloneCurveData(obj.curve);
    this.world = scene.worldMatrix(obj);
    this.invWorld = this.world.invert();

    this.pointIdx = new Set(sel.points);
    // A handle whose anchor is also selected rides the anchor — skip it here.
    this.handleKeys = [...sel.handles]
      .map(parseHandleKey)
      .filter((h) => !this.pointIdx.has(h.index) && h.index < this.snapshot.points.length);

    // Pivot = world centroid of every moving element's start position.
    const worldPts: Vec3[] = [];
    for (const i of this.pointIdx) {
      const p = this.snapshot.points[i];
      if (p) worldPts.push(this.world.transformPoint(v(p.co)));
    }
    for (const h of this.handleKeys) {
      const p = this.snapshot.points[h.index];
      const hv = h.side === 'hl' ? leftHandle(p) : rightHandle(p);
      worldPts.push(this.world.transformPoint(hv));
    }
    if (worldPts.length === 0) return false;
    let sum = Vec3.ZERO;
    for (const p of worldPts) sum = sum.add(p);
    this.pivot = sum.scale(1 / worldPts.length);

    const hit = this.planeHit(ctx, pointer);
    if (!hit) return false;
    this.startHit = hit;
    this.lastPointer = pointer;
    this.updateStatus(ctx);
    return true;
  }

  private planeHit(ctx: OperatorContext, pointer: PointerState): Vec3 | null {
    const { width, height } = ctx.viewportSize();
    const ray = ctx.camera.pointerRay(pointer.x, pointer.y, width, height);
    const forward = ctx.camera.forward;
    if (!this.axis) return rayPlane(ray, this.pivot, forward);
    const axisDir = this.axis === 'x' ? Vec3.X : this.axis === 'y' ? Vec3.Y : Vec3.Z;
    const planeNormal = axisDir.cross(forward).cross(axisDir).normalize();
    const hit = rayPlane(ray, this.pivot, planeNormal);
    if (!hit) return null;
    return this.pivot.add(axisDir.scale(hit.sub(this.pivot).dot(axisDir)));
  }

  onPointerMove(ctx: OperatorContext, pointer: PointerState): void {
    this.lastPointer = pointer;
    const hit = this.planeHit(ctx, pointer);
    if (!hit) return;
    this.delta = hit.sub(this.startHit);
    this.apply();
    this.updateStatus(ctx);
  }

  /** Rebuild the curve from the snapshot with the current (local) delta applied. */
  private apply(): void {
    const dLocal = this.invWorld.transformDir(this.delta);
    const next = cloneCurveData(this.snapshot);
    const pts = next.points;

    // Anchors: move co + both handles (materialize auto handles so they ride).
    for (const i of this.pointIdx) {
      const src = this.snapshot.points[i];
      const p = pts[i];
      if (!src || !p) continue;
      p.co = arr(v(src.co).add(dLocal));
      p.hl = arr(leftHandle(src).add(dLocal));
      p.hr = arr(rightHandle(src).add(dLocal));
    }

    // Handles: move the handle; mirror the opposite when they were mirrored.
    for (const h of this.handleKeys) {
      const src = this.snapshot.points[h.index];
      const p = pts[h.index];
      if (!src || !p) continue;
      const coV = v(src.co);
      const thisH = h.side === 'hl' ? leftHandle(src) : rightHandle(src);
      const other = h.side === 'hl' ? rightHandle(src) : leftHandle(src);
      const moved = thisH.add(dLocal);
      // Mirrored iff the opposite handle was the reflection of this one about co.
      const mirrored = other.equalsApprox(coV.scale(2).sub(thisH), 1e-6);
      if (h.side === 'hl') {
        p.hl = arr(moved);
        if (mirrored) p.hr = arr(coV.scale(2).sub(moved));
      } else {
        p.hr = arr(moved);
        if (mirrored) p.hl = arr(coV.scale(2).sub(moved));
      }
    }

    this.obj.curve = next;
  }

  onKey(ctx: OperatorContext, key: string): boolean {
    const k = key.toLowerCase();
    if (k !== 'x' && k !== 'y' && k !== 'z') return false;
    this.axis = this.axis === k ? null : (k as AxisLock);
    const hit = this.planeHit(ctx, this.lastPointer);
    if (hit) this.startHit = hit.sub(this.delta);
    this.onPointerMove(ctx, this.lastPointer);
    return true;
  }

  axisIndicator(): { axis: 'x' | 'y' | 'z'; pivot: Vec3 } | null {
    return this.axis ? { axis: this.axis, pivot: this.pivot } : null;
  }

  confirm(ctx: OperatorContext): void {
    this.apply();
    ctx.undo.push(CurveCommand.fromSnapshots('Move', this.obj, this.snapshot, this.obj.curve!));
    ctx.scene.curveEdit?.touch();
    ctx.setStatus('');
  }

  cancel(ctx: OperatorContext): void {
    this.obj.curve = cloneCurveData(this.snapshot);
    ctx.scene.curveEdit?.touch();
    ctx.setStatus('');
  }

  private updateStatus(ctx: OperatorContext): void {
    const d = this.delta;
    const lock = this.axis ? `  [${this.axis.toUpperCase()} axis]` : '  [X/Y/Z: lock axis]';
    ctx.setStatus(
      `Move  Dx: ${d.x.toFixed(3)}  Dy: ${d.y.toFixed(3)}  Dz: ${d.z.toFixed(3)}${lock}  LMB/Enter: confirm  RMB/Esc: cancel`,
    );
  }
}

/** Append a new control point after the last (Ctrl+click). `worldPos` is the
 *  world-space placement; converts to local + inherits the curve style. Returns
 *  the new point's index. */
export function appendCurvePoint(curve: CurveData, invWorld: Mat4, worldPos: Vec3): number {
  const local = invWorld.transformPoint(worldPos);
  const point: CurvePoint = { co: arr(local) };
  if (curve.kind === 'bezier') {
    // Small mirrored handles along the direction from the previous point.
    const prev = curve.points[curve.points.length - 1];
    const dir = prev ? local.sub(v(prev.co)) : Vec3.X;
    const t = dir.lengthSq() > 1e-9 ? dir.normalize().scale(Math.min(0.5, dir.length() * 0.33)) : new Vec3(0.3, 0, 0);
    point.hl = arr(local.sub(t));
    point.hr = arr(local.add(t));
  } else {
    point.w = 1;
  }
  curve.points.push(point);
  return curve.points.length - 1;
}
