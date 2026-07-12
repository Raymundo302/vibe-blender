import { EditableMesh } from '../mesh/EditableMesh';
import { evaluateCurve, frames } from '../curve/eval';
import type { CurveData } from '../scene/objectData';
import {
  registerModifier,
  type Modifier,
  type ModifierContext,
  type ModifierField,
  type ModifierParams,
} from './Modifier';

/**
 * Pipe modifier (UR11-2, Ray's "Pipe") — sweeps a circular tube profile along a
 * curve object's evaluated polyline, the way Blender's Curve → Geometry → Bevel
 * (round) turns a spline into a pipe. Only meaningful on CURVE hosts: the
 * geometry source is ctx.hostCurve (a curve carries an EMPTY base mesh), NOT the
 * mesh passed to apply(). On a mesh host — or in a scene-less unit context —
 * hostCurve is absent and the modifier no-ops (returns the input unchanged).
 *
 * Geometry: a ring of `sides` verts is placed at each evaluated curve point using
 * the UR11-1 parallel-transport frames (position/normal/binormal), so the tube
 * never pinches or spins. Consecutive rings are joined by quads. Open curves
 * optionally get triangle-fan caps; a cyclic curve welds the last ring back to
 * the first (no caps). `radiusEnd` tapers the radius linearly by arclength.
 * UVs: u around the profile (0..1), v = arclength / total length (0..1).
 *
 * PURE + deterministic: identical (curve, params) → identical mesh.
 */

/** Sides clamp — a ring needs ≥3 verts to have area; 64 is plenty of smoothness. */
export const PIPE_SIDES_MIN = 3;
export const PIPE_SIDES_MAX = 64;

function clampSides(n: number): number {
  if (!Number.isFinite(n)) return 12;
  return Math.max(PIPE_SIDES_MIN, Math.min(PIPE_SIDES_MAX, Math.round(n)));
}

/** djb2 string hash → uint32. Used to stamp the output mesh's `version` so the
 *  GPU / CPU caches (which key on mesh.version) rebuild exactly when the tube's
 *  content changes — a fresh tube of unchanged topology would otherwise reuse
 *  the same version number. */
