import type { Scene } from '../core/scene/Scene';
import { Mat4 } from '../core/math/mat4';
import { Vec3 } from '../core/math/vec3';
import { fromCurveData, type NCurve } from '../core/nurbs/curve';
import { fromSurfaceData, type NSurface } from '../core/nurbs/surface';
import { knotDomain } from '../core/nurbs/basis';
import type { CurveData, SurfaceData, SurfacePoint, TrimLoop } from '../core/scene/objectData';
import { defaultSurfaceTess } from '../core/scene/objectData';

/**
 * IGES 5.3 import / export (task NB-D1) — a PURE module (no DOM). Both directions
 * live here so the exporter and importer share one set of conventions and can't
 * drift into a symmetric wrong assumption (the foreign-fixture test guards that).
 *
 * FORMAT: fixed 80-column records. Columns 1-72 carry data, column 73 the section
 * letter (S/G/D/P/T), columns 74-80 a per-section 1-based sequence number. The
 * five sections appear in order:
 *   S — Start: human-readable prologue.
 *   G — Global: comma/semicolon-delimited file parameters (units, delimiters…).
 *   D — Directory Entry: TWO fixed 8-field lines per entity; the entity's "DE
 *       pointer" is the sequence number of its first D line (always odd).
 *   P — Parameter Data: free-format delimited values in cols 1-64, with the
 *       owning DE pointer back-referenced in the tail (cols 65-72).
 *   T — Terminate: the record counts of each section.
 *
 * EXPORT bakes each object's WORLD transform into the control points (no 124
 * transform entities are emitted — the geometry is already world-space). Visible
 * curves → entity 126 (Rational B-Spline Curve); visible surfaces → entity 128
 * (Rational B-Spline Surface), plus 142 (Curve on a Parametric Surface) + 144
 * (Trimmed Surface) when the surface carries trim loops. Output is deterministic
 * (fixed float formatting + a fixed file timestamp) so the same scene yields a
 * byte-identical file.
 *
 * IMPORT understands 126, 128, 142/144 (trims), 110 (line), 100 (circular arc),
 * 102 (composite curve, split into one CurveData per member) and applies 124
 * transforms to the geometry that references them. Everything else is counted in
 * `skipped` (entity type → count) and never throws.
 */

// --- Number / string formatting (deterministic, no locale) --------------------

/** Integer field. */
function fmtInt(n: number): string {
  return String(Math.round(n));
}

/**
 * Real field: fixed decimal (never exponential for scene-scale magnitudes), up
 * to 9 fractional digits, trailing zeros trimmed but always one digit after the
 * point, -0 normalized to 0. Deterministic → byte-identical export.
 */
function fmtReal(n: number): string {
  if (!Number.isFinite(n)) n = 0;
  if (Object.is(n, -0)) n = 0;
  let s = n.toFixed(9); // always contains '.'
  s = s.replace(/0+$/, '');
  if (s.endsWith('.')) s += '0';
  if (s === '-0.0') s = '0.0';
  return s;
}

/** Hollerith string: `nHtext`. */
function hollerith(s: string): string {
  return `${s.length}H${s}`;
}

// --- Export: line assembly ----------------------------------------------------

const FIXED_DATE = '20260101.000000'; // frozen so export is deterministic

/** Pad/clip `content` to 72 cols, append the section letter + 7-digit sequence. */
function sectionLine(content: string, letter: string, seq: number): string {
  const body = content.length >= 72 ? content.slice(0, 72) : content.padEnd(72, ' ');
  return body + letter + String(seq).padStart(7, ' ');
}

/** One directory-entry field: 8 cols, right-justified integer. */
function deInt(n: number): string {
  return String(Math.round(n)).padStart(8, ' ');
}

interface Ent {
  type: number;
  form: number;
  label: string;
  /** Physically-dependent subordinate (trim curves / 142s) → status subfield. */
  subordinate: boolean;
  /** Built after every entity's DE pointer is assigned (may reference others). */
  tokens: string[];
  dePtr: number;
  pdPtr: number;
  pdCount: number;
  bodies: string[]; // ≤64-col data portions of this entity's P lines
}

