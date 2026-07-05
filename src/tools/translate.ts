import type { Operator, OperatorContext, PointerState } from '../core/operator/Operator';
import type { SceneObject } from '../core/scene/Scene';
import type { Transform } from '../core/math/transform';
import { Vec3 } from '../core/math/vec3';
import { rayPlane } from '../core/math/ray';
import { TransformCommand } from '../core/undo/commands';

type AxisLock = 'x' | 'y' | 'z' | null;

/**
 * G — move the selection. Blender semantics: freely in the view plane through
 * the pivot; X/Y/Z constrain to a world axis (pressing the same axis again
 * unlocks); LMB/Enter confirm, RMB/Esc cancel.
 */
export class TranslateOperator implements Operator {
  readonly name = 'Move';

  private targets: { object: SceneObject; before: Transform }[] = [];
  private pivot = Vec3.ZERO;
  private startHit = Vec3.ZERO;
  private delta = Vec3.ZERO;
  private axis: AxisLock = null;
  private lastPointer: PointerState = { x: 0, y: 0 };

  start(ctx: OperatorContext, pointer: PointerState): boolean {
    const selected = ctx.scene.selectedObjects;
    if (selected.length === 0) return false;

    this.targets = selected.map((object) => ({ object, before: object.transform }));
    let sum = Vec3.ZERO;
    for (const t of this.targets) sum = sum.add(t.object.transform.position);
    this.pivot = sum.scale(1 / this.targets.length);

    const hit = this.planeHit(ctx, pointer);
    if (!hit) return false;
    this.startHit = hit;
    this.lastPointer = pointer;
    this.updateStatus(ctx);
    return true;
  }

  /** Intersect the pointer ray with the move plane (view-plane, or axis-constrained). */
  private planeHit(ctx: OperatorContext, pointer: PointerState): Vec3 | null {
    const { width, height } = ctx.viewportSize();
    const ray = ctx.camera.pointerRay(pointer.x, pointer.y, width, height);
    const forward = ctx.camera.forward;

    if (!this.axis) return rayPlane(ray, this.pivot, forward);

    // Axis lock: use the plane containing the axis that faces the camera most
    const axisDir = this.axis === 'x' ? Vec3.X : this.axis === 'y' ? Vec3.Y : Vec3.Z;
    const planeNormal = axisDir.cross(forward).cross(axisDir).normalize();
    const hit = rayPlane(ray, this.pivot, planeNormal);
    if (!hit) return null;
    // Project the hit onto the axis line through the pivot
    return this.pivot.add(axisDir.scale(hit.sub(this.pivot).dot(axisDir)));
  }

  onPointerMove(ctx: OperatorContext, pointer: PointerState): void {
    this.lastPointer = pointer;
    const hit = this.planeHit(ctx, pointer);
    if (!hit) return;
    this.delta = hit.sub(this.startHit);
    for (const t of this.targets) {
      t.object.transform = t.before.withPosition(t.before.position.add(this.delta));
    }
    this.updateStatus(ctx);
  }

  onKey(ctx: OperatorContext, key: string): boolean {
    const k = key.toLowerCase();
    if (k !== 'x' && k !== 'y' && k !== 'z') return false;
    this.axis = this.axis === k ? null : k;
    // Recompute from the new constraint plane so the selection doesn't jump
    const hit = this.planeHit(ctx, this.lastPointer);
    if (hit) this.startHit = hit.sub(this.delta);
    this.onPointerMove(ctx, this.lastPointer);
    return true;
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
    const lock = this.axis ? `  [${this.axis.toUpperCase()} axis]` : '  [X/Y/Z: lock axis]';
    ctx.setStatus(
      `Move  Dx: ${d.x.toFixed(3)}  Dy: ${d.y.toFixed(3)}  Dz: ${d.z.toFixed(3)}${lock}  ` +
        `LMB/Enter: confirm  RMB/Esc: cancel`,
    );
  }
}
