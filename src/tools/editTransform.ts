import type { Operator, OperatorContext, PointerState } from '../core/operator/Operator';
import type { SceneObject } from '../core/scene/Scene';
import type { EditModeState } from '../core/scene/EditMode';
import type { EditableMesh } from '../core/mesh/EditableMesh';
import type { Mat4 } from '../core/math/mat4';
import type { Renderer } from '../render/Renderer';
import { Vec3 } from '../core/math/vec3';
import { Quat } from '../core/math/quat';
import { rayPlane } from '../core/math/ray';
import { MeshEditCommand } from '../core/undo/meshCommands';
import { snapActive, snapVec, SNAP_STEP } from '../core/snap';
import { vertexNormals } from '../core/mesh/meshToGpu';
import { NumericInput } from './numericInput';

type AxisLock = 'x' | 'y' | 'z' | null;

/**
 * Proportional-editing settings. Module-level so the state (on/off + radius)
 * persists across operator invocations and is shared with the InputManager
 * (O toggle, wheel radius) and the circle overlay.
 *
 * Default radius is 1.0 world unit — a sane influence for a default-scale scene
 * (the startup cube is 2 units across, so ~half its extent). Because this is
 * module-level state that adjustRadius() mutates in place, the last radius the
 * user dialled in with the wheel is REMEMBERED for the rest of the session and
 * seeds every subsequent proportional transform (Blender behaviour).
 */
export interface ProportionalSettings {
  enabled: boolean;
  radius: number;
}
export const proportional: ProportionalSettings = { enabled: false, radius: 1.0 };

// Debug handle for e2e (harmless in production): read the live proportional
// default/last-used radius without importing the module.
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__proportional = proportional;
}

/**
 * Smooth-falloff weight for a vert at local distance `d` from the nearest
 * selected vert, given the influence `radius`. t = 1 − d/radius clamped to
 * [0,1]; weight = 3t²−2t³ (Blender's "Smooth" falloff). d=0 → 1, d=radius → 0,
 * d=radius/2 → 0.5, beyond radius → 0.
 */
