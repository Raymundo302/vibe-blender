import { describe, it, expect } from 'vitest';
import { exportIges, importIges } from './iges';
import { Scene } from '../core/scene/Scene';
import { Transform } from '../core/math/transform';
import { Vec3 } from '../core/math/vec3';
import { fromCurveData, curvePoint, curveDomain } from '../core/nurbs/curve';
import { fromSurfaceData, surfacePoint, surfaceDomain } from '../core/nurbs/surface';
import type { CurveData, SurfaceData } from '../core/scene/objectData';

// --- Sampling helpers (trusted NURBS eval, unit-tested elsewhere) -------------

function sampleCurve(cd: CurveData, n = 24): Vec3[] {
  const nc = fromCurveData(cd)!;
  const [lo, hi] = curveDomain(nc);
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) out.push(curvePoint(nc, lo + ((hi - lo) * i) / n));
  return out;
}

function sampleSurface(sd: SurfaceData, n = 8): Vec3[] {
  const ns = fromSurfaceData(sd)!;
  const [ul, uh, vl, vh] = surfaceDomain(ns);
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      out.push(surfacePoint(ns, ul + ((uh - ul) * i) / n, vl + ((vh - vl) * j) / n));
    }
  }
  return out;
}

function maxDiff(a: Vec3[], b: Vec3[]): number {
  expect(a.length).toBe(b.length);
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, a[i].distanceTo(b[i]));
  return m;
}

// --- Test scene objects -------------------------------------------------------

function wavyNurbsCurve(): CurveData {
  return {
    kind: 'nurbs', cyclic: false, resolution: 12, order: 4,
    knots: [0, 0, 0, 0, 0.33, 0.66, 1, 1, 1, 1],
    points: [
      { co: [0, 0, 0], w: 1 },
      { co: [1, 2, 0.5], w: 2 },
      { co: [2, -1, 1], w: 0.5 },
      { co: [3, 1.5, -0.5], w: 1.5 },
      { co: [4, -0.5, 0.3], w: 1 },
      { co: [5, 0, 0], w: 3 },
    ],
  };
}

function bezierCurve(): CurveData {
  return {
    kind: 'bezier', cyclic: false, resolution: 12,
    points: [
      { co: [0, 0, 0], hr: [1, 1, 0] },
      { co: [3, 0, 1], hl: [2, -1, 0.5] },
    ],
  };
}

function rationalPatch(): SurfaceData {
  // A 3×3 biquadratic net with mixed weights (a bulging, sphere-like patch).
  const points = [
    { co: [0, 0, 0] as [number, number, number] },
    { co: [0, 1, 0.5] as [number, number, number], w: 0.7 },
    { co: [0, 2, 0] as [number, number, number] },
    { co: [1, 0, 0.5] as [number, number, number], w: 0.7 },
    { co: [1, 1, 1.5] as [number, number, number], w: 2 },
    { co: [1, 2, 0.5] as [number, number, number], w: 0.7 },
    { co: [2, 0, 0] as [number, number, number] },
    { co: [2, 1, 0.5] as [number, number, number], w: 0.7 },
    { co: [2, 2, 0] as [number, number, number] },
  ];
  return { degreeU: 2, degreeV: 2, pointsU: 3, pointsV: 3, points, tess: { mode: 'spans', segsU: 8, segsV: 8, tol: 0.01 } };
}

