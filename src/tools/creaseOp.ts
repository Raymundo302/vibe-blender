import type { Operator, OperatorContext, PointerState } from '../core/operator/Operator';
import type { EditableMesh } from '../core/mesh/EditableMesh';
import type { EditModeState } from '../core/scene/EditMode';
import { MeshEditCommand } from '../core/undo/meshCommands';
import { NumericInput } from './numericInput';

/** Horizontal-drag → crease-weight sensitivity (weight units per CSS pixel). */
export const CREASE_SENSITIVITY = 0.005;

/**
 * Map a horizontal pointer drag to a crease weight in [0, 1]. Starts from
 * `base` (the drag's starting weight) and adds dxPx × sensitivity, clamped.
 * Pure so the mapping is unit-tested without a GL context.
 */
export function creaseWeightFromDrag(base: number, dxPx: number, sensitivity = CREASE_SENSITIVITY): number {
  const w = base + dxPx * sensitivity;
  return w < 0 ? 0 : w > 1 ? 1 : w;
}

/**
 * Shift+E — modal edge crease (edit mode, edge selection). Horizontal pointer
 * motion sets the weight on every selected edge (typed number overrides: 0..1,
 * or −1 to clear). Live preview: setCrease bumps mesh.version each frame so a
 * Subdivision Surface modifier re-evaluates (modifiers are hidden in the edit
 * cage, so the creased result shows on return to Object Mode). LMB/Enter
 * confirm, RMB/Esc restore. Undoable via a before/after mesh snapshot.
 */
export class CreaseOperator implements Operator {
  readonly name = 'Crease';

  private mesh!: EditableMesh;
  private sel!: EditModeState;
  private before!: EditableMesh;
  /** The selected edges' endpoint pairs, resolved once at start. */
  private pairs: [number, number][] = [];
  private base = 0;
  private startX = 0;
  private weight = 0;
  private readonly numeric = new NumericInput();

  start(ctx: OperatorContext, pointer: PointerState): boolean {
    const sel = ctx.scene.editMode;
    const obj = ctx.scene.editObject;
    if (!sel || !obj || sel.elementMode !== 'edge') return false;
    const edges = obj.mesh.edges();
    this.pairs = [];
    for (const key of sel.edges) {
      const e = edges.get(key);
      if (e) this.pairs.push([e.v0, e.v1]);
    }
    if (this.pairs.length === 0) return false;

    this.mesh = obj.mesh;
    this.sel = sel;
    this.before = obj.mesh.clone();
    this.startX = pointer.x;
    // Seed from the current average crease of the selection (so a fresh drag
    // starts where the edges already are).
    let sum = 0;
    for (const [a, b] of this.pairs) sum += this.mesh.crease(a, b);
    this.base = sum / this.pairs.length;
    this.weight = this.base;
    this.apply(ctx);
    return true;
  }

  onPointerMove(ctx: OperatorContext, pointer: PointerState): void {
    if (this.numeric.value !== null) return; // typed value overrides the pointer
    this.weight = creaseWeightFromDrag(this.base, pointer.x - this.startX);
    this.apply(ctx);
  }

  onKey(ctx: OperatorContext, key: string): boolean {
    if (this.numeric.handleKey(key)) {
      const v = this.numeric.value;
      if (v !== null) this.weight = v < 0 ? 0 : v > 1 ? 1 : v; // −1 (or any <0) clears
      this.apply(ctx);
      return true;
    }
    return false;
  }

  private apply(ctx: OperatorContext): void {
    for (const [a, b] of this.pairs) this.mesh.setCrease(a, b, this.weight);
    const typed = this.numeric.text !== '' ? ` (typed ${this.numeric.text})` : '';
    ctx.setStatus(`Crease  ${this.weight.toFixed(3)}${typed}  LMB/Enter: confirm  RMB/Esc: cancel`);
  }

  confirm(ctx: OperatorContext): void {
    ctx.undo.push(MeshEditCommand.fromSnapshots('Crease', this.mesh, this.before, this.mesh.clone()));
    this.sel.touch();
    ctx.setStatus('');
  }

  cancel(ctx: OperatorContext): void {
    this.mesh.copyFrom(this.before);
    this.sel.prune(this.mesh);
    this.sel.touch();
    ctx.setStatus('');
  }
}
