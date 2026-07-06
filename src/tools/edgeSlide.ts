import type { Operator, OperatorContext, PointerState } from '../core/operator/Operator';
import type { EditableMesh } from '../core/mesh/EditableMesh';
import type { EditModeState } from '../core/scene/EditMode';
import { Vec3 } from '../core/math/vec3';
import { MeshEditCommand } from '../core/undo/meshCommands';
import { NumericInput } from './numericInput';

/**
 * One slide "rail" for a vert: the neighbouring vert it slides toward, the unit
 * direction to reach it (LOCAL space) and the rail's length. A vert moved by
 * factor t reaches its far vert at |t| = 1.
 */
export interface Rail {
  readonly farId: number;
  readonly dir: Vec3;
  readonly length: number;
}

/**
 * The two rails a vert slides along. `a` is the positive-t rail (t > 0 slides
 * toward a.farId), `b` the negative-t rail. Either may be null: a boundary vert
 * with a single rail only slides for the matching sign; zero rails → it stays.
 */
export interface VertRails {
  readonly a: Rail | null;
  readonly b: Rail | null;
}

/**
 * Pick the slide rails for one vert (P7-3). Rail candidates are the vert's
 * adjacent edges whose FAR vert is not itself selected (this excludes edges that
 * are part of the selection and edges spanning two selected verts). From the
 * candidates we take the two most anti-parallel to each other (smallest dot,
 * dot < 0 preferred). A/B is assigned deterministically by far-vert id (the
 * larger id is rail A / the +t direction) so the slide is reproducible.
 */
export function pickRails(mesh: EditableMesh, vertId: number, selected: Set<number>): VertRails {
  const base = mesh.verts.get(vertId);
  if (!base) return { a: null, b: null };

  const rails: Rail[] = [];
  for (const e of mesh.edges().values()) {
    const far = e.v0 === vertId ? e.v1 : e.v1 === vertId ? e.v0 : -1;
    if (far < 0 || selected.has(far)) continue;
    const d = mesh.verts.get(far)!.co.sub(base.co);
    const length = d.length();
    if (length < 1e-9) continue;
    rails.push({ farId: far, dir: d.scale(1 / length), length });
  }

  if (rails.length === 0) return { a: null, b: null };
  if (rails.length === 1) return { a: rails[0], b: null };

  // Most anti-parallel pair (minimise the direction dot product).
  let best: [Rail, Rail] = [rails[0], rails[1]];
  let bestDot = Infinity;
  for (let i = 0; i < rails.length; i++) {
    for (let j = i + 1; j < rails.length; j++) {
      const dot = rails[i].dir.dot(rails[j].dir);
      if (dot < bestDot) {
        bestDot = dot;
        best = [rails[i], rails[j]];
      }
    }
  }
  const [r1, r2] = best;
  return r1.farId > r2.farId ? { a: r1, b: r2 } : { a: r2, b: r1 };
}

/**
 * Slide a vert from its start position `base` by factor t ∈ [-1, 1]. t > 0
 * moves toward rail A's far vert by t × railLength; t < 0 toward rail B's by
 * |t| × railLength. A missing rail for the requested sign → the vert stays.
 */
export function slidePosition(base: Vec3, rails: VertRails, t: number): Vec3 {
  if (t >= 0) return rails.a ? base.add(rails.a.dir.scale(t * rails.a.length)) : base;
  return rails.b ? base.add(rails.b.dir.scale(-t * rails.b.length)) : base;
}

/**
 * GG (edit mode) — edge slide. Each selected vert slides along its rail (an
 * adjacent unselected edge) toward the neighbouring vert on either side; a
 * single factor t ∈ [-1, 1] is driven by horizontal pointer motion, or typed.
 * LMB/Enter confirm, RMB/Esc cancel. Follows the "modal GEOMETRY tools" undo
 * pattern: preview by writing vert positions, restore + push a capture on
 * confirm. v1: no clamping beyond |t| ≤ 1, no even-mode.
 */
export class EdgeSlideOperator implements Operator {
  readonly name = 'Edge Slide';

  private mesh!: EditableMesh;
  private sel!: EditModeState;
  /** Per-vert start position (LOCAL) — the "before" for undo. */
  private readonly before = new Map<number, Vec3>();
  /** Per-vert precomputed rails. */
  private readonly rails = new Map<number, VertRails>();
  private readonly numeric = new NumericInput();
  private startX = 0;
  /** Horizontal pixels that map to |t| = 1. */
  private range = 200;
  private pointerT = 0;

  start(ctx: OperatorContext, pointer: PointerState): boolean {
    const sel = ctx.scene.editMode;
    const obj = ctx.scene.editObject;
    if (!sel || !obj) return false;
    const selected = sel.selectedVertIds(obj.mesh);
    if (selected.size === 0) return false;

    this.sel = sel;
    this.mesh = obj.mesh;
    for (const id of selected) {
      this.before.set(id, obj.mesh.verts.get(id)!.co);
      this.rails.set(id, pickRails(obj.mesh, id, selected));
    }

    this.startX = pointer.x;
    this.range = Math.max(40, ctx.viewportSize().width * 0.25);
    this.pointerT = 0;
    this.apply(ctx);
    return true;
  }

  onPointerMove(ctx: OperatorContext, pointer: PointerState): void {
    this.pointerT = (pointer.x - this.startX) / this.range;
    this.apply(ctx);
  }

  onKey(ctx: OperatorContext, key: string): boolean {
    if (this.numeric.handleKey(key)) {
      this.apply(ctx);
      return true;
    }
    return false;
  }

  /** Current factor: typed value overrides the pointer; clamped to [-1, 1]. */
  private currentT(): number {
    const n = this.numeric.value;
    const raw = n !== null ? n : this.pointerT;
    return Math.max(-1, Math.min(1, raw));
  }

  private apply(ctx: OperatorContext): void {
    const t = this.currentT();
    for (const [id, rails] of this.rails) {
      this.mesh.setVertCo(id, slidePosition(this.before.get(id)!, rails, t));
    }
    this.updateStatus(ctx, t);
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

  private updateStatus(ctx: OperatorContext, t: number): void {
    const text = this.numeric.text !== '' ? this.numeric.text : t.toFixed(3);
    ctx.setStatus(`Edge Slide  t: ${text}  LMB/Enter: confirm  RMB/Esc: cancel`);
  }
}
