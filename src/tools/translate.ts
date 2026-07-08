import type { Operator, OperatorContext, PointerState } from '../core/operator/Operator';
import { Vec3 } from '../core/math/vec3';
import { rayPlane } from '../core/math/ray';
import { TransformCommand } from '../core/undo/commands';
import { snapActive, snapVec, SNAP_STEP } from '../core/snap';
import { captureWorldTargets, writeWorldPosition, type WorldTarget } from './worldTargets';

type AxisLock = 'x' | 'y' | 'z' | null;

/**
 * G — move the selection. Blender semantics: freely in the view plane through
 * the pivot; X/Y/Z constrain to a world axis (pressing the same axis again
 * unlocks); LMB/Enter confirm, RMB/Esc cancel.
 */
export class TranslateOperator implements Operator {
  readonly name = 'Move';

  private targets: WorldTarget[] = [];
  private pivot = Vec3.ZERO;
  private startHit = Vec3.ZERO;
  private delta = Vec3.ZERO;
  private axis: AxisLock = null;
  private lastPointer: PointerState = { x: 0, y: 0 };
  /** True while Ctrl is held during the modal — inverts the grid-snap state. */
  private ctrlHeld = false;

  /** `axis` presets the axis lock (used by the gizmo handle drag); default free. */
  constructor(axis: AxisLock = null) {
    this.axis = axis;
  }

  start(ctx: OperatorContext, pointer: PointerState): boolean {
    const selected = ctx.scene.selectedObjects;
    if (selected.length === 0) return false;

    this.targets = captureWorldTargets(ctx.scene, selected);
    let sum = Vec3.ZERO;
    for (const t of this.targets) sum = sum.add(t.beforeWorld.position);
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
    this.applyPositions(ctx);
  }

  /** Write the current delta to every target, snapping the RESULT world position
   *  onto the grid when snapping is effective (state XOR Ctrl-held). */
  private applyPositions(ctx: OperatorContext): void {
    const snap = snapActive(this.ctrlHeld);
    for (const t of this.targets) {
      let pos = t.beforeWorld.position.add(this.delta);
      if (snap) pos = snapVec(pos, SNAP_STEP);
      writeWorldPosition(t, pos);
    }
    this.updateStatus(ctx);
  }

  onKey(ctx: OperatorContext, key: string): boolean {
    // Ctrl held: invert the grid-snap state for as long as it's down.
    if (key === 'Control') {
      this.ctrlHeld = true;
      this.applyPositions(ctx);
      return true;
    }
    const k = key.toLowerCase();
    if (k !== 'x' && k !== 'y' && k !== 'z') return false;
    this.axis = this.axis === k ? null : k;
    // Recompute from the new constraint plane so the selection doesn't jump
    const hit = this.planeHit(ctx, this.lastPointer);
    if (hit) this.startHit = hit.sub(this.delta);
    this.onPointerMove(ctx, this.lastPointer);
    return true;
  }

  onKeyUp(ctx: OperatorContext, key: string): void {
    if (key === 'Control') {
      this.ctrlHeld = false;
      this.applyPositions(ctx);
    }
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