/** NCurve homogeneous CP → euclidean {x,y,z,w}. */
function ncEuclid(c: NCurve): { pts: Vec3[]; w: number[] } {
  const pts: Vec3[] = [];
  const w: number[] = [];
  for (const q of c.Pw) {
    const wi = q[3] === 0 ? 1 : q[3];
    pts.push(new Vec3(q[0] / wi, q[1] / wi, q[2] / wi));
    w.push(wi);
  }
  return { pts, w };
}

/** NSurface homogeneous CP → euclidean point + weight, keeping flat iu*nv+iv. */
function nsEuclid(s: NSurface): { pts: Vec3[]; w: number[] } {
  const pts: Vec3[] = [];
  const w: number[] = [];
  for (const q of s.Pw) {
    const wi = q[3] === 0 ? 1 : q[3];
    pts.push(new Vec3(q[0] / wi, q[1] / wi, q[2] / wi));
    w.push(wi);
  }
  return { pts, w };
}

/** Pack delimited parameter tokens into ≤64-col data bodies (breaks only at a
 *  delimiter boundary so no field is ever split). */
function packBodies(tokens: string[], pd: string, rd: string): string[] {
  const parts = tokens.map((t, i) => t + (i < tokens.length - 1 ? pd : rd));
  const bodies: string[] = [];
  let cur = '';
  for (const part of parts) {
    if (cur.length + part.length > 64 && cur.length > 0) {
      bodies.push(cur);
      cur = '';
    }
    cur += part;
  }
  if (cur.length > 0) bodies.push(cur);
  return bodies;
}

/**
 * Build the entity 126 (Rational B-Spline Curve) parameter tokens for a curve
 * whose euclidean control points are already world-space.
 */
function curve126Tokens(c: NCurve, pts: Vec3[], w: number[], closed: boolean, periodic: boolean): string[] {
  const K = pts.length - 1;
  const M = c.p;
  const polynomial = w.every((x) => Math.abs(x - 1) < 1e-12) ? 1 : 0;
  const [v0, v1] = knotDomain(pts.length, c.p, c.U);
  const t: string[] = [fmtInt(126), fmtInt(K), fmtInt(M), fmtInt(0), fmtInt(closed ? 1 : 0), fmtInt(polynomial), fmtInt(periodic ? 1 : 0)];
  for (const k of c.U) t.push(fmtReal(k));
  for (const x of w) t.push(fmtReal(x));
  for (const p of pts) t.push(fmtReal(p.x), fmtReal(p.y), fmtReal(p.z));
  t.push(fmtReal(v0), fmtReal(v1));
  t.push(fmtReal(0), fmtReal(0), fmtReal(1)); // unit normal (nonplanar → convention)
  return t;
}

/** Build the entity 128 (Rational B-Spline Surface) parameter tokens. */
function surface128Tokens(s: NSurface, pts: Vec3[], w: number[]): string[] {
  const K1 = s.nu - 1;
  const K2 = s.nv - 1;
  const M1 = s.pu;
  const M2 = s.pv;
  const polynomial = w.every((x) => Math.abs(x - 1) < 1e-12) ? 1 : 0;
  const [u0, u1] = knotDomain(s.nu, s.pu, s.U);
  const [v0, v1] = knotDomain(s.nv, s.pv, s.V);
  const t: string[] = [
    fmtInt(128), fmtInt(K1), fmtInt(K2), fmtInt(M1), fmtInt(M2),
    fmtInt(0), fmtInt(0), fmtInt(polynomial), fmtInt(0), fmtInt(0),
  ];
  for (const k of s.U) t.push(fmtReal(k));
  for (const k of s.V) t.push(fmtReal(k));
  // IGES ordering: first subscript (iu) varies fastest, second (iv) outer.
  for (let iv = 0; iv < s.nv; iv++) for (let iu = 0; iu < s.nu; iu++) t.push(fmtReal(w[iu * s.nv + iv]));
  for (let iv = 0; iv < s.nv; iv++) {
    for (let iu = 0; iu < s.nu; iu++) {
      const p = pts[iu * s.nv + iv];
      t.push(fmtReal(p.x), fmtReal(p.y), fmtReal(p.z));
    }
  }
  t.push(fmtReal(u0), fmtReal(u1), fmtReal(v0), fmtReal(v1));
  return t;
}

