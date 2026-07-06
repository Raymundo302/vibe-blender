import { Shader } from '../gl/Shader';
import { VertexArray } from '../gl/VertexArray';
import { editOverlayData } from '../../core/mesh/editOverlayData';
import type { EditableMesh } from '../../core/mesh/EditableMesh';
import type { EditModeState } from '../../core/scene/EditMode';
import type { Mat4 } from '../../core/math/mat4';

const WIRE_VERT = /* glsl */ `#version 300 es
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_color;
uniform mat4 u_mvp;
uniform float u_depthBias; // pull toward the camera so the cage wins z-fighting
uniform float u_pointSize;
out vec3 v_color;
void main() {
  v_color = a_color;
  gl_Position = u_mvp * vec4(a_position, 1.0);
  gl_Position.z -= u_depthBias * gl_Position.w;
  gl_PointSize = u_pointSize;
}`;

const WIRE_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec3 v_color;
out vec4 outColor;
void main() { outColor = vec4(v_color, 1.0); }`;

const FILL_VERT = /* glsl */ `#version 300 es
layout(location = 0) in vec3 a_position;
uniform mat4 u_mvp;
void main() {
  gl_Position = u_mvp * vec4(a_position, 1.0);
  gl_Position.z -= 0.0005 * gl_Position.w;
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
  }

  /**
   * Draw an ad-hoc yellow polyline over the cage (loop-cut preview). The
   * VertexArray is cached per Float32Array identity — callers pass a new array
   * only when the preview actually changes.
   */
  renderPreview(mvp: Mat4, segments: Float32Array): void {
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
    this.wireShader.setMat4('u_mvp', mvp);
    this.wireShader.setFloat('u_depthBias', 0.002);
    this.wireShader.setFloat('u_pointSize', 1.0);
    this.previewVa!.draw(gl.LINES);
  }
  private previewVa: VertexArray | null = null;
  private previewSource: Float32Array | null = null;

  render(mvp: Mat4, mesh: EditableMesh, sel: EditModeState): void {
    const gl = this.gl;
    this.rebuild(mesh, sel);

    // Selected-face fill (blended, under the wires)
    if (this.fillVa) {
      this.fillShader.use();
      this.fillShader.setMat4('u_mvp', mvp);
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
    this.wireShader.setMat4('u_mvp', mvp);

    this.wireShader.setFloat('u_depthBias', 0.001);
    this.wireShader.setFloat('u_pointSize', 1.0);
    this.edgeVa!.draw(gl.LINES);

    // Vert dots only in vert mode, like Blender
    if (sel.elementMode === 'vert') {
      this.wireShader.setFloat('u_depthBias', 0.0015);
      this.wireShader.setFloat('u_pointSize', 6.0);
      this.vertVa!.draw(gl.POINTS);
    }
  }
}
