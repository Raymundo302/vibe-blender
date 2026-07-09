import { Shader } from '../gl/Shader';
import { VertexArray } from '../gl/VertexArray';
import { editOverlayData } from '../../core/mesh/editOverlayData';
import type { EditableMesh } from '../../core/mesh/EditableMesh';
import type { EditModeState } from '../../core/scene/EditMode';
import type { Mat4 } from '../../core/math/mat4';

const WIRE_VERT = /* glsl */ `#version 300 es
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_color;
uniform mat4 u_modelView;
uniform mat4 u_proj;
uniform float u_depthBias; // FRACTIONAL view-space pull toward the eye so the
                           // cage wins z-fighting with its own faces. Fraction
                           // of distance, not constant NDC — a constant shift
                           // out-shifts the compressed depth gap between whole
                           // OBJECTS at range, drawing the cage through
                           // geometry in front of it (see wirePass.ts).
uniform float u_pointSize;
out vec3 v_color;
void main() {
  v_color = a_color;
  vec4 viewPos = u_modelView * vec4(a_position, 1.0);
  viewPos.xyz *= (1.0 - u_depthBias);
  gl_Position = u_proj * viewPos;
  gl_Position.z -= 2e-5 * gl_Position.w;
  gl_PointSize = u_pointSize;
}`;

const WIRE_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec3 v_color;
out vec4 outColor;
void main() { outColor = vec4(v_color, 1.0); }`;

const FILL_VERT = /* glsl */ `#version 300 es
layout(location = 0) in vec3 a_position;
uniform mat4 u_modelView;
uniform mat4 u_proj;
void main() {
  vec4 viewPos = u_modelView * vec4(a_position, 1.0);
  viewPos.xyz *= (1.0 - 0.0005);   // fractional pull — see WIRE_VERT
  gl_Position = u_proj * viewPos;
  gl_Position.z -= 2e-5 * gl_Position.w;
}`;

const FILL_FRAG = /* glsl */ `#version 300 es
precision highp float;
out vec4 outColor;
void main() { outColor = vec4(0.996, 0.451, 0.062, 0.22); }`;

/**
 * Edit-mode cage: wire edges + vert points over the matcap mesh, and a
 * translucent orange fill on selected faces. Buffers are rebuilt only when
 * (mesh.version, selection.version) changes.
 */
export class EditOverlayPass {
  private readonly wireShader: Shader;
  private readonly fillShader: Shader;
  private cacheKey = '';
  private edgeVa: VertexArray | null = null;
  private vertVa: VertexArray | null = null;
  private fillVa: VertexArray | null = null;
  // UV seam edges, drawn Blender-red over the cage (P11-1). #d94a4a ≈ (0.851,
  // 0.290, 0.290). Rebuilt alongside the cage; null when the mesh has no seams.
  private seamVa: VertexArray | null = null;
  private seamCount = 0;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.wireShader = new Shader(gl, WIRE_VERT, WIRE_FRAG, 'edit-wire');
    this.fillShader = new Shader(gl, FILL_VERT, FILL_FRAG, 'edit-fill');
  }

  private rebuild(mesh: EditableMesh, sel: EditModeState): void {
    const key = `${mesh.version}:${sel.version}`;
    if (key === this.cacheKey) return;
    this.cacheKey = key;
    this.edgeVa?.dispose();
    this.vertVa?.dispose();
    this.fillVa?.dispose();
    this.seamVa?.dispose();

    const data = editOverlayData(mesh, sel);
    this.edgeVa = new VertexArray(this.gl, [
      { location: 0, size: 3, data: data.edgePositions },
      { location: 1, size: 3, data: data.edgeColors },
    ]);
    this.vertVa = new VertexArray(this.gl, [
      { location: 0, size: 3, data: data.vertPositions },
      { location: 1, size: 3, data: data.vertColors },
    ]);
    this.fillVa =
      data.selFaceVertexCount > 0
        ? new VertexArray(this.gl, [{ location: 0, size: 3, data: data.selFacePositions }])
        : null;

    // Seam overlay: one red line segment per seam edge whose verts still exist.
    const SEAM = [0.851, 0.290, 0.290] as const; // #d94a4a-ish (Blender seam red)
    const segs: number[] = [];
    for (const key2 of mesh.seams) {
      const [a, b] = key2.split(',').map(Number);
      const va = mesh.verts.get(a);
      const vb = mesh.verts.get(b);
      if (!va || !vb) continue;
      segs.push(va.co.x, va.co.y, va.co.z, vb.co.x, vb.co.y, vb.co.z);
    }
    this.seamCount = segs.length / 3;
    if (this.seamCount > 0) {
      const positions = new Float32Array(segs);
      const colors = new Float32Array(this.seamCount * 3);
      for (let i = 0; i < colors.length; i += 3) colors.set(SEAM, i);
      this.seamVa = new VertexArray(this.gl, [
        { location: 0, size: 3, data: positions },
        { location: 1, size: 3, data: colors },
      ]);
    } else {
      this.seamVa = null;
    }
  }

  /**
   * Draw an ad-hoc yellow polyline over the cage (loop-cut preview). The
   * VertexArray is cached per Float32Array identity — callers pass a new array
   * only when the preview actually changes.
   */
  renderPreview(modelView: Mat4, proj: Mat4, segments: Float32Array): void {
    if (segments.length === 0) return;
    const gl = this.gl;
    if (this.previewSource !== segments) {
      this.previewVa?.dispose();
      const colors = new Float32Array(segments.length);
      for (let i = 0; i < colors.length; i += 3) colors.set([1.0, 0.85, 0.1], i);
      this.previewVa = new VertexArray(gl, [
        { location: 0, size: 3, data: segments },
        { location: 1, size: 3, data: colors },
      ]);
      this.previewSource = segments;
    }
    this.wireShader.use();
    this.wireShader.setMat4('u_modelView', modelView);
    this.wireShader.setMat4('u_proj', proj);
    this.wireShader.setFloat('u_depthBias', 0.002);
    this.wireShader.setFloat('u_pointSize', 1.0);
    this.previewVa!.draw(gl.LINES);
  }
  private previewVa: VertexArray | null = null;
  private previewSource: Float32Array | null = null;

  render(modelView: Mat4, proj: Mat4, mesh: EditableMesh, sel: EditModeState): void {
    const gl = this.gl;
    this.rebuild(mesh, sel);

    // Selected-face fill (blended, under the wires)
    if (this.fillVa) {
      this.fillShader.use();
      this.fillShader.setMat4('u_modelView', modelView);
      this.fillShader.setMat4('u_proj', proj);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.disable(gl.CULL_FACE); // fill is visible from both sides
      this.fillVa.draw(gl.TRIANGLES);
      gl.enable(gl.CULL_FACE);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }

    this.wireShader.use();
    this.wireShader.setMat4('u_modelView', modelView);
    this.wireShader.setMat4('u_proj', proj);

    this.wireShader.setFloat('u_depthBias', 0.001);
    this.wireShader.setFloat('u_pointSize', 1.0);
    this.edgeVa!.draw(gl.LINES);

    // Seam edges drawn red on top of the cage (slightly larger bias so they win
    // over the default edges they overlap).
    if (this.seamVa) {
      this.wireShader.setFloat('u_depthBias', 0.0013);
      this.seamVa.draw(gl.LINES);
    }

    // Vert dots only in vert mode, like Blender
    if (sel.elementMode === 'vert') {
      this.wireShader.setFloat('u_depthBias', 0.0015);
      this.wireShader.setFloat('u_pointSize', 6.0);
      this.vertVa!.draw(gl.POINTS);
    }
  }
}