export function exportIges(scene: Scene): string {
  const pd = ',';
  const rd = ';';
  const ents: Ent[] = [];

  const addEnt = (e: Omit<Ent, 'dePtr' | 'pdPtr' | 'pdCount' | 'bodies'>): Ent => {
    const full: Ent = { ...e, dePtr: 0, pdPtr: 0, pdCount: 0, bodies: [] };
    ents.push(full);
    return full;
  };

  for (const obj of scene.objects) {
    if (!scene.effectiveVisible(obj)) continue;
    const mat = scene.worldMatrix(obj);

    if (obj.kind === 'curve' && obj.curve) {
      const nc = fromCurveData(obj.curve);
      if (!nc) continue;
      const { pts, w } = ncEuclid(nc);
      const world = pts.map((p) => mat.transformPoint(p));
      const label = obj.name.slice(0, 8);
      addEnt({
        type: 126, form: 0, label, subordinate: false,
        tokens: curve126Tokens(nc, world, w, obj.curve.cyclic, obj.curve.cyclic),
      });
    } else if (obj.kind === 'surface' && obj.surface) {
      const ns = fromSurfaceData(obj.surface);
      if (!ns) continue;
      const { pts, w } = nsEuclid(ns);
      const world = pts.map((p) => mat.transformPoint(p));
      const label = obj.name.slice(0, 8);
      const surfEnt = addEnt({
        type: 128, form: 0, label, subordinate: false,
        tokens: surface128Tokens(ns, world, w),
      });

      const trims = obj.surface.trims ?? [];
      if (trims.length > 0) {
        // Emit a parameter-space 126 + a 142 per loop, then a 144 tying them.
        const cot142: { ent: Ent; hole: boolean }[] = [];
        for (const loop of trims) {
          const uv = fromCurveData(loop.curve);
          if (!uv) continue;
          const { pts: uvPts, w: uvW } = ncEuclid(uv);
          const paramEnt = addEnt({
            type: 126, form: 0, label: 'trimUV', subordinate: true,
            tokens: curve126Tokens(uv, uvPts, uvW, loop.curve.cyclic, loop.curve.cyclic),
          });
          const cotEnt = addEnt({
            type: 142, form: 0, label: 'cos', subordinate: true,
            // filled after DE pointers known (needs surfEnt + paramEnt dePtr)
            tokens: [],
          });
          // Defer 142 tokens until DE pointers assigned.
          (cotEnt as unknown as { _deferred?: () => string[] })._deferred = () => [
            fmtInt(142), fmtInt(0), fmtInt(surfEnt.dePtr), fmtInt(paramEnt.dePtr), fmtInt(0), fmtInt(1),
          ];
          cot142.push({ ent: cotEnt, hole: loop.hole });
        }
        const outer = cot142.find((c) => !c.hole);
        const holes = cot142.filter((c) => c.hole);
        const n1 = outer ? 1 : 0;
        const trimEnt = addEnt({
          type: 144, form: 0, label: 'trimSrf', subordinate: false,
          tokens: [],
        });
        (trimEnt as unknown as { _deferred?: () => string[] })._deferred = () => [
          fmtInt(144), fmtInt(surfEnt.dePtr), fmtInt(n1), fmtInt(holes.length),
          fmtInt(outer ? outer.ent.dePtr : 0),
          ...holes.map((h) => fmtInt(h.ent.dePtr)),
        ];
      }
    }
  }

  // Assign DE pointers, then resolve deferred token builders (cross-references).
  ents.forEach((e, i) => { e.dePtr = 1 + 2 * i; });
  for (const e of ents) {
    const def = (e as unknown as { _deferred?: () => string[] })._deferred;
    if (def) e.tokens = def();
    e.bodies = packBodies(e.tokens, pd, rd);
    e.pdCount = e.bodies.length;
  }
  // Assign P start pointers.
  let pSeq = 1;
  for (const e of ents) { e.pdPtr = pSeq; pSeq += e.pdCount; }

  // --- S section ---
  const sLines = [sectionLine('Vibe Coded Blender IGES export (NB-D1).', 'S', 1)];

  // --- G section ---
  const gTokens: string[] = [
    hollerith(pd), hollerith(rd),
    hollerith('VibeBlender'), hollerith('vibe.igs'), hollerith('VibeBlender'), hollerith('NB-D1'),
    fmtInt(32), fmtInt(38), fmtInt(6), fmtInt(308), fmtInt(15),
    hollerith('VibeBlender'),
    fmtReal(1), fmtInt(6), hollerith('M'),
    fmtInt(1), fmtReal(1),
    hollerith(FIXED_DATE),
    fmtReal(0.0001), fmtReal(0),
    hollerith('Fable'), hollerith('HandleBar3D'),
    fmtInt(11), fmtInt(0),
    hollerith(FIXED_DATE),
  ];
  const gBodies = packBodies(gTokens, pd, rd);
  const gLines = gBodies.map((b, i) => sectionLine(b, 'G', i + 1));

  // --- D section ---
  const dLines: string[] = [];
  ents.forEach((e, i) => {
    const status = `0000${e.subordinate ? '01' : '00'}00`; // subfield 2 = subordinate switch
    const line1 =
      deInt(e.type) + deInt(e.pdPtr) + deInt(0) + deInt(0) + deInt(0) +
      deInt(0) + deInt(0) + deInt(0) + status.padStart(8, '0');
    const line2 =
      deInt(e.type) + deInt(0) + deInt(0) + deInt(e.pdCount) + deInt(e.form) +
      ' '.repeat(8) + ' '.repeat(8) + e.label.padEnd(8, ' ').slice(0, 8) + deInt(0);
    dLines.push(sectionLine(line1, 'D', 2 * i + 1));
    dLines.push(sectionLine(line2, 'D', 2 * i + 2));
  });

  // --- P section ---
  const pLines: string[] = [];
  let pn = 1;
  for (const e of ents) {
    for (const body of e.bodies) {
      const data = body.padEnd(64, ' ').slice(0, 64);
      const content = data + String(e.dePtr).padStart(8, ' ');
      pLines.push(sectionLine(content, 'P', pn++));
    }
  }

  // --- T section ---
  const tBody =
    'S' + String(sLines.length).padStart(7, ' ') +
    'G' + String(gLines.length).padStart(7, ' ') +
    'D' + String(dLines.length).padStart(7, ' ') +
    'P' + String(pLines.length).padStart(7, ' ');
  const tLines = [sectionLine(tBody, 'T', 1)];

  return [...sLines, ...gLines, ...dLines, ...pLines, ...tLines].join('\n') + '\n';
}