function hashStr(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

/**
 * Build the tube mesh for a curve + pipe params. Exported for unit tests so the
 * geometry can be exercised without a Scene. Returns an empty mesh when the
 * curve degenerates (< 2 usable ring points).
 */
export function buildPipe(
  curve: CurveData,
  radius: number,
  sides: number,
  capEnds: boolean,
  radiusEnd: number,
): EditableMesh {
  const mesh = new EditableMesh();
  if (!curve || curve.points.length < 2) return mesh;
  const fullPoly = evaluateCurve(curve);
  if (fullPoly.length < 2) return mesh;

  const cyclic = curve.cyclic;
  // evaluateCurve appends a duplicate closing point for cyclic curves; drop it so
  // the seam welds ring[last] → ring[0] with no doubled vertex.
  const poly = cyclic ? fullPoly.slice(0, fullPoly.length - 1) : fullPoly;
  const ringCount = poly.length;
  if (ringCount < 2) return mesh;

  const frms = frames(poly);
  const S = clampSides(sides);
  const r0 = Math.max(radius, 1e-6);
  const r1 = Math.max(radiusEnd, 0);

  // Cumulative arclength per ring (for v-coord + taper). For cyclic curves the
  // total also spans the closing segment ring[last] → ring[0].
  const cum: number[] = [0];
  for (let i = 1; i < ringCount; i++) cum.push(cum[i - 1] + poly[i].distanceTo(poly[i - 1]));
  const closing = cyclic ? poly[ringCount - 1].distanceTo(poly[0]) : 0;
  const total = cum[ringCount - 1] + closing;
  const vAt = (ri: number): number => (total > 0 ? cum[ri] / total : 0);

  // --- Ring verts ---
  // Vert index of profile vertex j on ring ri = ri * S + j.
  const ringVert: number[][] = [];
  for (let ri = 0; ri < ringCount; ri++) {
    const f = frms[ri];
    const r = r0 + (r1 - r0) * vAt(ri); // taper by arclength fraction
    const ids: number[] = [];
    for (let j = 0; j < S; j++) {
      const theta = (2 * Math.PI * j) / S;
      const dir = f.normal.scale(Math.cos(theta)).add(f.binormal.scale(Math.sin(theta)));
      ids.push(mesh.addVert(f.position.add(dir.scale(r))));
    }
    ringVert.push(ids);
  }

  // --- Side quads (ring ri → ring ri+1). Winding chosen so the face normal
  // points radially OUTWARD (verified in the unit tests). ---
  const bandCount = cyclic ? ringCount : ringCount - 1;
  for (let ri = 0; ri < bandCount; ri++) {
    const riNext = (ri + 1) % ringCount;
    const v0 = vAt(ri);
    // The cyclic closing band wraps back to ring 0 (cum 0) but represents v = 1.
    const v1 = cyclic && riNext === 0 ? 1 : vAt(riNext);
    for (let j = 0; j < S; j++) {
      const j1 = (j + 1) % S;
      const a = ringVert[ri][j];
      const b = ringVert[ri][j1];
      const c = ringVert[riNext][j1];
      const d = ringVert[riNext][j];
      const fid = mesh.addFace([a, b, c, d]);
      const u0 = j / S;
      const u1 = (j + 1) / S;
      mesh.setFaceUVs(fid, [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]);
    }
  }

  // --- Caps (open curves only; a cyclic tube is a closed loop). Triangle fans
  // about a center vertex at each end anchor, wound to face outward. ---
  if (capEnds && !cyclic) {
    const capUV = (j: number): [number, number] => {
      const theta = (2 * Math.PI * j) / S;
      return [0.5 + 0.5 * Math.cos(theta), 0.5 + 0.5 * Math.sin(theta)];
    };
    // Start cap: faces -tangent → reversed order.
    const c0 = mesh.addVert(poly[0]);
    for (let j = 0; j < S; j++) {
      const j1 = (j + 1) % S;
      const fid = mesh.addFace([c0, ringVert[0][j1], ringVert[0][j]]);
      mesh.setFaceUVs(fid, [[0.5, 0.5], capUV(j1), capUV(j)]);
    }
    // End cap: faces +tangent.
    const last = ringCount - 1;
    const cN = mesh.addVert(poly[last]);
    for (let j = 0; j < S; j++) {
      const j1 = (j + 1) % S;
      const fid = mesh.addFace([cN, ringVert[last][j], ringVert[last][j1]]);
      mesh.setFaceUVs(fid, [[0.5, 0.5], capUV(j), capUV(j1)]);
    }
  }

  return mesh;
}

class PipeModifier implements Modifier {
  readonly type = 'pipe';
  name = 'Pipe';
  enabled = true;
  private radius = 0.1;
  private sides = 12;
  private capEnds = true;
  /** Optional taper target radius; undefined = no taper (both ends = radius). */
  private radiusEnd: number | undefined;

  constructor(params?: ModifierParams) {
    if (params) this.ingest(params);
  }

  apply(mesh: EditableMesh, ctx?: ModifierContext): EditableMesh {
    const curve = ctx?.hostCurve;
    if (!curve) return mesh; // mesh host / no scene → identity pass-through
    const out = buildPipe(curve, this.radius, this.sides, this.capEnds, this.radiusEnd ?? this.radius);
    // Stamp version from the full dependency signature so caches keying on
    // mesh.version rebuild whenever the curve or params change (a rebuilt tube of
    // identical topology would otherwise carry the same op-count version).
    out.version = hashStr(this.signature(curve));
    return out;
  }

  /** Everything that affects the output geometry, as a compact string. */
  private signature(curve: CurveData): string {
    return `pipe|${this.radius}|${this.sides}|${this.capEnds ? 1 : 0}|${this.radiusEnd ?? this.radius}|${JSON.stringify(curve)}`;
  }

  /**
   * Cache-key material: the modifier's output depends on the host CURVE (outside
   * the base mesh + params), so the evaluatedMesh cache must invalidate on every
   * curve edit. Keying on the curve payload signature is inherently correct —
   * no per-edit version counter to keep in sync (no missed-bump sites).
   */
  depVersion(ctx?: ModifierContext): string {
    return ctx?.hostCurve ? this.signature(ctx.hostCurve) : '';
  }

  params(): ModifierParams {
    return {
      radius: this.radius,
      sides: this.sides,
      capEnds: this.capEnds,
      radiusEnd: this.radiusEnd ?? this.radius,
    };
  }

  setParam(key: string, value: number | boolean | string): void {
    if (key === 'capEnds') { this.capEnds = value === true; return; }
    if (typeof value !== 'number') return;
    if (key === 'radius') this.radius = Math.max(1e-6, value);
    else if (key === 'sides') this.sides = clampSides(value);
    else if (key === 'radiusEnd') this.radiusEnd = Math.max(0, value);
  }

  private ingest(p: ModifierParams): void {
    if (typeof p.radius === 'number') this.radius = Math.max(1e-6, p.radius);
    if (typeof p.sides === 'number') this.sides = clampSides(p.sides);
    if (typeof p.capEnds === 'boolean') this.capEnds = p.capEnds;
    if (typeof p.radiusEnd === 'number') this.radiusEnd = Math.max(0, p.radiusEnd);
  }

  fields(): ModifierField[] {
    return [
      { key: 'radius', label: 'Radius', kind: 'number', min: 0, step: 0.05 },
      { key: 'radiusEnd', label: 'Radius End', kind: 'number', min: 0, step: 0.05 },
      { key: 'sides', label: 'Sides', kind: 'int', min: PIPE_SIDES_MIN, max: PIPE_SIDES_MAX, step: 1 },
      { key: 'capEnds', label: 'Cap Ends', kind: 'bool' },
    ];
  }
}

registerModifier('pipe', 'Pipe', (p) => new PipeModifier(p));

export { PipeModifier };