export function proportionalFalloff(d: number, radius: number): number {
  if (radius <= 0) return d <= 0 ? 1 : 0;
  const t = 1 - d / radius;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

/**
 * Weight map for an edit transform. Selected verts always weigh 1. With
 * proportional editing on, each UNSELECTED vert additionally gets a smooth
 * falloff weight from its local distance to the NEAREST selected vert; verts
 * beyond the radius (weight 0) are omitted so callers can skip them.
 */
export function computeProportionalWeights(
  mesh: EditableMesh,
  selected: Set<number>,
  enabled: boolean,
  radius: number,
): Map<number, number> {
  const weights = new Map<number, number>();
  for (const id of selected) weights.set(id, 1);
  if (!enabled) return weights;

  const selCos: Vec3[] = [];
  for (const id of selected) {
    const v = mesh.verts.get(id);
    if (v) selCos.push(v.co);
  }
  for (const [id, vert] of mesh.verts) {
    if (selected.has(id)) continue;
    let dmin = Infinity;
    for (const s of selCos) {
      const d = vert.co.distanceTo(s);
      if (d < dmin) dmin = d;
    }
    const w = proportionalFalloff(dmin, radius);
    if (w > 0) weights.set(id, w);
  }
  return weights;
}

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
export abstract class EditTransformBase implements Operator {
  abstract readonly name: string;
  // Edit-mode G/R/S (and Shift+D duplicate, which subclasses EditTranslate) all
  // opt into continuous-grab pointer handling (UR4-1).
  readonly continuousGrab = true;

  protected mesh!: EditableMesh;
  protected sel!: EditModeState;
  /** Verts this op writes each frame. Proportional off: the selection only.
   *  Proportional on: EVERY vert (weight 0 → unchanged, sits at `before`). */
  protected affected: number[] = [];
  /** The selected verts (drive the pivot + are the falloff sources). */
  protected selectedSet = new Set<number>();
  /** Per-vert influence weight (see computeProportionalWeights). */
  protected weights = new Map<number, number>();
  /** True when this invocation runs with proportional editing on. */
  protected proportionalOn = false;
  /** Local coordinates at start, keyed by vert id — the "before" for undo. */
  protected before = new Map<number, Vec3>();
  /** World coordinates at start (for rotate/scale offset math). */
  protected worldBefore = new Map<number, Vec3>();
  /** Pivot = world-space centroid of the SELECTED verts. */
  protected pivot = Vec3.ZERO;
  protected pivotScreen = { x: 0, y: 0 };
  /** Inverse model matrix: world → local for writing back. */
  protected invMatrix!: Mat4;
  protected lastPointer: PointerState = { x: 0, y: 0 };
  /** WORLD-space axis basis for X/Y/Z locks, from the transform orientation:
   *  Global = world axes, Local = the object's rotation, Normal = the selection's
   *  averaged normal (Z) + a tangent frame. Computed once at start(). */
  protected axisBasis: { x: Vec3; y: Vec3; z: Vec3 } = { x: Vec3.X, y: Vec3.Y, z: Vec3.Z };

  /** Renderer is optional so unit tests can drive the op without a GL context;
   *  it is only used to draw/clear the proportional radius circle overlay. */
  constructor(protected readonly renderer?: Renderer) {}

  /** Whether the wheel should adjust the proportional radius (InputManager hook). */
  get proportionalActive(): boolean {
    return this.proportionalOn;
  }

  start(ctx: OperatorContext, pointer: PointerState): boolean {
    const sel = ctx.scene.editMode;
    const obj = ctx.scene.editObject;
    if (!sel || !obj) return false;
    const selectedIds = [...sel.selectedVertIds(obj.mesh)];
    if (selectedIds.length === 0) return false;

    this.sel = sel;
    this.mesh = obj.mesh;
    this.selectedSet = new Set(selectedIds);
    this.proportionalOn = proportional.enabled;
    const m = ctx.scene.worldMatrix(obj);
    this.invMatrix = m.invert();

    // Pivot = world centroid of the SELECTED verts (unselected verts only ride
    // along with a falloff weight, they don't shift the pivot).
    const selWorld: Vec3[] = [];
    for (const id of selectedIds) selWorld.push(m.transformPoint(obj.mesh.verts.get(id)!.co));
    this.pivot = centroid(selWorld);
    this.axisBasis = this.computeAxisBasis(ctx, obj, m);

    // Proportional on: capture EVERY vert so the weight map can grow/shrink
    // (via the wheel) without missing a "before" position. Off: selection only.
    this.affected = this.proportionalOn ? [...obj.mesh.verts.keys()] : selectedIds;
    for (const id of this.affected) {
      const co = obj.mesh.verts.get(id)!.co;
      this.before.set(id, co);
      this.worldBefore.set(id, m.transformPoint(co));
    }
    this.recomputeWeights();

    this.pivotScreen = this.projectPivot(ctx, obj);
    this.lastPointer = pointer;
    const ok = this.onStart(ctx, pointer);
    if (ok) this.updateCircle(ctx);
    return ok;
  }

  private recomputeWeights(): void {
    this.weights = computeProportionalWeights(this.mesh, this.selectedSet, this.proportionalOn, proportional.radius);
  }

  /**
   * The WORLD-space X/Y/Z basis for axis locks under the active transform
   * orientation. Global → world axes; Local → the edit object's world rotation;
   * Normal → the selection's averaged vertex normal as Z with an orthonormal
   * tangent frame (so `Z` moves/rotates/scales along the element normal). Falls
   * back to world axes when the normal is degenerate.
   */
  private computeAxisBasis(ctx: OperatorContext, obj: SceneObject, m: Mat4): { x: Vec3; y: Vec3; z: Vec3 } {
    const world = { x: Vec3.X, y: Vec3.Y, z: Vec3.Z };
    const orient = ctx.scene.transformOrientation;
    if (orient === 'global') return world;
    if (orient === 'local') {
      const q = ctx.scene.worldTransformOf(obj).rotation;
      return { x: q.rotate(Vec3.X).normalize(), y: q.rotate(Vec3.Y).normalize(), z: q.rotate(Vec3.Z).normalize() };
    }
    // Normal: average the selected verts' (locked) normals, take it to world as Z.
    const vn = vertexNormals(this.mesh);
    let nLocal = Vec3.ZERO;
    for (const id of this.selectedSet) {
      const n = vn.get(id);
      if (n) nLocal = nLocal.add(n);
    }
    let z = m.transformDir(nLocal); // rotation+uniform-scale correct; fine here
    if (z.length() < 1e-6) return world; // no faces → fall back to world axes
    z = z.normalize();
    const ref = Math.abs(z.z) < 0.9 ? Vec3.Z : Vec3.X;
    const x = ref.cross(z).normalize();
    const y = z.cross(x).normalize();
    return { x, y, z };
  }

  /** Influence weight for a vert (defaults to 1 for selected/plain transforms). */
  protected weightOf(id: number): number {
    return this.weights.get(id) ?? 0;
  }

  /**
   * Wheel hook: grow/shrink the proportional radius, rebuild the weight map and
   * circle overlay, and re-apply the in-progress transform so the deformation
   * updates live. No-op when proportional editing is off.
   */
  adjustRadius(ctx: OperatorContext, deltaY: number): void {
    if (!this.proportionalOn) return;
    const factor = deltaY < 0 ? 1.1 : 1 / 1.1;
    proportional.radius = Math.min(1000, Math.max(0.01, proportional.radius * factor));
    this.recomputeWeights();
    this.updateCircle(ctx);
    this.reapply(ctx);
    ctx.setStatus(`Proportional radius: ${proportional.radius.toFixed(2)}`);
  }

  /**
   * Draw the influence circle (48-segment polyline in the plane facing the
   * camera at the pivot) via the shared editPreviewLines channel, in the edit
   * object's LOCAL space (that overlay is rendered with the object matrix).
   */
  protected updateCircle(ctx: OperatorContext): void {
    if (!this.renderer || !this.proportionalOn) return;
    const pivotLocal = this.invMatrix.transformPoint(this.pivot);
    const f = this.invMatrix.transformDir(ctx.camera.forward).normalize();
    const ref = Math.abs(f.y) < 0.9 ? Vec3.Y : Vec3.X;
    const u = ref.cross(f).normalize();
    const v = f.cross(u).normalize();
    const r = proportional.radius;
    const SEG = 48;
    const out = new Float32Array(SEG * 6);
    for (let i = 0; i < SEG; i++) {
      const a0 = (i / SEG) * Math.PI * 2;
      const a1 = ((i + 1) / SEG) * Math.PI * 2;
      const p0 = pivotLocal.add(u.scale(Math.cos(a0) * r)).add(v.scale(Math.sin(a0) * r));
      const p1 = pivotLocal.add(u.scale(Math.cos(a1) * r)).add(v.scale(Math.sin(a1) * r));
      out.set([p0.x, p0.y, p0.z, p1.x, p1.y, p1.z], i * 6);
    }
    this.renderer.editPreviewLines = out;
  }

  private clearCircle(): void {
    if (this.renderer && this.proportionalOn) this.renderer.editPreviewLines = null;
  }

  /** Project the world pivot to CSS pixels (conventions formula). */
  protected projectPivot(ctx: OperatorContext, _obj: SceneObject): { x: number; y: number } {
    const { width, height } = ctx.viewportSize();
    const ndc = ctx.camera.projMatrix(width / height).mul(ctx.camera.viewMatrix()).transformPoint(this.pivot);
    return { x: ((ndc.x + 1) / 2) * width, y: ((1 - ndc.y) / 2) * height };
  }

  /**
   * Write a world position back to a vert, blended toward its start position by
   * the vert's influence weight (weight 1 = full transform, 0 = unchanged).
   */
  protected setWorld(id: number, world: Vec3): void {
    const w = this.weightOf(id);
    const target = w >= 1 ? world : this.worldBefore.get(id)!.lerp(world, w);
    this.mesh.setVertCo(id, this.invMatrix.transformPoint(target));
  }

  /** Subclass hook after shared setup; return false to abort. */
  protected abstract onStart(ctx: OperatorContext, pointer: PointerState): boolean;

  /** Re-apply the current transform state (used after a radius change). */
  protected abstract reapply(ctx: OperatorContext): void;

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
    this.clearCircle();
    ctx.setStatus('');
  }

  cancel(ctx: OperatorContext): void {
    for (const [id, co] of this.before) this.mesh.setVertCo(id, co);
    this.sel.touch();
    this.clearCircle();
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
  /** True while Ctrl is held during the modal — inverts the grid-snap state. */
  private ctrlHeld = false;
  /** Set true when 'g' is pressed mid-Move: a sentinel the InputManager reads to
   *  cycle this op to the next in Move → Edge Slide → Normal Move (UR4-2; a
   *  second G during a plain edit Move is Blender's GG → Edge Slide). */
  cycleRequested = false;

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

    // Axis lock in the active transform orientation (Normal → element normal).
    const axisDir = this.axis === 'x' ? this.axisBasis.x : this.axis === 'y' ? this.axisBasis.y : this.axisBasis.z;
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
    this.applyDelta(ctx);
  }

  /** Write the current delta to every affected vert, scaled by its weight. When
   *  snapping is effective (state XOR Ctrl-held) each vert's RESULT WORLD position
   *  is rounded onto the grid, then converted back to local for storage. */
  private applyDelta(ctx: OperatorContext): void {
    const snap = snapActive(this.ctrlHeld);
    const local = worldDeltaToLocal(this.delta, this.invMatrix);
    for (const id of this.affected) {
      const w = this.weightOf(id);
      if (snap) {
        const world = snapVec(this.worldBefore.get(id)!.add(this.delta.scale(w)), SNAP_STEP);
        this.mesh.setVertCo(id, this.invMatrix.transformPoint(world));
      } else {
        this.mesh.setVertCo(id, this.before.get(id)!.add(local.scale(w)));
      }
    }
    this.updateStatus(ctx);
  }

  protected reapply(ctx: OperatorContext): void {
    this.applyDelta(ctx);
  }

  onKey(ctx: OperatorContext, key: string): boolean {
    // Ctrl held: invert the grid-snap state for as long as it's down.
    if (key === 'Control') {
      this.ctrlHeld = true;
      this.applyDelta(ctx);
      return true;
    }
    const k = key.toLowerCase();
    if (k === 'g') {
      this.cycleRequested = true; // consumed by the InputManager cycle (GG → Edge Slide → …)
      return true;
    }
    if (k !== 'x' && k !== 'y' && k !== 'z') return false;
    this.axis = this.axis === k ? null : k;
    const hit = this.planeHit(ctx, this.lastPointer);
    if (hit) this.startHit = hit.sub(this.delta);
    this.onPointerMove(ctx, this.lastPointer);
    return true;
  }

  onKeyUp(ctx: OperatorContext, key: string): void {
    if (key === 'Control') {
      this.ctrlHeld = false;
      this.applyDelta(ctx);
    }
  }

  axisIndicator(): { axis: 'x' | 'y' | 'z'; pivot: Vec3 } | null {
    return this.axis ? { axis: this.axis, pivot: this.pivot } : null;
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

  protected reapply(ctx: OperatorContext): void {
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
      this.axis === 'x' ? this.axisBasis.x : this.axis === 'y' ? this.axisBasis.y : this.axis === 'z' ? this.axisBasis.z : ctx.camera.forward;
    const numeric = this.numeric.value;
    const angle = numeric !== null ? (numeric * Math.PI) / 180 : this.pointerAngle;
    const q = Quat.fromAxisAngle(axisDir, angle);

    for (const id of this.affected) {
      const offset = this.worldBefore.get(id)!.sub(this.pivot);
      this.setWorld(id, this.pivot.add(q.rotate(offset)));
    }
    this.updateStatus(ctx, angle);
  }

  axisIndicator(): { axis: 'x' | 'y' | 'z'; pivot: Vec3 } | null {
    return this.axis ? { axis: this.axis, pivot: this.pivot } : null;
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

  protected reapply(ctx: OperatorContext): void {
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

    // Scale in the oriented basis: project each offset onto X/Y/Z of the
    // transform orientation, scale that component, rebuild (Global reduces to the
    // world-axis scaling exactly).
    const { x: bx, y: by, z: bz } = this.axisBasis;
    for (const id of this.affected) {
      const off = this.worldBefore.get(id)!.sub(this.pivot);
      const scaled = bx.scale(off.dot(bx) * sx).add(by.scale(off.dot(by) * sy)).add(bz.scale(off.dot(bz) * sz));
      this.setWorld(id, this.pivot.add(scaled));
    }
    this.updateStatus(ctx, f);
  }

  axisIndicator(): { axis: 'x' | 'y' | 'z'; pivot: Vec3 } | null {
    return this.axis ? { axis: this.axis, pivot: this.pivot } : null;
  }

  private updateStatus(ctx: OperatorContext, factor: number): void {
    const factorText = this.numeric.text !== '' ? this.numeric.text : factor.toFixed(3);
    const lock = this.axis ? `  [${this.axis.toUpperCase()} axis]` : '  [uniform]';
    ctx.setStatus(`Scale  ${factorText}${lock}  LMB/Enter: confirm  RMB/Esc: cancel`);
  }
}