// --- Import -------------------------------------------------------------------

export interface ImportResult {
  curves: number;
  surfaces: number;
  /** Entity type → count of entities skipped (unsupported / model-space trims). */
  skipped: Map<number, number>;
}

/** Parse the Global section's custom parameter/record delimiters (default , ;). */
function parseGlobalDelims(g: string): { pd: string; rd: string } {
  let pd = ',';
  let rd = ';';
  const m = /^(\d+)H/.exec(g);
  if (m) {
    const n = Number(m[1]);
    const content = g.slice(m[0].length, m[0].length + n);
    if (content.length === 1) pd = content;
    let rest = g.slice(m[0].length + n);
    if (rest[0] === pd) rest = rest.slice(1);
    const m2 = /^(\d+)H/.exec(rest);
    if (m2) {
      const n2 = Number(m2[1]);
      const c2 = rest.slice(m2[0].length, m2[0].length + n2);
      if (c2.length === 1) rd = c2;
    }
  }
  return { pd, rd };
}

interface DERecord {
  type: number;
  pdPtr: number;
  pdCount: number;
  transformPtr: number;
  form: number;
  label: string;
  status: string;
  dePtr: number;
  /** Parsed parameter tokens (entity type first). */
  tokens: string[];
}

/** Sequential token reader over an entity's parameter tokens. */
class Reader {
  private i = 0;
  constructor(private t: string[]) {}
  int(): number { return Math.round(Number((this.t[this.i++] ?? '0').trim())); }
  real(): number {
    let s = (this.t[this.i++] ?? '0').trim();
    s = s.replace(/[dD]/, 'e'); // Fortran D-exponent → JS
    const v = Number(s);
    return Number.isFinite(v) ? v : 0;
  }
  remaining(): number { return this.t.length - this.i; }
}

