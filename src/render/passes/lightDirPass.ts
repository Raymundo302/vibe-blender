import { Shader } from '../gl/Shader';
import { VertexArray } from '../gl/VertexArray';
import { Mat4 } from '../../core/math/mat4';
import { Vec3 } from '../../core/math/vec3';
import type { SceneObject } from '../../core/scene/Scene';
import type { Transform } from '../../core/math/transform';

/**
 * Direction indicator for aimed lights (sun / spot): a line from the light's
 * origin along its aim direction (local -Z, same as objectForward) ending in a
 * 4-barb arrowhead. Drawn with the light's selection tint next to its billboard
 * icon, so you can see where the light points without entering a render mode.
 * Scale-free like the camera frustum — squashing a light must not skew it.
 */

const LEN = 1.6;     // arrow length in world units (local -Z)
const BARB = 0.14;   // arrowhead half-width
const BARB_BACK = 0.35; // how far the barbs sweep back from the tip

/** LINE-list vertices in the light's local space. */
export function lightDirLineData(): Float32Array {
  const tip = [0, 0, -LEN];
  const seg = (a: number[], b: number[]): number[] => [...a, ...b];
  return new Float32Array([
    ...seg([0, 0, 0], tip),
    ...seg(tip, [BARB, 0, -LEN + BARB_BACK]),
    ...seg(tip, [-BARB, 0, -LEN + BARB_BACK]),
    ...seg(tip, [0, BARB, -LEN + BARB_BACK]),
    ...seg(tip, [0, -BARB, -LEN + BARB_BACK]),
  ]);
}

/** Unit-rectangle outline (LINE list) in the light's local XY plane, corners at
 *  ±0.5. Scaled to width×height by the model matrix in drawRect (UR10-1). */
export function areaRectLineData(): Float32Array {
  const c = [
    [-0.5, -0.5, 0], [0.5, -0.5, 0], [0.5, 0.5, 0], [-0.5, 0.5, 0],
  ];
  const seg = (a: number[], b: number[]): number[] => [...a, ...b];
  return new Float32Array([
    ...seg(c[0], c[1]), ...seg(c[1], c[2]), ...seg(c[2], c[3]), ...seg(c[3], c[0]),
  ]);
}

const VERT = /* glsl */ `#version 300 es
layout(location = 0) in vec3 a_position;
uniform mat4 u_mvp;
void main() { gl_Position = u_mvp * vec4(a_position, 1.0); }`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 outColor;
void main() { outColor = u_color; }`;

export class LightDirPass {
  private readonly shader: Shader;
  private readonly lines: VertexArray;
  private readonly rect: VertexArray;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.shader = new Shader(gl, VERT, FRAG, 'light-dir');
    this.lines = new VertexArray(gl, [
      { location: 0, size: 3, data: lightDirLineData() },
    ]);
    this.rect = new VertexArray(gl, [
      { location: 0, size: 3, data: areaRectLineData() },
    ]);
  }

  /** Bind the shader once, then draw() per light. */
  begin(): void {
    this.shader.use();
  }

  /** Draw one light's aim arrow. `pose` is the light's WORLD transform. The arrow
   *  is scale-free (rotation only) so squashing a light never skews it. */
  draw(viewProj: Mat4, pose: Transform, color: readonly [number, number, number]): void {
    const model = Mat4.translation(pose.position).mul(Mat4.fromQuat(pose.rotation));
    this.shader.setMat4('u_mvp', viewProj.mul(model));
    this.shader.setVec4('u_color', color[0], color[1], color[2], 1);
    this.lines.draw(this.gl.LINES);
  }

  /** Draw one area light's rectangle outline (UR10-1): the unit rect scaled to
   *  width×height in the light's local XY plane. `pose` is the WORLD transform. */
  drawRect(
    viewProj: Mat4, pose: Transform, width: number, height: number,
    color: readonly [number, number, number],
  ): void {
    const model = Mat4.translation(pose.position)
      .mul(Mat4.fromQuat(pose.rotation))
      .mul(Mat4.scaling(new Vec3(width, height, 1)));
    this.shader.setMat4('u_mvp', viewProj.mul(model));
    this.shader.setVec4('u_color', color[0], color[1], color[2], 1);
    this.rect.draw(this.gl.LINES);
  }
}

/** Which lights get an aim arrow: direction means something for sun/spot/area. */
export function hasAimArrow(obj: SceneObject): boolean {
  return obj.kind === 'light'
    && (obj.light?.type === 'sun' || obj.light?.type === 'spot' || obj.light?.type === 'area');
}