function trimmedSurface(): SurfaceData {
  // A flat 3×3 bilinear-ish patch over [0,2]×[0,2] with an OUTER loop and a HOLE.
  const points = [];
  for (let iu = 0; iu < 3; iu++) {
    for (let iv = 0; iv < 3; iv++) points.push({ co: [iu, iv, 0] as [number, number, number] });
  }
  const outer: CurveData = {
    kind: 'nurbs', cyclic: true, resolution: 12, order: 2,
    points: [{ co: [0.05, 0.05, 0] }, { co: [0.95, 0.05, 0] }, { co: [0.95, 0.95, 0] }, { co: [0.05, 0.95, 0] }],
  };
  const hole: CurveData = {
    kind: 'nurbs', cyclic: true, resolution: 12, order: 2,
    points: [{ co: [0.4, 0.4, 0] }, { co: [0.6, 0.4, 0] }, { co: [0.6, 0.6, 0] }, { co: [0.4, 0.6, 0] }],
  };
  return {
    degreeU: 2, degreeV: 2, pointsU: 3, pointsV: 3, points,
    tess: { mode: 'spans', segsU: 8, segsV: 8, tol: 0.01 },
    trims: [{ curve: outer, hole: false }, { curve: hole, hole: true }],
  };
}

// --- Round trip ---------------------------------------------------------------

describe('IGES round trip', () => {
  it('preserves curve + surface geometry and trim structure through export→import', () => {
    const src = new Scene();
    const cA = src.addCurve('Wavy', wavyNurbsCurve());
    cA.transform = new Transform(new Vec3(1, 2, 3)); // world transform must be baked
    src.addCurve('Bez', bezierCurve());
    src.addSurface('Patch', rationalPatch());
    src.addSurface('Trimmed', trimmedSurface());

    const text = exportIges(src);
    const dst = new Scene();
    const res = importIges(text, dst);

    expect(res.curves).toBe(2);
    expect(res.surfaces).toBe(2);

    const impCurves = dst.objects.filter((o) => o.kind === 'curve');
    const impSurfaces = dst.objects.filter((o) => o.kind === 'surface');
    expect(impCurves).toHaveLength(2);
    expect(impSurfaces).toHaveLength(2);

    // Curve A: sampled in WORLD space (transform baked into control points).
    const worldA = sampleCurve(wavyNurbsCurve()).map((p) => p.add(new Vec3(1, 2, 3)));
    const impA = impCurves.find((o) => o.curve!.points.length === 6)!;
    expect(maxDiff(sampleCurve(impA.curve!), worldA)).toBeLessThanOrEqual(1e-6);

    // Curve B (bezier → 4-CP cubic NURBS on import).
    const impB = impCurves.find((o) => o.curve!.points.length === 4)!;
    expect(maxDiff(sampleCurve(impB.curve!), sampleCurve(bezierCurve()))).toBeLessThanOrEqual(1e-6);

    // Surface C: the untrimmed rational patch.
    const impC = impSurfaces.find((o) => !o.surface!.trims)!;
    expect(maxDiff(sampleSurface(impC.surface!), sampleSurface(rationalPatch()))).toBeLessThanOrEqual(1e-6);

    // Surface D: trimmed — geometry AND trim structure survive.
    const impD = impSurfaces.find((o) => o.surface!.trims)!;
    expect(maxDiff(sampleSurface(impD.surface!), sampleSurface(trimmedSurface()))).toBeLessThanOrEqual(1e-6);
    const trims = impD.surface!.trims!;
    expect(trims).toHaveLength(2);
    expect(trims.filter((t) => t.hole)).toHaveLength(1);
    expect(trims.filter((t) => !t.hole)).toHaveLength(1);
    // The hole loop's UV geometry round-trips too.
    const srcHole = trimmedSurface().trims!.find((t) => t.hole)!.curve;
    const impHole = trims.find((t) => t.hole)!.curve;
    expect(maxDiff(sampleCurve(impHole), sampleCurve(srcHole))).toBeLessThanOrEqual(1e-6);
  });

  it('is deterministic: the same scene exports byte-identically', () => {
    const build = () => {
      const s = new Scene();
      s.addCurve('Wavy', wavyNurbsCurve());
      s.addSurface('Patch', rationalPatch());
      return exportIges(s);
    };
    expect(build()).toBe(build());
  });
});

// --- Format lint --------------------------------------------------------------

