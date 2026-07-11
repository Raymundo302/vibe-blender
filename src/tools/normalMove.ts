import type { Operator, OperatorContext, PointerState } from '../core/operator/Operator';
import type { EditableMesh } from '../core/mesh/EditableMesh';
import type { EditModeState } from '../core/scene/EditMode';
import { Vec3 } from '../core/math/vec3';
import { MeshEditCommand } from '../core/undo/meshCommands';
import { vertexNormals } from '../core/mesh/meshToGpu';
import { NumericInput } from './numericInput';

/**
 * Normal Move (UR4-2) — the third op in the edit-mode G cycle (Move → Edge
 * Slide → Normal Move → Move). Every selected vert moves along ITS OWN vertex
 * normal by a single shared distance d: `pos = start + normal·d` (LOCAL space —
 * face normals derived from local coordinates are local, so no world transform
 * is needed for the offset itself).
 *
 * Normals are captured ONCE at start() (area-weighted average of adjacent face
 * normals, via the shared `vertexNormals` helper) and LOCKED for the whole
 * modal — moving verts changes face normals, but the captured vectors must NOT
 * be recomputed mid-drag (Ray: "keep the vector locked till the move is done").
 *
 * d is driven by horizontal pointer motion with the same mapping edge slide
 * used (pixels / (0.25·viewport width) × a world scale of 1); typing a number
 * overrides. LMB/Enter confirm, RMB/Esc cancel — the EdgeSlideOperator undo
 * pattern (preview by writing positions, restore + push a capture on confirm).
 * Boundary/wire verts with no faces get a zero normal → they stay put.
 */
export class NormalMoveOperator implements Operator {
  readonly name = 'Normal Move';
  readonly continuousGrab = true;
  /** Set true when 'g' is pressed mid-move: a sentinel the InputManager reads to
   *  cycle this op back to Move (UR4-2). */
  cycleRequested = false;

  private mesh!: EditableMesh;
  private sel!: EditModeState;
  /** Per-vert start position (LOCAL) — the "before" for undo. */
  private readonly before = new Map<number, Vec3>();
  /** Per-vert LOCKED vertex normal (captured once at start). */
  private readonly normals = new Map<number, Vec3>();
  private readonly numeric = new NumericInput();
  private startX = 0;
  /** Horizontal pixels that map to d = 1 world unit. */
  private range = 200;
  private pointerD = 0;

  start(ctx: OperatorContext, pointer: PointerState): boolean {
    const sel = ctx.scene.editMode;
    const obj = ctx.scene.editObject;
    if (!sel || !obj) return false;
    const selected = sel.selectedVertIds(obj.mesh);
    if (selected.size === 0) return false;

    this.sel = sel;
    this.mesh = obj.mesh;
    // Capture the vertex normals ONCE (area-weighted; verts with no faces are
    // absent from the map → default to zero, so they never move).
    const vn = vertexNormals(obj.mesh);
    for (const id of selected) {
      this.before.set(id, obj.mesh.verts.get(id)!.co);
      this.normals.set(id, vn.get(id) ?? Vec3.ZERO);
    }

    this.startX = pointer.x;
    this.range = Math.max(40, ctx.viewportSize().width * 0.25);
    this.pointerD = 0;
    this.apply(ctx);
    return true;
  }

  onPointerMove(ctx: OperatorContext, pointer: PointerState): void {
    this.pointerD = (pointer.x - this.startX) / this.range;
    this.apply(ctx);
  }

  onKey(ctx: OperatorContext, key: string): boolean {
    if (key.toLowerCase() === 'g') {
      this.cycleRequested = true; // consumed by the InputManager cycle (UR4-2)
      return true;
    }
    if (this.numeric.handleKey(key)) {
      this.apply(ctx);
      return true;
    }
    return false;
  }

  /** Current distance: typed value overrides the pointer. */
  private currentD(): number {
    const n = this.numeric.value;
    return n !== null ? n : this.pointerD;
  }

  private apply(ctx: OperatorContext): void {
    const d = this.currentD();
    for (const [id, start] of this.before) {
      this.mesh.setVertCo(id, start.add(this.normals.get(id)!.scale(d)));
    }
    this.updateStatus(ctx, d);
  }

  confirm(ctx: OperatorContext): void {
    // Capture the previewed positions, restore the starts, then push a command
    // that re-applies the finals — the "modal GEOMETRY tools" undo pattern.
    const after = new Map<number, Vec3>();
    for (const id of this.before.keys()) after.set(id, this.mesh.verts.get(id)!.co);
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

  private updateStatus(ctx: OperatorContext, d: number): void {
    const text = this.numeric.text !== '' ? this.numeric.text : d.toFixed(3);
    ctx.setStatus(`Normal Move  d: ${text}  LMB/Enter: confirm  RMB/Esc: cancel`);
  }
}