/** Build a CurveData from a 126 record's tokens (euclidean CP + weights). */
function parse126(tokens: string[]): CurveData | null {
  const r = new Reader(tokens);
  const type = r.int();
  if (type !== 126) return null;
  const K = r.int();
  const M = r.int();
  r.int(); r.int(); r.int(); r.int(); // PROP1..4
  const n = K + 1;
  if (n < 2) return null;
  const nKnots = n + M + 1;
  const knots: number[] = [];
  for (let i = 0; i < nKnots; i++) knots.push(r.real());
  const w: number[] = [];
  for (let i = 0; i < n; i++) w.push(r.real());
  const pts: [number, number, number][] = [];
  for (let i = 0; i < n; i++) pts.push([r.real(), r.real(), r.real()]);
  return {
    kind: 'nurbs', cyclic: false, resolution: 12, order: M + 1,
    knots,
    points: pts.map((co, i) => (Math.abs(w[i] - 1) > 1e-12 ? { co, w: w[i] } : { co })),
  };
}

/** Build a SurfaceData (untrimmed) from a 128 record's tokens. */
function parse128(tokens: string[]): SurfaceData | null {
  const r = new Reader(tokens);
  const type = r.int();
  if (type !== 128) return null;
  const K1 = r.int();
  const K2 = r.int();
  const M1 = r.int();
  const M2 = r.int();
  r.int(); r.int(); r.int(); r.int(); r.int(); // PROP1..5
  const nu = K1 + 1;
  const nv = K2 + 1;
  if (nu < 2 || nv < 2) return null;
  const knotsU: number[] = [];
  for (let i = 0; i < nu + M1 + 1; i++) knotsU.push(r.real());
  const knotsV: number[] = [];
  for (let i = 0; i < nv + M2 + 1; i++) knotsV.push(r.real());
  // Weights in IGES order (iu fastest, iv outer): igesW[iv*nu+iu].
  const igesW: number[] = [];
  for (let i = 0; i < nu * nv; i++) igesW.push(r.real());
  const igesP: [number, number, number][] = [];
  for (let i = 0; i < nu * nv; i++) igesP.push([r.real(), r.real(), r.real()]);
  // Repack into our flat order iu*nv+iv.
  const points: SurfacePoint[] = new Array(nu * nv);
  for (let iv = 0; iv < nv; iv++) {
    for (let iu = 0; iu < nu; iu++) {
      const src = iv * nu + iu;
      const wi = igesW[src];
      const co = igesP[src];
      points[iu * nv + iv] = Math.abs(wi - 1) > 1e-12 ? { co, w: wi } : { co };
    }
  }
  return {
    degreeU: M1, degreeV: M2, pointsU: nu, pointsV: nv,
    knotsU, knotsV, points, tess: defaultSurfaceTess(),
  };
}

/** Build a degree-1 CurveData from a 110 (Line) record: two endpoints. */
function parse110(tokens: string[]): CurveData | null {
  const r = new Reader(tokens);
  if (r.int() !== 110) return null;
  const a: [number, number, number] = [r.real(), r.real(), r.real()];
  const b: [number, number, number] = [r.real(), r.real(), r.real()];
  return {
    kind: 'nurbs', cyclic: false, resolution: 12, order: 2,
    knots: [0, 0, 1, 1],
    points: [{ co: a }, { co: b }],
  };
}

/**
 * Build an exact rational CurveData from a 100 (Circular Arc) record. The arc
 * lives in the plane Z = ZT of its (optional) 124 transform's local frame; here
 * we emit it in that local frame (Z = ZT) and the caller applies the transform.
 */
