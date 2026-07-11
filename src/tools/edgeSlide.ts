import type { Operator, OperatorContext, PointerState } from '../core/operator/Operator';
import type { EditableMesh } from '../core/mesh/EditableMesh';
import type { EditModeState } from '../core/scene/EditMode';
import { Vec3 } from '../core/math/vec3';
import { MeshEditCommand } from '../core/undo/meshCommands';
import { projectToScreen } from './boxSelect';
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
 * Guide-line segments for one vert (LOCAL space) — the tangent lines drawn
 * during an edge slide, extended along each rail so the slide direction is
 * visible before the vert moves. Because t is now UNCLAMPED (the vert can slide
 * far past the far vert into the rail's extension, UR4-2), each rail's guide
 * spans `base - dir·2·length` to `base + dir·2·length` (±2L) so the reachable
 * extension is visible. A single-rail vert yields one segment; a zero-rail vert
 * yields none. Pure so it can be unit-tested without a world matrix.
 */
export function railGuideSegments(base: Vec3, rails: VertRails): { a: Vec3; b: Vec3 }[] {
  const segs: { a: Vec3; b: Vec3 }[] = [];
  for (const rail of [rails.a, rails.b]) {
    if (!rail) continue;
    segs.push({
      a: base.sub(rail.dir.scale(2 * rail.length)),
      b: base.add(rail.dir.scale(2 * rail.length)),
    });
  }
  return segs;
}

/**
 * Slide a vert from its start position `base` by factor t. t > 0 moves toward
 * rail A's far vert by t × railLength; t < 0 toward rail B's by |t| × railLength.
 * t is NOT clamped to [-1, 1] (UR4-2): |t| > 1 extrapolates LINEARLY along the
 * rail's extension, past the far vert, collinearly. A missing rail for the
 * requested sign → the vert stays.
 */
export function slidePosition(base: Vec3, rails: VertRails, t: number): Vec3 {
  if (t >= 0) return rails.a ? base.add(rails.a.dir.scale(t * rails.a.length)) : base;
  return rails.b ? base.add(rails.b.dir.scale(-t * rails.b.length)) : base;
}

/**
 * A control-vert rail projected to SCREEN space (UR4-2). `o` is the base vert's
 * screen position, `dir` the unit screen direction toward the far vert, `len`
 * the base→far screen distance. Used to (a) proximity-pick the rail the pointer
 * is nearest and (b) convert the pointer's projection onto it into a slide t.
 */
export interface ScreenRail {
  readonly ox: number;
  readonly oy: number;
  readonly dx: number;
  readonly dy: number;
  readonly len: number;
}

/** A screen projector: local point → screen pixel, or null if unprojectable. */
export type ScreenProjector = (p: Vec3) => { x: number; y: number } | null;

/**
 * Project one rail (its base → base+dir·length) to a screen line, or null if it
 * degenerates to a point (screen length < 2px, e.g. an edge-on view) or an
 * endpoint fails to project. Pure — a synthetic projector makes it unit-testable.
 */
export function projectScreenRail(base: Vec3, rail: Rail | null, project: ScreenProjector): ScreenRail | null {
  if (!rail) return null;
  const s0 = project(base);
  const s1 = project(base.add(rail.dir.scale(rail.length)));
  if (!s0 || !s1) return null;
  const len = Math.hypot(s1.x - s0.x, s1.y - s0.y);
  if (len < 2) return null; // edge-on: exclude from picking
  return { ox: s0.x, oy: s0.y, dx: (s1.x - s0.x) / len, dy: (s1.y - s0.y) / len, len };
}

/**
 * Proximity-pick the slide t from a pointer (UR4-2): project the pointer onto
 * each screen rail, take the NEAREST by perpendicular distance, and return the
 * signed parameter (projection scalar / rail screen length) — positive along
 * rail A, negative along rail B. null when no rail is available (t stays put).
 * On a perpendicular-distance tie (collinear rails, the common edge-slide case)
 * rail A wins and its signed projection alone chooses the side.
 */
export function pickSlideT(a: ScreenRail | null, b: ScreenRail | null, px: number, py: number): number | null {
  let bestPerp = Infinity;
  let bestT: number | null = null;
  for (const [rail, sign] of [[a, 1], [b, -1]] as [ScreenRail | null, number][]) {
    if (!rail) continue;
    const ex = px - rail.ox;
    const ey = py - rail.oy;
    const s = ex * rail.dx + ey * rail.dy; // projection scalar (screen px)
    const perp = Math.abs(ex * rail.dy - ey * rail.dx); // perpendicular distance
    if (perp < bestPerp) {
      bestPerp = perp;
      bestT = sign * (s / rail.len);
    }
  }
  return bestT;
}

/**
 * GG (edit mode) — edge slide. Each selected vert slides along its rail (an
 * adjacent unselected edge) toward the neighbouring vert on either side; a
 * single factor t drives every vert. t is picked by PROXIMITY (UR4-2): the
 * control vert (the selected vert whose projected position is nearest the
 * pointer at start) has two rails projected to screen lines; on every move the
 * (virtual) pointer is projected onto each rail line and the NEAREST line
 * (perpendicular screen distance) wins — t = signed projection scalar / rail
 * screen length, positive along rail A, negative along rail B. t is UNCLAMPED
 * (only ±100 for sanity) so verts slide past the far vert into the rail's
 * extension. Typing a number overrides the pointer. LMB/Enter confirm, RMB/Esc
 * cancel. Follows the "modal GEOMETRY tools" undo pattern: preview by writing
 * vert positions, restore + push a capture on confirm. No even-mode (v1).
 */
export class EdgeSlideOperator implements Operator {
  readonly name = 'Edge Slide';
  readonly continuousGrab = true;
  /** Set true when 'g' is pressed mid-slide: a sentinel the InputManager reads
   *  to cycle this op to the next in Move → Edge Slide → Normal Move (UR4-2). */
  cycleRequested = false;

  private mesh!: EditableMesh;
  private sel!: EditModeState;
  /** Per-vert start position (LOCAL) — the "before" for undo. */
  private readonly before = new Map<number, Vec3>();
  /** Per-vert precomputed rails. */
  private readonly rails = new Map<number, VertRails>();
  /** WORLD-space guide segments, cached at start() (rails are fixed). */
  private guideCache: { a: Vec3; b: Vec3 }[] | null = null;
  /** The control vert's two rails projected to screen (null when they degenerate
   *  to a point / project off-screen — such a rail is excluded from picking). */
  private screenA: ScreenRail | null = null;
  private screenB: ScreenRail | null = null;
  private readonly numeric = new NumericInput();
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

    // Cache the guide lines in WORLD space — rails/positions are LOCAL, so lift
    // each segment through the edit object's world matrix (parent aware).
    const world = ctx.scene.worldMatrix(obj);
    const guides: { a: Vec3; b: Vec3 }[] = [];
    for (const [id, rails] of this.rails) {
      for (const seg of railGuideSegments(this.before.get(id)!, rails)) {
        guides.push({ a: world.transformPoint(seg.a), b: world.transformPoint(seg.b) });
      }
    }
    this.guideCache = guides.length > 0 ? guides : null;

    // Build the SCREEN rails for the CONTROL vert = the selected vert whose
    // projected screen position is nearest the pointer. Same camera/world→screen
    // path the other tools use (mvp = proj·view·world, then projectToScreen).
    const { width, height } = ctx.viewportSize();
    const mvp = ctx.camera.projMatrix(width / height).mul(ctx.camera.viewMatrix()).mul(world);
    const project: ScreenProjector = (p) => projectToScreen(p, mvp, width, height);
    let controlId = -1;
    let bestD = Infinity;
    for (const id of this.before.keys()) {
      const s = project(this.before.get(id)!);
      if (!s) continue;
      const d = (s.x - pointer.x) ** 2 + (s.y - pointer.y) ** 2;
      if (d < bestD) { bestD = d; controlId = id; }
    }
    if (controlId >= 0) {
      const rails = this.rails.get(controlId)!;
      const base = this.before.get(controlId)!;
      this.screenA = projectScreenRail(base, rails.a, project);
      this.screenB = projectScreenRail(base, rails.b, project);
    }

    this.pointerT = 0;
    this.apply(ctx);
    return true;
  }

  guideSegments(): { a: Vec3; b: Vec3 }[] | null {
    return this.guideCache;
  }

  onPointerMove(ctx: OperatorContext, pointer: PointerState): void {
    const t = pickSlideT(this.screenA, this.screenB, pointer.x, pointer.y);
    if (t !== null) this.pointerT = t;
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

  /** Current factor: typed value overrides the pointer; clamped to ±100 (sanity
   *  only — |t| may exceed 1 to slide past the far vert into the extension). */
  private currentT(): number {
    const n = this.numeric.value;
    const raw = n !== null ? n : this.pointerT;
    return Math.max(-100, Math.min(100, raw));
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
