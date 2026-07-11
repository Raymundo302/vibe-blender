import type { Operator, OperatorContext, PointerState } from '../core/operator/Operator';
import { Vec3 } from '../core/math/vec3';
import { Quat } from '../core/math/quat';
import { TransformCommand } from '../core/undo/commands';
import { NumericInput } from './numericInput';
import { captureWorldTargets, transformPivot, writeWorldPosRot, type WorldTarget } from './worldTargets';

type AxisLock = 'x' | 'y' | 'z' | null;

/**
 * R — rotate the selection. Blender semantics: the pointer sweeps an angle
 * around the pivot's screen projection; default axis is the view axis (camera
 * forward), X/Y/Z lock a world axis (pressing the same axis again returns to
 * the view axis). Typing a number overrides the pointer (degrees).
 * LMB/Enter confirm, RMB/Esc cancel.
 */
export class RotateOperator implements Operator {
  readonly name = 'Rotate';
  readonly continuousGrab = true;

  private targets: WorldTarget[] = [];
  private pivot = Vec3.ZERO;
  private pivotScreen = { x: 0, y: 0 };
  private axis: AxisLock = null;
  private readonly numeric = new NumericInput();

  /** Accumulated pointer-swept angle (radians), tracked across the ±π seam. */
  private pointerAngle = 0;
  private lastRaw = 0;

  start(ctx: OperatorContext, pointer: PointerState): boolean {
    const selected = ctx.scene.selectedObjects;
    if (selected.length === 0) return false;

    this.targets = captureWorldTargets(ctx.scene, selected);
    this.pivot = transformPivot(ctx.scene, this.targets);

    this.pivotScreen = this.projectPivot(ctx);
    this.lastRaw = this.rawAngle(pointer);
    this.pointerAngle = 0;
    this.apply(ctx);
    return true;
  }

  /** Project the pivot to CSS pixels (conventions formula). */
  private projectPivot(ctx: OperatorContext): { x: number; y: number } {
    const { width, height } = ctx.viewportSize();
    const ndc = ctx.camera.projMatrix(width / height).mul(ctx.camera.viewMatrix()).transformPoint(this.pivot);
    return { x: ((ndc.x + 1) / 2) * width, y: ((1 - ndc.y) / 2) * height };
  }

  /** Raw pointer angle around the pivot's screen point. */
  private rawAngle(pointer: PointerState): number {
    return Math.atan2(pointer.y - this.pivotScreen.y, pointer.x - this.pivotScreen.x);
  }

  onPointerMove(ctx: OperatorContext, pointer: PointerState): void {
    const raw = this.rawAngle(pointer);
    let diff = raw - this.lastRaw;
    // Accumulate across the ±π seam so dragging keeps going past 180°.
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff <= -Math.PI) diff += 2 * Math.PI;
    this.pointerAngle += diff;
    this.lastRaw = raw;
    this.apply(ctx);
  }

  onKey(ctx: OperatorContext, key: string): boolean {
    const k = key.toLowerCase();
    if (k === 'x' || k === 'y' || k === 'z') {
      this.axis = this.axis === k ? null : k;
      this.apply(ctx);
      return true;
    }
    if (this.numeric.handleKey(key)) {
      this.apply(ctx);
      return true;
    }
    return false;
  }

  /** Recompute every target's transform from its `before` state. */
  private apply(ctx: OperatorContext): void {
    const axisDir =
      this.axis === 'x' ? Vec3.X : this.axis === 'y' ? Vec3.Y : this.axis === 'z' ? Vec3.Z : ctx.camera.forward;
    const numeric = this.numeric.value;
    const angle = numeric !== null ? (numeric * Math.PI) / 180 : this.pointerAngle;
    const q = Quat.fromAxisAngle(axisDir, angle);

    for (const t of this.targets) {
      const offset = t.beforeWorld.position.sub(this.pivot);
      const pos = this.pivot.add(q.rotate(offset));
      const rot = q.mul(t.beforeWorld.rotation);
      writeWorldPosRot(t, pos, rot);
    }
    this.updateStatus(ctx, angle);
  }


  axisIndicator(): { axis: 'x' | 'y' | 'z'; pivot: Vec3 } | null {
    return this.axis ? { axis: this.axis, pivot: this.pivot } : null;
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

  private updateStatus(ctx: OperatorContext, angleRad: number): void {
    const angleText = this.numeric.text !== '' ? this.numeric.text : ((angleRad * 180) / Math.PI).toFixed(2);
    const lock = this.axis ? `  [${this.axis.toUpperCase()} axis]` : '  [view axis]';
    ctx.setStatus(`Rotate  ${angleText}°${lock}  LMB/Enter: confirm  RMB/Esc: cancel`);
  }
}