describe('IGES format', () => {
  it('emits well-formed 80-column records with monotone sequence + correct totals', () => {
    const s = new Scene();
    s.addCurve('Wavy', wavyNurbsCurve());
    s.addSurface('Trimmed', trimmedSurface());
    const lines = exportIges(s).split('\n').filter((l) => l.length > 0);

    const counts: Record<string, number> = { S: 0, G: 0, D: 0, P: 0, T: 0 };
    const lastSeq: Record<string, number> = {};
    for (const line of lines) {
      expect(line.length).toBe(80); // exactly 80 columns
      const letter = line[72]; // column 73
      expect('SGDPT').toContain(letter);
      counts[letter]++;
      const seq = Number(line.substring(73, 80));
      expect(seq).toBe((lastSeq[letter] ?? 0) + 1); // per-section, monotone by 1
      lastSeq[letter] = seq;
    }
    expect(counts.T).toBe(1);
    // Terminate line totals must match the actual section line counts.
    const t = lines[lines.length - 1];
    expect(t[72]).toBe('T');
    expect(Number(t.substring(1, 8))).toBe(counts.S);
    expect(Number(t.substring(9, 16))).toBe(counts.G);
    expect(Number(t.substring(17, 24))).toBe(counts.D);
    expect(Number(t.substring(25, 32))).toBe(counts.P);
    // D lines come in pairs (two per entity).
    expect(counts.D % 2).toBe(0);
  });
});

// --- Independent fixture builder (guards symmetric assumptions) ---------------

interface FixtureEnt {
  type: number;
  form?: number;
  label?: string;
  pd: string; // parameter data, ends with ';'
  transformPtr?: number;
}

/** Build a minimal but byte-faithful IGES file from hand-authored entities. */
function buildFixture(entities: FixtureEnt[]): string {
  const pad72 = (s: string) => (s.length >= 72 ? s.slice(0, 72) : s.padEnd(72, ' '));
  const sline = (content: string, letter: string, seq: number) => pad72(content) + letter + String(seq).padStart(7, ' ');
  const f8 = (n: number) => String(Math.round(n)).padStart(8, ' ');
  const chunk64 = (pd: string): string[] => {
    const parts = pd.match(/[^,;]*[,;]/g) ?? [pd];
    const out: string[] = [];
    let cur = '';
    for (const p of parts) {
      if (cur.length + p.length > 64 && cur.length > 0) { out.push(cur); cur = ''; }
      cur += p;
    }
    if (cur) out.push(cur);
    return out;
  };

  const S = [sline('Hand-written IGES fixture.', 'S', 1)];
  const G = [sline('1H,,1H;;', 'G', 1)]; // default delimiters, nothing else needed

  const dLines: string[] = [];
  const pLines: string[] = [];
  let pseq = 1;
  entities.forEach((e, i) => {
    const bodies = chunk64(e.pd);
    const dePtr = 2 * i + 1;
    const pdPtr = pseq;
    for (const b of bodies) {
      const data = b.padEnd(64, ' ').slice(0, 64) + String(dePtr).padStart(8, ' ');
      pLines.push(data + 'P' + String(pseq).padStart(7, ' '));
      pseq++;
    }
    const status = '00000000';
    const l1 = f8(e.type) + f8(pdPtr) + f8(0) + f8(0) + f8(0) + f8(0) + f8(e.transformPtr ?? 0) + f8(0) + status;
    const l2 = f8(e.type) + f8(0) + f8(0) + f8(bodies.length) + f8(e.form ?? 0) + '        ' + '        ' + (e.label ?? '').padEnd(8, ' ').slice(0, 8) + f8(0);
    dLines.push(sline(l1, 'D', 2 * i + 1));
    dLines.push(sline(l2, 'D', 2 * i + 2));
  });

  const tBody = 'S' + String(S.length).padStart(7, ' ') + 'G' + String(G.length).padStart(7, ' ') +
    'D' + String(dLines.length).padStart(7, ' ') + 'P' + String(pLines.length).padStart(7, ' ');
  const T = [sline(tBody, 'T', 1)];
  return [...S, ...G, ...dLines, ...pLines, ...T].join('\n') + '\n';
}

