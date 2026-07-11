import type { Operator, OperatorContext, PointerState } from '../core/operator/Operator';
import { Vec3 } from '../core/math/vec3';
import { TransformCommand } from '../core/undo/commands';
import { NumericInput } from './numericInput';
import { captureWorldTargets, transformPivot, writeWorldPosScale, type WorldTarget } from './worldTargets';

type AxisLock = 'x' | 'y' | 'z' | null;

/**
 * S — scale the selection. Blender semantics: the factor is the pointer's
 * distance from the pivot's screen point relative to where the drag started;
 * default is uniform, X/Y/Z lock a single world axis (pressing the same axis
 * again returns to uniform). Typing a number overrides the pointer (the factor
 * itself). LMB/Enter confirm, RMB/Esc cancel.
 */
export class ScaleOperator implements Operator {
  readonly name = 'Scale';
  readonly continuousGrab = true;

  private targets: WorldTarget[] = [];
  private pivot = Vec3.ZERO;
  private pivotScreen = { x: 0, y: 0 };
  private startDist = 1;
  private axis: AxisLock = null;
  private readonly numeric = new NumericInput();

  private pointerFactor = 1;

  start(ctx: OperatorContext, pointer: PointerState): boolean {
    const selected = ctx.scene.selectedObjects;
    if (selected.length === 0) return false;

    this.targets = captureWorldTargets(ctx.scene, selected);
    this.pivot = transformPivot(ctx.scene, this.targets);

    this.pivotScreen = this.projectPivot(ctx);
    // Guard the denominator: a start distance under 2px would blow up the factor.
    this.startDist = Math.max(2, this.dist(pointer));
    this.pointerFactor = 1;
    this.apply(ctx);
    return true;
  }

  /** Project the pivot to CSS pixels (conventions formula). */
  private projectPivot(ctx: OperatorContext): { x: number; y: number } {
    const { width, height } = ctx.viewportSize();
    const ndc = ctx.camera.projMatrix(width / height).mul(ctx.camera.viewMatrix()).transformPoint(this.pivot);
    return { x: ((ndc.x + 1) / 2) * width, y: ((1 - ndc.y) / 2) * height };
  }

  private dist(pointer: PointerState): number {
    const dx = pointer.x - this.pivotScreen.x;
    const dy = pointer.y - this.pivotScreen.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  onPointerMove(ctx: OperatorContext, pointer: PointerState): void {
    this.pointerFactor = this.dist(pointer) / this.startDist;
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
    const numeric = this.numeric.value;
    const f = numeric !== null ? numeric : this.pointerFactor;
    // Per-component factor: uniform scales all axes, an axis lock only its own.
    const sx = !this.axis || this.axis === 'x' ? f : 1;
    const sy = !this.axis || this.axis === 'y' ? f : 1;
    const sz = !this.axis || this.axis === 'z' ? f : 1;

    for (const t of this.targets) {
      const off = t.beforeWorld.position.sub(this.pivot);
      const pos = this.pivot.add(new Vec3(off.x * sx, off.y * sy, off.z * sz));
      writeWorldPosScale(t, pos, sx, sy, sz);
    }
    this.updateStatus(ctx, f);
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

  private updateStatus(ctx: OperatorContext, factor: number): void {
    const factorText = this.numeric.text !== '' ? this.numeric.text : factor.toFixed(3);
    const lock = this.axis ? `  [${this.axis.toUpperCase()} axis]` : '  [uniform]';
    ctx.setStatus(`Scale  ${factorText}${lock}  LMB/Enter: confirm  RMB/Esc: cancel`);
  }
}
