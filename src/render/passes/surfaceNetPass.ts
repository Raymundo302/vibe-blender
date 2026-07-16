import { Shader } from '../gl/Shader';
import { VertexArray } from '../gl/VertexArray';
import type { SurfaceData } from '../../core/scene/objectData';
import type { SurfaceEditState } from '../../core/scene/SurfaceEdit';
import type { Mat4 } from '../../core/math/mat4';
import { fromSurfaceData, isoCurve } from '../../core/nurbs/surface';
import { curveDomain, curvePoint } from '../../core/nurbs/curve';
import { interiorKnots, knotDomain } from '../../core/nurbs/basis';
import { evalSurfaceCurve3D } from '../../core/nurbs/cos';
import { isoparmsOn } from '../isoparmPrefs';

/**
 * Surface Edit Mode overlay (NB-A2) — the control net of a NURBS surface: hull
 * lines (grey) both directions (rows iu=const, columns iv=const) and control-
 * point dots (white; selection orange). The surface analogue of CurveEditPass;
 * shares its shader shape (per-vertex colour, a fractional pull toward the eye
 * to win z-fighting against the tessellated surface) and its cache discipline —
 * buffers rebuild only when (surface signature, selection.version) changes.
 *
 * Unlike curve edit (exactly one curve on screen) an object-mode `showNet` frame
 * can draw several surfaces, so the cache is keyed per object id.
 */