describe('IGES foreign fixtures', () => {
  it('imports a hand-written 126 curve + 128 surface to the expected geometry', () => {
    // Entity 126: a cubic Bézier (clamped knots) with known control points.
    const curvePd =
      '126,3,3,0,0,1,0,' +
      '0.,0.,0.,0.,1.,1.,1.,1.,' + // 8 knots
      '1.,1.,1.,1.,' +             // 4 weights
      '0.,0.,0.,1.,2.,0.,2.,2.,0.,3.,0.,0.,' + // 4 control points
      '0.,1.,0.,0.,1.;';          // v0,v1, normal
    // Entity 128: a flat bilinear 2×2 patch over [0,2]×[0,2] (S(u,v) = (2u,2v,0)).
    const surfPd =
      '128,1,1,1,1,0,0,1,0,0,' +
      '0.,0.,1.,1.,' +            // U knots
      '0.,0.,1.,1.,' +            // V knots
      '1.,1.,1.,1.,' +            // weights (iu fastest, iv outer)
      '0.,0.,0.,2.,0.,0.,0.,2.,0.,2.,2.,0.,' + // pts: P(0,0),P(1,0),P(0,1),P(1,1)
      '0.,1.,0.,1.;';            // U0,U1,V0,V1
    const text = buildFixture([
      { type: 126, label: 'CV', pd: curvePd },
      { type: 128, label: 'SF', pd: surfPd },
    ]);

    const scene = new Scene();
    const res = importIges(text, scene);
    expect(res.curves).toBe(1);
    expect(res.surfaces).toBe(1);

    // Curve: compare to an INDEPENDENT cubic Bézier evaluation of the CPs.
    const P = [new Vec3(0, 0, 0), new Vec3(1, 2, 0), new Vec3(2, 2, 0), new Vec3(3, 0, 0)];
    const bez = (t: number) => {
      const u = 1 - t;
      return P[0].scale(u * u * u)
        .add(P[1].scale(3 * u * u * t))
        .add(P[2].scale(3 * u * t * t))
        .add(P[3].scale(t * t * t));
    };
    const cd = scene.objects.find((o) => o.kind === 'curve')!.curve!;
    const nc = fromCurveData(cd)!;
    const [lo, hi] = curveDomain(nc);
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const got = curvePoint(nc, lo + (hi - lo) * t);
      expect(got.distanceTo(bez(t))).toBeLessThanOrEqual(1e-6);
    }

    // Surface: independent bilinear expectation S(u,v) = (2u, 2v, 0).
    const sd = scene.objects.find((o) => o.kind === 'surface')!.surface!;
    const ns = fromSurfaceData(sd)!;
    for (const [u, v] of [[0, 0], [0.3, 0.7], [1, 1], [0.5, 0.5]]) {
      const got = surfacePoint(ns, u, v);
      expect(got.distanceTo(new Vec3(2 * u, 2 * v, 0))).toBeLessThanOrEqual(1e-6);
    }
  });

  it('imports a 110 line as a 2-point degree-1 curve', () => {
    const text = buildFixture([{ type: 110, label: 'LN', pd: '110,0.,0.,0.,5.,0.,0.;' }]);
    const scene = new Scene();
    const res = importIges(text, scene);
    expect(res.curves).toBe(1);
    const cd = scene.objects.find((o) => o.kind === 'curve')!.curve!;
    expect(cd.points).toHaveLength(2);
    const nc = fromCurveData(cd)!;
    const [lo, hi] = curveDomain(nc);
    expect(curvePoint(nc, lo).distanceTo(new Vec3(0, 0, 0))).toBeLessThanOrEqual(1e-6);
    expect(curvePoint(nc, hi).distanceTo(new Vec3(5, 0, 0))).toBeLessThanOrEqual(1e-6);
    expect(curvePoint(nc, (lo + hi) / 2).distanceTo(new Vec3(2.5, 0, 0))).toBeLessThanOrEqual(1e-6);
  });

  it('imports a 100 circular arc and applies its 124 transform', () => {
    // 124 = translate +10 in X; 100 = unit quarter arc (0°→90°) in its XY plane.
    const text = buildFixture([
      { type: 124, label: 'XF', pd: '124,1.,0.,0.,10.,0.,1.,0.,0.,0.,0.,1.,0.;' },
      { type: 100, label: 'ARC', pd: '100,0.,0.,0.,1.,0.,0.,1.;', transformPtr: 1 },
    ]);
    const scene = new Scene();
    const res = importIges(text, scene);
    expect(res.curves).toBe(1);
    expect(res.skipped.has(124)).toBe(false); // 124 is applied, not skipped
    const cd = scene.objects.find((o) => o.kind === 'curve')!.curve!;
    const nc = fromCurveData(cd)!;
    const [lo, hi] = curveDomain(nc);
    // Endpoints (translated) and the 45° midpoint lie on the circle centered (10,0).
    expect(curvePoint(nc, lo).distanceTo(new Vec3(11, 0, 0))).toBeLessThanOrEqual(1e-6);
    expect(curvePoint(nc, hi).distanceTo(new Vec3(10, 1, 0))).toBeLessThanOrEqual(1e-6);
    const mid = curvePoint(nc, (lo + hi) / 2);
    expect(mid.distanceTo(new Vec3(10 + Math.SQRT1_2, Math.SQRT1_2, 0))).toBeLessThanOrEqual(1e-6);
  });

  it('splits a 102 composite curve into one CurveData per member (not merged)', () => {
    const text = buildFixture([
      { type: 110, label: 'M1', pd: '110,0.,0.,0.,1.,0.,0.;' },        // dePtr 1
      { type: 110, label: 'M2', pd: '110,1.,0.,0.,1.,1.,0.;' },        // dePtr 3
      { type: 102, label: 'CMP', pd: '102,2,1,3;' },                    // dePtr 5
    ]);
    const scene = new Scene();
    const res = importIges(text, scene);
    // Two members → two curves; the members are NOT also imported standalone.
    expect(res.curves).toBe(2);
    const names = scene.objects.filter((o) => o.kind === 'curve').map((o) => o.name);
    expect(names).toEqual(['CMP.001', 'CMP.002']);
  });
});

