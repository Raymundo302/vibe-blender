import { Shader } from '../gl/Shader';
import { VertexArray } from '../gl/VertexArray';
import { leftHandle, rightHandle } from '../../core/curve/eval';
import { handleKey } from '../../core/curve/CurveEdit';
import type { CurveData } from '../../core/scene/objectData';
import type { CurveEditState } from '../../core/curve/CurveEdit';
import type { Mat4 } from '../../core/math/mat4';

/**
 * Curve Edit Mode overlay (UR11-1): control points as vert-style dots (orange
 * when selected), plus — for bezier curves — grey handle lines and smaller
 * handle dots. Buffers rebuild only when (curve signature, selection.version)
 * changes. Drawn in world space via u_modelView (like the mesh edit cage).
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
const CTRL: [number, number, number] = [0.95, 0.95, 0.95]; // unselected anchor
const HANDLE: [number, number, number] = [0.55, 0.55, 0.6]; // unselected handle
const LINE: [number, number, number] = [0.45, 0.45, 0.5]; // handle line

export class CurveEditPass {
  private readonly shader: Shader;
  private ctrlVa: VertexArray | null = null;
  private handleDotVa: VertexArray | null = null;
  private handleLineVa: VertexArray | null = null;
  private cacheKey = '';

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.shader = new Shader(gl, VERT, FRAG, 'curve-edit');
  }

  private rebuild(curve: CurveData, sel: CurveEditState): void {
    const key = `${JSON.stringify(curve)}:${sel.version}`;
    if (key === this.cacheKey) return;
    this.cacheKey = key;
    this.ctrlVa?.dispose();
    this.handleDotVa?.dispose();
    this.handleLineVa?.dispose();

    const ctrlPos: number[] = [];
    const ctrlCol: number[] = [];
    const hDotPos: number[] = [];
    const hDotCol: number[] = [];
    const hLinePos: number[] = [];
    const hLineCol: number[] = [];

    curve.points.forEach((p, i) => {
      ctrlPos.push(p.co[0], p.co[1], p.co[2]);
      const c = sel.points.has(i) ? SEL : CTRL;
      ctrlCol.push(c[0], c[1], c[2]);

      if (curve.kind === 'bezier') {
        const hl = leftHandle(p);
        const hr = rightHandle(p);
        // Handle lines: hl → co → hr.
        hLinePos.push(hl.x, hl.y, hl.z, p.co[0], p.co[1], p.co[2]);
        hLinePos.push(p.co[0], p.co[1], p.co[2], hr.x, hr.y, hr.z);
        for (let k = 0; k < 4; k++) hLineCol.push(LINE[0], LINE[1], LINE[2]);
        // Handle dots.
        const cl = sel.handles.has(handleKey(i, 'hl')) ? SEL : HANDLE;
        const cr = sel.handles.has(handleKey(i, 'hr')) ? SEL : HANDLE;
        hDotPos.push(hl.x, hl.y, hl.z); hDotCol.push(cl[0], cl[1], cl[2]);
        hDotPos.push(hr.x, hr.y, hr.z); hDotCol.push(cr[0], cr[1], cr[2]);
      }
    });

    this.ctrlVa = new VertexArray(this.gl, [
      { location: 0, size: 3, data: new Float32Array(ctrlPos) },
      { location: 1, size: 3, data: new Float32Array(ctrlCol) },
    ]);
    this.handleLineVa = hLinePos.length > 0 ? new VertexArray(this.gl, [
      { location: 0, size: 3, data: new Float32Array(hLinePos) },
      { location: 1, size: 3, data: new Float32Array(hLineCol) },
    ]) : null;
    this.handleDotVa = hDotPos.length > 0 ? new VertexArray(this.gl, [
      { location: 0, size: 3, data: new Float32Array(hDotPos) },
      { location: 1, size: 3, data: new Float32Array(hDotCol) },
    ]) : null;
  }

  render(modelView: Mat4, proj: Mat4, curve: CurveData, sel: CurveEditState): void {
    const gl = this.gl;
    this.rebuild(curve, sel);
    this.shader.use();
    this.shader.setMat4('u_modelView', modelView);
    this.shader.setMat4('u_proj', proj);

    // Handle lines first (under the dots).
    if (this.handleLineVa) {
      this.shader.setFloat('u_pointSize', 1.0);
      this.handleLineVa.draw(gl.LINES);
    }
    // Handle dots (smaller).
    if (this.handleDotVa) {
      this.shader.setFloat('u_pointSize', 5.0);
      this.handleDotVa.draw(gl.POINTS);
    }
    // Control points (larger, on top).
    if (this.ctrlVa) {
      this.shader.setFloat('u_pointSize', 8.0);
      this.ctrlVa.draw(gl.POINTS);
    }
  }
}
