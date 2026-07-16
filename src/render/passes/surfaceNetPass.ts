import { Shader } from '../gl/Shader';
import { VertexArray } from '../gl/VertexArray';
import type { SurfaceData } from '../../core/scene/objectData';
import type { SurfaceEditState } from '../../core/scene/SurfaceEdit';
import type { Mat4 } from '../../core/math/mat4';

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

interface NetBuffers {
  key: string;
  lineVa: VertexArray | null;
  dotVa: VertexArray | null;
}

export class SurfaceNetPass {
  private readonly shader: Shader;
  private readonly cache = new Map<number, NetBuffers>();

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.shader = new Shader(gl, VERT, FRAG, 'surface-net');
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

    // Hull lines first (under the dots).
    if (lineVa) {
      this.shader.setFloat('u_pointSize', 1.0);
      lineVa.draw(gl.LINES);
    }
    // Control-point dots on top.
    if (dotVa) {
      this.shader.setFloat('u_pointSize', 8.0);
      dotVa.draw(gl.POINTS);
    }
  }
}
