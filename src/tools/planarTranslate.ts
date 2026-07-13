import type { Operator, OperatorContext, PointerState } from '../core/operator/Operator';
import { Vec3 } from '../core/math/vec3';
import { Mat4 } from '../core/math/mat4';
import { rayPlane } from '../core/math/ray';
import { TransformCommand } from '../core/undo/commands';
import { snapActive, SNAP_STEP } from '../core/snap';
import { captureWorldTargets, writeWorldPosition, type WorldTarget } from './worldTargets';
import { gizmoPlaneModelMatrix, PLANE_AXES, type GizmoPlane, type GizmoAxis } from '../render/passes/gizmoPass';

/**
 * Planar move — started by grabbing one of the gizmo's three center plane
 * handles (XY / YZ / XZ). The selection slides freely WITHIN that plane through
 * the gizmo pivot; the third axis is pinned. The plane is taken in the active
 * transform orientation (Global → world planes, Local/Normal → the object's
 * basis), so grabbing the XY handle on a rotated object moves in that object's
 * XY. While it runs the viewport reorients the floor grid onto the drag plane
 * (workPlane()), and grid-snap snaps the result onto that reoriented grid.
 */
export class PlanarTranslateOperator implements Operator {
  readonly name = 'Move';
  readonly continuousGrab = true;

  private targets: WorldTarget[] = [];
  private origin = Vec3.ZERO; // gizmo pivot: plane passes through here
  private uDir = Vec3.X; //     in-plane basis (the two spanned axes)
  private vDir = Vec3.Y;
  private normal = Vec3.Z; //   the pinned third axis
  private orient = Mat4.identity();
  private startHit = Vec3.ZERO;
  private delta = Vec3.ZERO;
  private ctrlHeld = false;

  constructor(private readonly plane: GizmoPlane) {}

  start(ctx: OperatorContext, pointer: PointerState): boolean {
    const selected = ctx.scene.selectedObjects;
    if (selected.length === 0) return false;
    this.targets = captureWorldTargets(ctx.scene, selected);

    // Anchor the plane at the gizmo pivot with the active orientation, matching
    // exactly where the handle was drawn.
    this.origin = ctx.scene.pivotPoint();
    const oq = ctx.scene.orientationQuat();
    this.orient = Mat4.fromQuat(oq);
    const dir: Record<GizmoAxis, Vec3> = {
      x: oq.rotate(Vec3.X).normalize(),
      y: oq.rotate(Vec3.Y).normalize(),
      z: oq.rotate(Vec3.Z).normalize(),
    };
    const [a, b] = PLANE_AXES[this.plane];
    this.uDir = dir[a];
    this.vDir = dir[b];
    this.normal = this.uDir.cross(this.vDir).normalize();

    const hit = this.planeHit(ctx, pointer);
    if (!hit) return false;
    this.startHit = hit;
    this.updateStatus(ctx);
    return true;
  }

  /** Intersect the pointer ray with the constraint plane (through origin). */
  private planeHit(ctx: OperatorContext, pointer: PointerState): Vec3 | null {
    const { width, height } = ctx.viewportSize();
    const ray = ctx.camera.pointerRay(pointer.x, pointer.y, width, height);
    return rayPlane(ray, this.origin, this.normal);
  }

  onPointerMove(ctx: OperatorContext, pointer: PointerState): void {
    const hit = this.planeHit(ctx, pointer);
    if (!hit) return;
    this.delta = hit.sub(this.startHit);
    this.applyPositions(ctx);
  }

  /** Write the current in-plane delta to every target, snapping the RESULT onto
   *  the reoriented grid (in plane-local u/v) when snapping is effective. */
  private applyPositions(ctx: OperatorContext): void {
    const snap = snapActive(this.ctrlHeld);
    for (const t of this.targets) {
      let pos = t.beforeWorld.position.add(this.delta);
      if (snap) pos = this.snapInPlane(pos);
      writeWorldPosition(t, pos);
    }
    this.updateStatus(ctx);
  }

  /** Snap a world position onto the plane-local grid centered at the origin —
   *  round its u/v components to SNAP_STEP, keep the (near-zero) normal offset. */
  private snapInPlane(pos: Vec3): Vec3 {
    const o = pos.sub(this.origin);
    const u = Math.round(o.dot(this.uDir) / SNAP_STEP) * SNAP_STEP;
    const v = Math.round(o.dot(this.vDir) / SNAP_STEP) * SNAP_STEP;
    const n = o.dot(this.normal); // preserved (should already be ~0 in-plane)
    return this.origin.add(this.uDir.scale(u)).add(this.vDir.scale(v)).add(this.normal.scale(n));
  }

  onKey(ctx: OperatorContext, key: string): boolean {
    if (key === 'Control') {
      this.ctrlHeld = true;
      this.applyPositions(ctx);
      return true;
    }
    return false;
  }

  onKeyUp(ctx: OperatorContext, key: string): void {
    if (key === 'Control') {
      this.ctrlHeld = false;
      this.applyPositions(ctx);
    }
  }

  /** Reorient the floor grid onto the drag plane at the gizmo while dragging. */
  workPlane(): Mat4 | null {
    return gizmoPlaneModelMatrix(this.origin, 1, this.plane, this.orient);
  }

  confirm(ctx: OperatorContext): void {
    ctx.undo.push(
      new TransformCommand(
        this.name,
        this.targets.map((t) => ({ object: t.object, before: t.before, after: t.object.transform })),
      ),
    );
    ctx.setStatus('');
  }

  cancel(ctx: OperatorContext): void {
    for (const t of this.targets) t.object.transform = t.before;
    ctx.setStatus('');
  }

  private updateStatus(ctx: OperatorContext): void {
    const d = this.delta;
    ctx.setStatus(
      `Move  [${this.plane.toUpperCase()} plane]  Dx: ${d.x.toFixed(3)}  Dy: ${d.y.toFixed(3)}  Dz: ${d.z.toFixed(3)}  ` +
        `LMB/Enter: confirm  RMB/Esc: cancel`,
    );
  }
}
