import type { Operator, OperatorContext, PointerState } from '../core/operator/Operator';
import type { SceneObject } from '../core/scene/Scene';
import type { EditModeState } from '../core/scene/EditMode';
import type { EditableMesh } from '../core/mesh/EditableMesh';
import type { Mat4 } from '../core/math/mat4';
import { Vec3 } from '../core/math/vec3';
import { Quat } from '../core/math/quat';
import { rayPlane } from '../core/math/ray';
import { MeshEditCommand } from '../core/undo/meshCommands';
import { NumericInput } from './numericInput';

type AxisLock = 'x' | 'y' | 'z' | null;

/** Median (average) of a set of points; ZERO for an empty list. */
export function centroid(points: Vec3[]): Vec3 {
  if (points.length === 0) return Vec3.ZERO;
  let sum = Vec3.ZERO;
  for (const p of points) sum = sum.add(p);
  return sum.scale(1 / points.length);
}

/**
 * Convert a world-space translation delta into the edit object's local space.
 * Vert coordinates are LOCAL, so a world pointer delta must be pushed through
 * the inverse model matrix as a direction (no translation component).
 */
export function worldDeltaToLocal(delta: Vec3, invMatrix: Mat4): Vec3 {
  return invMatrix.transformDir(delta);
}

/**
 * Shared setup + undo plumbing for the edit-mode G/R/S operators. Each subclass
 * previews by writing local vert positions via `setVertCo`; on confirm we follow
 * the "modal GEOMETRY tools" undo pattern (restore, then push a capture()).
 */
abstract class EditTransformBase implements Operator {
  abstract readonly name: string;

  protected mesh!: EditableMesh;
  protected sel!: EditModeState;
  protected affected: number[] = [];
  /** Local coordinates at start, keyed by vert id — the "before" for undo. */
  protected before = new Map<number, Vec3>();
  /** World coordinates at start (for rotate/scale offset math). */
  protected worldBefore = new Map<number, Vec3>();
  /** Pivot = world-space centroid of the affected verts. */
  protected pivot = Vec3.ZERO;
  protected pivotScreen = { x: 0, y: 0 };
  /** Inverse model matrix: world → local for writing back. */
  protected invMatrix!: Mat4;
  protected lastPointer: PointerState = { x: 0, y: 0 };

  start(ctx: OperatorContext, pointer: PointerState): boolean {
    const sel = ctx.scene.editMode;
    const obj = ctx.scene.editObject;
    if (!sel || !obj) return false;
    const ids = [...sel.selectedVertIds(obj.mesh)];
    if (ids.length === 0) return false;

    this.sel = sel;
    this.mesh = obj.mesh;
    this.affected = ids;
    const m = obj.transform.matrix();
    this.invMatrix = m.invert();

    const worldPts: Vec3[] = [];
    for (const id of ids) {
      const co = obj.mesh.verts.get(id)!.co;
      this.before.set(id, co);
      const w = m.transformPoint(co);
      this.worldBefore.set(id, w);
      worldPts.push(w);
    }
    this.pivot = centroid(worldPts);
    this.pivotScreen = this.projectPivot(ctx, obj);
    this.lastPointer = pointer;
    return this.onStart(ctx, pointer);
  }

  /** Project the world pivot to CSS pixels (conventions formula). */
  protected projectPivot(ctx: OperatorContext, _obj: SceneObject): { x: number; y: number } {
    const { width, height } = ctx.viewportSize();
    const ndc = ctx.camera.projMatrix(width / height).mul(ctx.camera.viewMatrix()).transformPoint(this.pivot);
    return { x: ((ndc.x + 1) / 2) * width, y: ((1 - ndc.y) / 2) * height };
  }

  /** Write a world position back to a vert as its local coordinate. */
  protected setWorld(id: number, world: Vec3): void {
    this.mesh.setVertCo(id, this.invMatrix.transformPoint(world));
  }

  /** Subclass hook after shared setup; return false to abort. */
  protected abstract onStart(ctx: OperatorContext, pointer: PointerState): boolean;

  abstract onPointerMove(ctx: OperatorContext, pointer: PointerState): void;
  abstract onKey(ctx: OperatorContext, key: string): boolean;

  confirm(ctx: OperatorContext): void {
    // Capture the previewed (final) positions, restore the starting positions,
    // then push a command that re-applies the finals — see the conventions doc.
    const after = new Map<number, Vec3>();
    for (const id of this.affected) after.set(id, this.mesh.verts.get(id)!.co);
    for (const [id, co] of this.before) this.mesh.setVertCo(id, co);
    ctx.undo.push(
      MeshEditCommand.capture(this.name, this.mesh, () => {
        for (const [id, co] of after) this.mesh.setVertCo(id, co);
      }),
    );
    this.sel.touch();
    ctx.setStatus('');
  }

  cancel(ctx: OperatorContext): void {
    for (const [id, co] of this.before) this.mesh.setVertCo(id, co);
    this.sel.touch();
    ctx.setStatus('');
  }
}

/**
 * G (edit mode) — move the selected verts. Freely in the view plane through the
 * pivot; X/Y/Z constrain to a world axis (same key again unlocks). Deltas are
 * computed in world space then converted to local before writing.
 */
