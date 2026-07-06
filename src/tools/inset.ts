import type { Operator, OperatorContext, PointerState } from '../core/operator/Operator';
import type { EditModeState } from '../core/scene/EditMode';
import type { EditableMesh } from '../core/mesh/EditableMesh';
import { Vec3 } from '../core/math/vec3';
import { insetFaces, faceCentroid } from '../core/mesh/ops/inset';
import { MeshEditCommand } from '../core/undo/meshCommands';
import { NumericInput } from './numericInput';

/** Pixels of horizontal pointer travel that map to the full inset (t = 0.95). */
const PIXELS_PER_FULL_INSET = 300;
const MAX_T = 0.95;

/**
 * I (edit mode, face select) — Blender's individual-face inset. On start it nests
 * a smaller copy inside each selected face, walled by a ring of quads, selects the
 * new inner faces, then rides the pointer: horizontal travel drives `t`, the amount
 * each inner vert slides toward its face centroid (clamped 0..0.95). Numeric input
 * sets `t` directly (0.3 = 30% toward the centroid). LMB/Enter confirm, RMB/Esc
 * cancel (restoring the pre-inset mesh).
 *
 * Follows the "modal TOPOLOGY tools" undo pattern: snapshot before, mutate as the
 * preview, then push a from-snapshots command on confirm.
 */
export class InsetOperator implements Operator {
  readonly name = 'Inset';

  private mesh!: EditableMesh;
  private sel!: EditModeState;
  private before!: EditableMesh;

  /** Inner verts to slide, with their corner start position and target centroid. */
  private innerVerts: number[] = [];
  private cornerCo = new Map<number, Vec3>();
  private centroidCo = new Map<number, Vec3>();

  private readonly numeric = new NumericInput();
  private startX = 0;
  private pointerT = 0;
  private t = 0;

  start(ctx: OperatorContext, pointer: PointerState): boolean {
    const sel = ctx.scene.editMode;
    const obj = ctx.scene.editObject;
    if (!sel || !obj) return false;
    if (sel.elementMode !== 'face') return false;
    const faceIds = new Set([...sel.faces].filter((id) => obj.mesh.faces.has(id)));
    if (faceIds.size === 0) return false;

    this.sel = sel;
    this.mesh = obj.mesh;
    this.before = this.mesh.clone();

    const { innerFaceIds, innerVertsByFace } = insetFaces(this.mesh, faceIds);

    // Record each inner vert's corner start (its current co) and its face centroid.
    for (const fid of innerFaceIds) {
      const centroid = faceCentroid(this.mesh, fid);
      for (const v of innerVertsByFace.get(fid)!) {
        this.innerVerts.push(v);
        this.cornerCo.set(v, this.mesh.verts.get(v)!.co);
        this.centroidCo.set(v, centroid);
      }
    }

    // Selection becomes the new inner faces (what a Blender user expects).
    sel.faces.clear();
    for (const id of innerFaceIds) sel.faces.add(id);
    sel.touch();

    this.startX = pointer.x;
    this.pointerT = 0;
    this.apply(ctx);
    return true;
  }

  onPointerMove(ctx: OperatorContext, pointer: PointerState): void {
    // Inset amount grows with horizontal distance from the press point.
    this.pointerT = Math.abs(pointer.x - this.startX) / PIXELS_PER_FULL_INSET;
    this.apply(ctx);
  }

  onKey(ctx: OperatorContext, key: string): boolean {
    if (this.numeric.handleKey(key)) {
      this.apply(ctx);
      return true;
    }
    return false;
  }

  private apply(ctx: OperatorContext): void {
    const numeric = this.numeric.value;
    const raw = numeric !== null ? numeric : this.pointerT;
    this.t = Math.max(0, Math.min(MAX_T, raw));
    for (const v of this.innerVerts) {
      this.mesh.setVertCo(v, this.cornerCo.get(v)!.lerp(this.centroidCo.get(v)!, this.t));
    }
    this.updateStatus(ctx);
  }

  confirm(ctx: OperatorContext): void {
    ctx.undo.push(MeshEditCommand.fromSnapshots(this.name, this.mesh, this.before, this.mesh.clone()));
    this.sel.touch();
    ctx.setStatus('');
  }

  cancel(ctx: OperatorContext): void {
    this.mesh.copyFrom(this.before);
    this.sel.prune(this.mesh);
    this.sel.touch();
    ctx.setStatus('');
  }

  private updateStatus(ctx: OperatorContext): void {
    const tText = this.numeric.text !== '' ? this.numeric.text : this.t.toFixed(3);
    ctx.setStatus(`Inset  t: ${tText}  LMB/Enter: confirm  RMB/Esc: cancel`);
  }
}
