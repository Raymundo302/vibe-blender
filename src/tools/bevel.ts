import type { Operator, OperatorContext, PointerState } from '../core/operator/Operator';
import type { EditModeState } from '../core/scene/EditMode';
import { EditableMesh } from '../core/mesh/EditableMesh';
import { bevelEdges } from '../core/mesh/ops/bevel';
import { MeshEditCommand } from '../core/undo/meshCommands';
import { NumericInput } from './numericInput';

/** Local-space bevel width per pixel of horizontal pointer travel. */
const WIDTH_PER_PIXEL = 1 / 250;

/**
 * Ctrl+B (edit mode, edge select) — Blender's edge bevel, 1 segment. Each
 * selected edge slides apart into two edges with a new quad between them; the
 * pointer's horizontal travel drives the width (numeric input sets it exactly).
 * LMB/Enter confirm, RMB/Esc cancel.
 *
 * Follows the "modal TOPOLOGY tools" undo pattern, with the bevel twist called
 * out in the spec: a width change is not an incremental slide — it REBUILDS the
 * bevel from the pre-bevel snapshot (`copyFrom(before)` then a fresh
 * `bevelEdges`), because the re-stitched topology depends on the width.
 */
export class BevelOperator implements Operator {
  readonly name = 'Bevel';

  private mesh!: EditableMesh;
  private sel!: EditModeState;
  private before!: EditableMesh;
  private edgeKeys: string[] = [];
  private lastFaceIds: number[] = [];

  private readonly numeric = new NumericInput();
  private startX = 0;
  private pointerWidth = 0;
  private width = 0;

  start(ctx: OperatorContext, pointer: PointerState): boolean {
    const sel = ctx.scene.editMode;
    const obj = ctx.scene.editObject;
    if (!sel || !obj) return false;
    if (sel.elementMode !== 'edge') {
      ctx.setStatus('Bevel: edge mode only');
      return false;
    }
    const keys = [...sel.edges].filter((k) => obj.mesh.edges().has(k));
    if (keys.length === 0) {
      ctx.setStatus('Bevel: select edges first');
      return false;
    }

    // Dry-run on a clone to reject unsupported selections without mutating.
    const probe = bevelEdges(obj.mesh.clone(), keys, 0.001);
    if ('error' in probe) {
      ctx.setStatus(`Bevel: ${probe.error}`);
      return false;
    }

    this.sel = sel;
    this.mesh = obj.mesh;
    this.before = this.mesh.clone();
    this.edgeKeys = keys;

    // The beveled edges disappear into new geometry; drop the stale selection now
    // and re-select the bevel faces' edges on confirm.
    sel.clearSelection();

    this.startX = pointer.x;
    this.pointerWidth = 0;
    this.apply(ctx);
    return true;
  }

  onPointerMove(ctx: OperatorContext, pointer: PointerState): void {
    this.pointerWidth = Math.abs(pointer.x - this.startX) * WIDTH_PER_PIXEL;
    this.apply(ctx);
  }

  onKey(ctx: OperatorContext, key: string): boolean {
    if (this.numeric.handleKey(key)) {
      this.apply(ctx);
      return true;
    }
    return false;
  }

  /** Rebuild the bevel from scratch at the current width (never an in-place slide). */
  private apply(ctx: OperatorContext): void {
    const numeric = this.numeric.value;
    this.width = Math.max(0, numeric !== null ? numeric : this.pointerWidth);
    this.mesh.copyFrom(this.before);
    const res = bevelEdges(this.mesh, this.edgeKeys, this.width);
    this.lastFaceIds = 'newFaceIds' in res ? res.newFaceIds : [];
    this.sel.touch();
    this.updateStatus(ctx);
  }

  confirm(ctx: OperatorContext): void {
    ctx.undo.push(MeshEditCommand.fromSnapshots(this.name, this.mesh, this.before, this.mesh.clone()));
    // Select the fresh bevel quads' edges (edge mode).
    this.sel.clearSelection();
    for (const fid of this.lastFaceIds) {
      const f = this.mesh.faces.get(fid);
      if (!f) continue;
      const n = f.verts.length;
      for (let i = 0; i < n; i++) this.sel.edges.add(EditableMesh.edgeKey(f.verts[i], f.verts[(i + 1) % n]));
    }
    this.sel.prune(this.mesh);
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
    const wText = this.numeric.text !== '' ? this.numeric.text : this.width.toFixed(3);
    ctx.setStatus(`Bevel  width: ${wText}  LMB/Enter: confirm  RMB/Esc: cancel`);
  }
}