// --- Skip behavior ------------------------------------------------------------

describe('IGES skip behavior', () => {
  it('imports supported entities and reports an unsupported one in `skipped`', () => {
    const text = buildFixture([
      { type: 126, label: 'CV', pd: '126,1,1,0,0,1,0,0.,0.,1.,1.,1.,1.,0.,0.,0.,4.,0.,0.,0.,1.,0.,0.,1.;' },
      { type: 314, label: 'COLOR', pd: '314,80.,80.,80.,4HGREY;' },
    ]);
    const scene = new Scene();
    const res = importIges(text, scene);
    expect(res.curves).toBe(1); // the 126 still imports
    expect(res.surfaces).toBe(0);
    expect(res.skipped.get(314)).toBe(1); // the color entity is counted, not thrown
  });

  it('never throws on unknown/garbage entities', () => {
    const text = buildFixture([
      { type: 402, label: 'ASSOC', pd: '402,1,1;' },
      { type: 212, label: 'TEXT', pd: '212,1;' },
    ]);
    const scene = new Scene();
    expect(() => importIges(text, scene)).not.toThrow();
    const res = importIges(text, new Scene());
    expect(res.curves).toBe(0);
    expect(res.skipped.get(402)).toBe(1);
    expect(res.skipped.get(212)).toBe(1);
  });
});