function parse100(tokens: string[]): CurveData | null {
  const r = new Reader(tokens);
  if (r.int() !== 100) return null;
  const zt = r.real();
  const cx = r.real(), cy = r.real();
  const sx = r.real(), sy = r.real();
  const ex = r.real(), ey = r.real();
  const radius = Math.hypot(sx - cx, sy - cy);
  if (radius < 1e-12) return null;
  let a0 = Math.atan2(sy - cy, sx - cx);
  let a1 = Math.atan2(ey - cy, ex - cx);
  // IGES arcs sweep counter-clockwise from start to end.
  let sweep = a1 - a0;
  while (sweep <= 1e-9) sweep += 2 * Math.PI;
  // Split into ≤90° rational-quadratic Bézier segments.
  const narcs = Math.max(1, Math.ceil(sweep / (Math.PI / 2 + 1e-9)));
  const dth = sweep / narcs;
  const w1 = Math.cos(dth / 2);
  const points: { co: [number, number, number]; w?: number }[] = [];
  const at = (ang: number): [number, number, number] => [cx + radius * Math.cos(ang), cy + radius * Math.sin(ang), zt];
  const tangent = (ang: number): [number, number] => [-Math.sin(ang), Math.cos(ang)];
  let ang = a0;
  points.push({ co: at(ang) });
  for (let s = 0; s < narcs; s++) {
    const p0 = at(ang);
    const t0 = tangent(ang);
    const angNext = ang + dth;
    const p2 = at(angNext);
    // Middle control point = intersection of the endpoint tangents.
    const d = radius * Math.tan(dth / 2);
    const mid: [number, number, number] = [p0[0] + d * t0[0], p0[1] + d * t0[1], zt];
    points.push({ co: mid, w: w1 });
    points.push({ co: p2 });
    ang = angNext;
  }
  // Degree-2 knot vector: clamped ends, doubled interior segment boundaries.
  const knots: number[] = [0, 0, 0];
  for (let s = 1; s < narcs; s++) knots.push(s / narcs, s / narcs);
  knots.push(1, 1, 1);
  return { kind: 'nurbs', cyclic: false, resolution: 12, order: 3, knots, points };
}

/** A 124 transform record's 3×4 matrix → a Mat4 (p' = R·p + T). */
function parse124(tokens: string[]): Mat4 | null {
  const r = new Reader(tokens);
  if (r.int() !== 124) return null;
  const R00 = r.real(), R01 = r.real(), R02 = r.real(), T0 = r.real();
  const R10 = r.real(), R11 = r.real(), R12 = r.real(), T1 = r.real();
  const R20 = r.real(), R21 = r.real(), R22 = r.real(), T2 = r.real();
  return new Mat4([
    R00, R10, R20, 0,
    R01, R11, R21, 0,
    R02, R12, R22, 0,
    T0, T1, T2, 1,
  ]);
}

/** Apply a Mat4 to every control point of a CurveData (weights untouched). */
function applyMatCurve(c: CurveData, m: Mat4): void {
  for (const p of c.points) {
    const v = m.transformPoint(new Vec3(p.co[0], p.co[1], p.co[2]));
    p.co = [v.x, v.y, v.z];
  }
}

/** Apply a Mat4 to every control point of a SurfaceData. */
function applyMatSurface(s: SurfaceData, m: Mat4): void {
  for (const p of s.points) {
    const v = m.transformPoint(new Vec3(p.co[0], p.co[1], p.co[2]));
    p.co = [v.x, v.y, v.z];
  }
}