export class EditTranslateOperator extends EditTransformBase {
  readonly name = 'Move';

  private startHit = Vec3.ZERO;
  private delta = Vec3.ZERO;
  private axis: AxisLock = null;

  protected onStart(ctx: OperatorContext, pointer: PointerState): boolean {
    const hit = this.planeHit(ctx, pointer);
    if (!hit) return false;
    this.startHit = hit;
    this.updateStatus(ctx);
    return true;
  }

  /** Intersect the pointer ray with the move plane (view-plane, or axis-line). */
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
    const local = worldDeltaToLocal(this.delta, this.invMatrix);
    for (const id of this.affected) this.mesh.setVertCo(id, this.before.get(id)!.add(local));
    this.updateStatus(ctx);
  }

  onKey(ctx: OperatorContext, key: string): boolean {
    const k = key.toLowerCase();
    if (k !== 'x' && k !== 'y' && k !== 'z') return false;
    this.axis = this.axis === k ? null : k;
    const hit = this.planeHit(ctx, this.lastPointer);
    if (hit) this.startHit = hit.sub(this.delta);
    this.onPointerMove(ctx, this.lastPointer);
    return true;
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

/**
 * R (edit mode) — rotate the selected verts about the view axis through the
 * pivot; X/Y/Z lock a world axis (same key returns to the view axis). Typing a
 * number overrides the pointer (degrees).
 */
export class EditRotateOperator extends EditTransformBase {
  readonly name = 'Rotate';

  private axis: AxisLock = null;
  private readonly numeric = new NumericInput();
  private pointerAngle = 0;
  private lastRaw = 0;

  protected onStart(ctx: OperatorContext, pointer: PointerState): boolean {
    this.lastRaw = this.rawAngle(pointer);
    this.pointerAngle = 0;
    this.apply(ctx);
    return true;
  }

  private rawAngle(pointer: PointerState): number {
    return Math.atan2(pointer.y - this.pivotScreen.y, pointer.x - this.pivotScreen.x);
  }

  onPointerMove(ctx: OperatorContext, pointer: PointerState): void {
    const raw = this.rawAngle(pointer);
    let diff = raw - this.lastRaw;
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

  private apply(ctx: OperatorContext): void {
    const axisDir =
      this.axis === 'x' ? Vec3.X : this.axis === 'y' ? Vec3.Y : this.axis === 'z' ? Vec3.Z : ctx.camera.forward;
    const numeric = this.numeric.value;
    const angle = numeric !== null ? (numeric * Math.PI) / 180 : this.pointerAngle;
    const q = Quat.fromAxisAngle(axisDir, angle);

    for (const id of this.affected) {
      const offset = this.worldBefore.get(id)!.sub(this.pivot);
      this.setWorld(id, this.pivot.add(q.rotate(offset)));
    }
    this.updateStatus(ctx, angle);
  }

  private updateStatus(ctx: OperatorContext, angleRad: number): void {
    const angleText = this.numeric.text !== '' ? this.numeric.text : ((angleRad * 180) / Math.PI).toFixed(2);
    const lock = this.axis ? `  [${this.axis.toUpperCase()} axis]` : '  [view axis]';
    ctx.setStatus(`Rotate  ${angleText}°${lock}  LMB/Enter: confirm  RMB/Esc: cancel`);
  }
}

/**
 * S (edit mode) — scale the selected verts about the pivot. Uniform by default,
 * X/Y/Z lock a single world axis (same key returns to uniform). The factor is
 * the pointer's distance from the pivot's screen point relative to the start;
 * typing a number overrides it.
 */
export class EditScaleOperator extends EditTransformBase {
  readonly name = 'Scale';

  private axis: AxisLock = null;
  private readonly numeric = new NumericInput();
  private startDist = 1;
  private pointerFactor = 1;

  protected onStart(ctx: OperatorContext, pointer: PointerState): boolean {
    this.startDist = Math.max(2, this.dist(pointer));
    this.pointerFactor = 1;
    this.apply(ctx);
    return true;
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

  private apply(ctx: OperatorContext): void {
    const numeric = this.numeric.value;
    const f = numeric !== null ? numeric : this.pointerFactor;
    const sx = !this.axis || this.axis === 'x' ? f : 1;
    const sy = !this.axis || this.axis === 'y' ? f : 1;
    const sz = !this.axis || this.axis === 'z' ? f : 1;

    for (const id of this.affected) {
      const off = this.worldBefore.get(id)!.sub(this.pivot);
      this.setWorld(id, this.pivot.add(new Vec3(off.x * sx, off.y * sy, off.z * sz)));
    }
    this.updateStatus(ctx, f);
  }

  private updateStatus(ctx: OperatorContext, factor: number): void {
    const factorText = this.numeric.text !== '' ? this.numeric.text : factor.toFixed(3);
    const lock = this.axis ? `  [${this.axis.toUpperCase()} axis]` : '  [uniform]';
    ctx.setStatus(`Scale  ${factorText}${lock}  LMB/Enter: confirm  RMB/Esc: cancel`);
  }
}
