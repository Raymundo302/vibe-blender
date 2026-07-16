import type { Operator, OperatorContext, PointerState } from '../core/operator/Operator';
import { Vec3 } from '../core/math/vec3';
import type { Mat4 } from '../core/math/mat4';
import { rayPlane } from '../core/math/ray';
import { cloneSurfaceData, type SurfaceData } from '../core/scene/objectData';
import { SurfaceCommand } from '../core/undo/surfaceCommands';
import type { SceneObject } from '../core/scene/Scene';

type AxisLock = 'x' | 'y' | 'z' | null;

const v = (a: [number, number, number]): Vec3 => new Vec3(a[0], a[1], a[2]);
const arr = (p: Vec3): [number, number, number] => [p.x, p.y, p.z];

/**
 * G in surface edit mode (NB-A2): move the selected control-net points. The
 * surface analogue of CurveMoveOperator — view-plane drag with X/Y/Z world-axis
 * locks, but writes the SurfaceData control net (no handles) wrapped in ONE
 * SurfaceCommand. The surface driver re-tessellates the mesh from the payload
 * automatically, so this never touches geometry directly.
 */
export class SurfaceMoveOperator implements Operator {
  readonly name = 'Move';
  readonly continuousGrab = true;

  private obj!: SceneObject;
  private snapshot!: SurfaceData;
  private world!: Mat4;
  private invWorld!: Mat4;
  private pointIdx = new Set<number>();
  private pivot = Vec3.ZERO;
  private startHit = Vec3.ZERO;
  private delta = Vec3.ZERO;
  private axis: AxisLock = null;
  private lastPointer: PointerState = { x: 0, y: 0 };

  start(ctx: OperatorContext, pointer: PointerState): boolean {
    const scene = ctx.scene;
    const sel = scene.surfaceEdit;
    const obj = scene.surfaceEditObject;
    if (!sel || !obj || !obj.surface || !sel.hasAnySelection()) return false;
    this.obj = obj;
    this.snapshot = cloneSurfaceData(obj.surface);
    this.world = scene.worldMatrix(obj);
    this.invWorld = this.world.invert();

    this.pointIdx = new Set([...sel.points].filter((i) => i < this.snapshot.points.length));
    if (this.pointIdx.size === 0) return false;

    // Pivot = world centroid of every moving point's start position.
    let sum = Vec3.ZERO;
    let n = 0;
    for (const i of this.pointIdx) {
      const p = this.snapshot.points[i];
      if (!p) continue;
      sum = sum.add(this.world.transformPoint(v(p.co)));
      n++;
    }
    if (n === 0) return false;
    this.pivot = sum.scale(1 / n);

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

  /** Rebuild the surface from the snapshot with the current (local) delta applied. */
  private apply(): void {
    const dLocal = this.invWorld.transformDir(this.delta);
    const next = cloneSurfaceData(this.snapshot);
    for (const i of this.pointIdx) {
      const src = this.snapshot.points[i];
      const p = next.points[i];
      if (!src || !p) continue;
      p.co = arr(v(src.co).add(dLocal));
    }
    this.obj.surface = next;
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
    ctx.undo.push(SurfaceCommand.fromSnapshots('Move Points', this.obj, this.snapshot, this.obj.surface!));
    ctx.scene.surfaceEdit?.touch();
    ctx.setStatus('');
  }

  cancel(ctx: OperatorContext): void {
    this.obj.surface = cloneSurfaceData(this.snapshot);
    ctx.scene.surfaceEdit?.touch();
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