export function importIges(text: string, scene: Scene): ImportResult {
  const skipped = new Map<number, number>();
  const bump = (type: number) => skipped.set(type, (skipped.get(type) ?? 0) + 1);

  // Slice the file into section lines by column 73.
  const raw = text.split(/\r?\n/).filter((l) => l.length >= 73);
  const gParts: string[] = [];
  const dLines: string[] = [];
  const pBySeq = new Map<number, string>();
  for (const line of raw) {
    const letter = line[72];
    if (letter === 'G') gParts.push(line.slice(0, 72));
    else if (letter === 'D') dLines.push(line);
    else if (letter === 'P') {
      const seq = Math.round(Number(line.substring(73, 80)));
      if (Number.isFinite(seq)) pBySeq.set(seq, line);
    }
  }

  const { pd, rd } = parseGlobalDelims(gParts.join(''));

  // Parse directory entries (two lines per entity).
  const fieldInt = (line: string, field: number): number => {
    const v = Number(line.substring((field - 1) * 8, field * 8).trim());
    return Number.isFinite(v) ? Math.round(v) : 0;
  };
  const deByPtr = new Map<number, DERecord>();
  const order: DERecord[] = [];
  for (let i = 0; i + 1 < dLines.length; i += 2) {
    const l1 = dLines[i];
    const l2 = dLines[i + 1];
    const dePtr = Math.round(Number(l1.substring(73, 80)));
    const rec: DERecord = {
      type: fieldInt(l1, 1),
      pdPtr: fieldInt(l1, 2),
      transformPtr: fieldInt(l1, 7),
      status: l1.substring(64, 72),
      pdCount: fieldInt(l2, 4),
      form: fieldInt(l2, 5),
      label: l2.substring(56, 64).trim(),
      dePtr,
      tokens: [],
    };
    deByPtr.set(dePtr, rec);
    order.push(rec);
  }

  // Gather each entity's parameter tokens from its P lines.
  for (const rec of order) {
    let joined = '';
    for (let k = 0; k < rec.pdCount; k++) {
      const line = pBySeq.get(rec.pdPtr + k);
      if (!line) continue;
      joined += line.substring(0, 64).replace(/\s+$/, ''); // data cols, drop pad
    }
    const rdIdx = joined.lastIndexOf(rd);
    if (rdIdx >= 0) joined = joined.slice(0, rdIdx);
    rec.tokens = joined.length > 0 ? joined.split(pd) : [];
  }

  // Transforms (124): parsed, applied where referenced — never an object.
  const transforms = new Map<number, Mat4>();
  const consumed = new Set<number>();
  for (const rec of order) {
    if (rec.type === 124) {
      const m = parse124(rec.tokens);
      if (m) transforms.set(rec.dePtr, m);
      consumed.add(rec.dePtr); // structural, not a "skipped" object
    }
  }
  const matOf = (rec: DERecord): Mat4 | null =>
    rec.transformPtr && transforms.has(rec.transformPtr) ? transforms.get(rec.transformPtr)! : null;

  let curves = 0;
  let surfaces = 0;
  let curveNames = 0;
  let surfaceNames = 0;

  // --- Trimmed surfaces first (144 consumes its 128 + 142s + param 126s) ---
  for (const rec of order) {
    if (rec.type !== 144 || consumed.has(rec.dePtr)) continue;
    const r = new Reader(rec.tokens);
    if (r.int() !== 144) continue;
    const surfPtr = r.int();
    const n1 = r.int();
    const n2 = r.int();
    const pto = r.int();
    const pti: number[] = [];
    for (let i = 0; i < n2; i++) pti.push(r.int());

    const surfRec = deByPtr.get(surfPtr);
    if (!surfRec || surfRec.type !== 128) { bump(144); continue; }
    const sd = parse128(surfRec.tokens);
    if (!sd) { bump(144); continue; }
    const sMat = matOf(surfRec);
    if (sMat) applyMatSurface(sd, sMat);

    const trims: TrimLoop[] = [];
    const consumeLoop = (cotPtr: number, hole: boolean): void => {
      const cot = deByPtr.get(cotPtr);
      if (!cot || cot.type !== 142) return;
      consumed.add(cot.dePtr);
      const cr = new Reader(cot.tokens);
      cr.int(); // 142
      cr.int(); // CRTN
      cr.int(); // SPTR (surface)
      const bptr = cr.int(); // BPTR (parameter-space curve)
      const cptr = cr.int(); // CPTR (model-space curve)
      if (cptr) consumed.add(cptr);
      if (!bptr) { bump(142); return; } // model-space-only loop → out of scope
      const pcRec = deByPtr.get(bptr);
      if (!pcRec || pcRec.type !== 126) { bump(142); return; }
      consumed.add(bptr);
      const uv = parse126(pcRec.tokens);
      if (!uv) { bump(142); return; }
      trims.push({ curve: uv, hole });
    };
    if (n1 === 1 && pto) consumeLoop(pto, false);
    for (const p of pti) consumeLoop(p, true);

    if (trims.length > 0) sd.trims = trims;
    consumed.add(surfRec.dePtr);
    consumed.add(rec.dePtr);
    const name = surfRec.label || `Iges128.${String(++surfaceNames).padStart(3, '0')}`;
    scene.addSurface(name, sd);
    surfaces++;
  }

  // Pre-mark composite (102) members consumed so they aren't ALSO imported as
  // standalone curves when they precede their 102 in DE order.
  for (const rec of order) {
    if (rec.type !== 102 || consumed.has(rec.dePtr)) continue;
    const r = new Reader(rec.tokens);
    r.int(); // 102
    const nmem = r.int();
    for (let i = 0; i < nmem; i++) consumed.add(r.int());
  }

  // --- Remaining entities in DE order ---
  for (const rec of order) {
    if (rec.type === 102) {
      // Handled below regardless of the consumed pre-mark of its members.
    } else if (consumed.has(rec.dePtr)) continue;
    const mat = matOf(rec);
    switch (rec.type) {
      case 126: {
        const cd = parse126(rec.tokens);
        if (!cd) { bump(126); break; }
        if (mat) applyMatCurve(cd, mat);
        const name = rec.label || `Iges126.${String(++curveNames).padStart(3, '0')}`;
        scene.addCurve(name, cd);
        curves++;
        break;
      }
      case 128: {
        const sd = parse128(rec.tokens);
        if (!sd) { bump(128); break; }
        if (mat) applyMatSurface(sd, mat);
        const name = rec.label || `Iges128.${String(++surfaceNames).padStart(3, '0')}`;
        scene.addSurface(name, sd);
        surfaces++;
        break;
      }
      case 110: {
        const cd = parse110(rec.tokens);
        if (!cd) { bump(110); break; }
        if (mat) applyMatCurve(cd, mat);
        const name = rec.label || `Iges110.${String(++curveNames).padStart(3, '0')}`;
        scene.addCurve(name, cd);
        curves++;
        break;
      }
      case 100: {
        const cd = parse100(rec.tokens);
        if (!cd) { bump(100); break; }
        if (mat) applyMatCurve(cd, mat);
        const name = rec.label || `Iges100.${String(++curveNames).padStart(3, '0')}`;
        scene.addCurve(name, cd);
        curves++;
        break;
      }
      case 102: {
        // Composite curve: one CurveData per member (do NOT merge).
        const r = new Reader(rec.tokens);
        r.int(); // 102
        const nmem = r.int();
        const members: number[] = [];
        for (let i = 0; i < nmem; i++) members.push(r.int());
        let idx = 0;
        for (const mptr of members) {
          const mrec = deByPtr.get(mptr);
          if (!mrec) continue;
          consumed.add(mptr);
          let cd: CurveData | null = null;
          if (mrec.type === 126) cd = parse126(mrec.tokens);
          else if (mrec.type === 110) cd = parse110(mrec.tokens);
          else if (mrec.type === 100) cd = parse100(mrec.tokens);
          if (!cd) { bump(mrec.type); continue; }
          const mmat = matOf(mrec);
          if (mmat) applyMatCurve(cd, mmat);
          const base = rec.label || 'IgesComposite';
          const name = `${base}.${String(++idx).padStart(3, '0')}`;
          scene.addCurve(name, cd);
          curves++;
        }
        consumed.add(rec.dePtr);
        break;
      }
      case 142:
        // A standalone Curve-on-Surface not tied to a 144 → out of scope.
        bump(142);
        break;
      default:
        bump(rec.type);
        break;
    }
  }

  return { curves, surfaces, skipped };
}