const VERT = /* glsl */ `#version 300 es
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_color;
uniform mat4 u_modelView;
uniform mat4 u_proj;
uniform float u_pointSize;
out vec3 v_color;
void main() {
  v_color = a_color;
  vec4 viewPos = u_modelView * vec4(a_position, 1.0);
  viewPos.xyz *= (1.0 - 0.0015); // fractional pull toward the eye (win z-fight)
  gl_Position = u_proj * viewPos;
  gl_PointSize = u_pointSize;
}`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec3 v_color;
out vec4 outColor;
void main() { outColor = vec4(v_color, 1.0); }`;

const SEL: [number, number, number] = [0.996, 0.66, 0.2]; // selection orange
const CTRL: [number, number, number] = [0.95, 0.95, 0.95]; // unselected point
const LINE: [number, number, number] = [0.45, 0.45, 0.5]; // hull line
const ISO: [number, number, number] = [0.32, 0.62, 0.72]; // isoparm grey-cyan
const COS: [number, number, number] = [0.95, 0.6, 0.12]; // curve-on-surface warm amber
const ISO_SEGS = 64; // samples per isoparametric curve
const COS_SEGS = 96; // samples per curve-on-surface polyline

interface NetBuffers {
  key: string;
  lineVa: VertexArray | null;
  dotVa: VertexArray | null;
}

interface IsoBuffers {
  key: string;
  va: VertexArray | null;
}

export class SurfaceNetPass {
  private readonly shader: Shader;
  private readonly cache = new Map<number, NetBuffers>();
  private readonly isoCache = new Map<number, IsoBuffers>();
  private readonly cosCache = new Map<number, IsoBuffers>();

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.shader = new Shader(gl, VERT, FRAG, 'surface-net');
  }

  /** Build (or reuse) the isoparm line buffer: the exact isoparametric curves
   *  at every distinct interior knot in each direction + the 4 boundary curves,
   *  each sampled at ISO_SEGS segments. Cached by surface signature. */
  private rebuildIso(objectId: number, surface: SurfaceData): VertexArray | null {
    const key = JSON.stringify(surface);
    const cached = this.isoCache.get(objectId);
    if (cached && cached.key === key) return cached.va;
    cached?.va?.dispose();

    const s = fromSurfaceData(surface);
    let va: VertexArray | null = null;
    if (s) {
      const [ul, uh] = knotDomain(s.nu, s.pu, s.U);
      const [vl, vh] = knotDomain(s.nv, s.pv, s.V);
      // Iso-U curves (fixed u, running along V): both boundaries + interior U knots.
      const uParams = [ul, ...interiorKnots(s.nu, s.pu, s.U).map((k) => k.u), uh];
      // Iso-V curves (fixed v, running along U): both boundaries + interior V knots.
      const vParams = [vl, ...interiorKnots(s.nv, s.pv, s.V).map((k) => k.u), vh];

      const pos: number[] = [];
      const col: number[] = [];
      const sampleCurve = (dir: 'u' | 'v', t: number): void => {
        const c = isoCurve(s, dir, t);
        const [lo, hi] = curveDomain(c);
        let prev = curvePoint(c, lo);
        for (let i = 1; i <= ISO_SEGS; i++) {
          const p = curvePoint(c, lo + ((hi - lo) * i) / ISO_SEGS);
          pos.push(prev.x, prev.y, prev.z, p.x, p.y, p.z);
          for (let k = 0; k < 2; k++) col.push(ISO[0], ISO[1], ISO[2]);
          prev = p;
        }
      };
      for (const u of uParams) sampleCurve('u', u);
      for (const v of vParams) sampleCurve('v', v);

      if (pos.length > 0) {
        va = new VertexArray(this.gl, [
          { location: 0, size: 3, data: new Float32Array(pos) },
          { location: 1, size: 3, data: new Float32Array(col) },
        ]);
      }
    }
    this.isoCache.set(objectId, { key, va });
    return va;
  }

  /** Build (or reuse) the curve-on-surface line buffer: each `surfaceCurves`
   *  entry sampled through the surface map into a warm-amber 3D polyline. Cached
   *  by surface signature (surfaceCurves are part of the stringified payload). */
  private rebuildCos(objectId: number, surface: SurfaceData): VertexArray | null {
    const key = JSON.stringify(surface.surfaceCurves ?? []);
    const cached = this.cosCache.get(objectId);
    if (cached && cached.key === key) return cached.va;
    cached?.va?.dispose();

    let va: VertexArray | null = null;
    const curves = surface.surfaceCurves ?? [];
    if (curves.length > 0) {
      const pos: number[] = [];
      const col: number[] = [];
      for (const sc of curves) {
        const poly = evalSurfaceCurve3D(surface, sc.curve, COS_SEGS);
        for (let i = 1; i < poly.length; i++) {
          const a = poly[i - 1], b = poly[i];
          pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
          for (let k = 0; k < 2; k++) col.push(COS[0], COS[1], COS[2]);
        }
      }
      if (pos.length > 0) {
        va = new VertexArray(this.gl, [
          { location: 0, size: 3, data: new Float32Array(pos) },
          { location: 1, size: 3, data: new Float32Array(col) },
        ]);
      }
    }
    this.cosCache.set(objectId, { key, va });
    return va;
  }

  private rebuild(objectId: number, surface: SurfaceData, sel: SurfaceEditState | null): NetBuffers {
    const key = `${JSON.stringify(surface)}:${sel ? sel.version : -1}`;
    const cached = this.cache.get(objectId);
    if (cached && cached.key === key) return cached;
    cached?.lineVa?.dispose();
    cached?.dotVa?.dispose();

    const nu = surface.pointsU;
    const nv = surface.pointsV;
    const pts = surface.points;
    const at = (iu: number, iv: number) => pts[iu * nv + iv];

    const dotPos: number[] = [];
    const dotCol: number[] = [];
    const linePos: number[] = [];
    const lineCol: number[] = [];
    const pushLineCol = () => { for (let k = 0; k < 2; k++) lineCol.push(LINE[0], LINE[1], LINE[2]); };

    for (let iu = 0; iu < nu; iu++) {
      for (let iv = 0; iv < nv; iv++) {
        const p = at(iu, iv);
        if (!p) continue;
        dotPos.push(p.co[0], p.co[1], p.co[2]);
        const c = sel && sel.points.has(iu * nv + iv) ? SEL : CTRL;
        dotCol.push(c[0], c[1], c[2]);
      }
    }

    // Rows (iu = const): connect consecutive iv along V.
    for (let iu = 0; iu < nu; iu++) {
      for (let iv = 0; iv < nv - 1; iv++) {
        const a = at(iu, iv);
        const b = at(iu, iv + 1);
        if (!a || !b) continue;
        linePos.push(a.co[0], a.co[1], a.co[2], b.co[0], b.co[1], b.co[2]);
        pushLineCol();
      }
    }
    // Columns (iv = const): connect consecutive iu along U.
    for (let iv = 0; iv < nv; iv++) {
      for (let iu = 0; iu < nu - 1; iu++) {
        const a = at(iu, iv);
        const b = at(iu + 1, iv);
        if (!a || !b) continue;
        linePos.push(a.co[0], a.co[1], a.co[2], b.co[0], b.co[1], b.co[2]);
        pushLineCol();
      }
    }

    const buffers: NetBuffers = {
      key,
      lineVa: linePos.length > 0 ? new VertexArray(this.gl, [
        { location: 0, size: 3, data: new Float32Array(linePos) },
        { location: 1, size: 3, data: new Float32Array(lineCol) },
      ]) : null,
      dotVa: dotPos.length > 0 ? new VertexArray(this.gl, [
        { location: 0, size: 3, data: new Float32Array(dotPos) },
        { location: 1, size: 3, data: new Float32Array(dotCol) },
      ]) : null,
    };
    this.cache.set(objectId, buffers);
    return buffers;
  }

  /** Draw the net for `objectId`'s surface. `sel` tints the selected points
   *  orange (pass null in object-mode showNet — every point is neutral). */
  render(objectId: number, modelView: Mat4, proj: Mat4, surface: SurfaceData, sel: SurfaceEditState | null): void {
    const gl = this.gl;
    const { lineVa, dotVa } = this.rebuild(objectId, surface, sel);
    this.shader.use();
    this.shader.setMat4('u_modelView', modelView);
    this.shader.setMat4('u_proj', proj);
    this.shader.setFloat('u_pointSize', 1.0);

    // Isoparametric curves first (under net + dots) when enabled for this object.
    if (isoparmsOn(objectId)) {
      const isoVa = this.rebuildIso(objectId, surface);
      if (isoVa) isoVa.draw(gl.LINES);
    }

    // Curves-on-surface (NB-C1): warm-amber polylines lying on the surface. Drawn
    // whenever the net pass runs (edit mode or object-mode showNet), on top of the
    // isoparms, under the hull + dots. Same fractional eye-pull as the net wins the
    // z-fight against the tessellated surface.
    if ((surface.surfaceCurves?.length ?? 0) > 0) {
      const cosVa = this.rebuildCos(objectId, surface);
      if (cosVa) cosVa.draw(gl.LINES);
    }

    // Hull lines (under the dots).
    if (lineVa) {
      lineVa.draw(gl.LINES);
    }
    // Control-point dots on top.
    if (dotVa) {
      this.shader.setFloat('u_pointSize', 8.0);
      dotVa.draw(gl.POINTS);
    }
  }
}
