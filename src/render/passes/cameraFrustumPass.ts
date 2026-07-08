import { Shader } from '../gl/Shader';
import { VertexArray } from '../gl/VertexArray';
import { Mat4 } from '../../core/math/mat4';
import { cameraFovY, type CameraData } from '../../core/scene/objectData';
import type { SceneObject } from '../../core/scene/Scene';
import type { Transform } from '../../core/math/transform';

/**
 * Camera-object viewport display (P8-2): the wireframe frustum drawn for every
 * camera, plus the PURE view/projection helpers used both to draw the frustum
 * and to look THROUGH a camera (Numpad0). Kept free of DOM so the helpers are
 * unit-testable without a GL context.
 *
 * A camera's SCALE is deliberately ignored everywhere here — squashing a camera
 * must not skew its view or its frustum (Blender treats camera scale as display
 * only). So the model matrix is translation × rotation, never × scale.
 */

/** Camera's translation×rotation as a matrix (scale ignored). Pass the WORLD
 *  pose (scene.worldTransformOf) for parented cameras; defaults to the local
 *  transform, which is identical for roots. */
export function cameraModelMatrix(obj: SceneObject, pose: Transform = obj.transform): Mat4 {
  return Mat4.translation(pose.position).mul(Mat4.fromQuat(pose.rotation));
}

/** World→camera view matrix: inverse of the camera's posed (scale-free) transform. */
export function cameraViewMatrix(obj: SceneObject, pose: Transform = obj.transform): Mat4 {
  return cameraModelMatrix(obj, pose).invert();
}

/** Projection matrix for a camera's data at a given viewport aspect. */
export function cameraProjMatrix(data: CameraData, aspect: number): Mat4 {
  return Mat4.perspective(cameraFovY(data), aspect, data.near, data.far);
}

// The drawn frustum's virtual image plane: a fixed distance along local -Z at a
// 16:9 aspect. near/far don't change the DRAWN shape (only focalLength does), so
// the geometry caches on focalLength alone.
const PLANE_DIST = 1.5;
const PLANE_ASPECT = 16 / 9;

/**
 * LINE-list vertices (local camera space) for one camera's frustum wireframe:
 * pyramid edges (origin → 4 image-plane corners), the image-plane rectangle, and
 * the "up" triangle marker above the top edge (Blender's which-way-is-up glyph).
 */
export function frustumLineData(focalLength: number): Float32Array {
  const fovY = cameraFovY({ focalLength, near: 0, far: 0 });
  const h = PLANE_DIST * Math.tan(fovY / 2);
  const w = h * PLANE_ASPECT;
  const z = -PLANE_DIST;
  const O = [0, 0, 0];
  const TL = [-w, h, z], TR = [w, h, z], BR = [w, -h, z], BL = [-w, -h, z];
  const apex = [0, h * 1.5, z];
  const seg = (a: number[], b: number[]): number[] => [...a, ...b];
  return new Float32Array([
    ...seg(O, TL), ...seg(O, TR), ...seg(O, BR), ...seg(O, BL), // pyramid edges
    ...seg(TL, TR), ...seg(TR, BR), ...seg(BR, BL), ...seg(BL, TL), // image plane
    ...seg(TL, apex), ...seg(TR, apex), // up-triangle (top edge is TL→TR above)
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

export class CameraFrustumPass {
  private readonly shader: Shader;
  /** One line VAO per focalLength — the model matrix positions it, so only a
   *  focalLength change rebuilds. */
  private readonly cache = new Map<number, VertexArray>();

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.shader = new Shader(gl, VERT, FRAG, 'camera-frustum');
  }

  /** Bind the shader once, then draw() per camera. */
  begin(): void {
    this.shader.use();
  }

  /** Draw one camera's frustum. `viewProj` is the SCENE view/proj; the camera's
   *  own scale-free model matrix places the wireframe. Call begin() first. */
  draw(viewProj: Mat4, obj: SceneObject, color: readonly [number, number, number], pose: Transform = obj.transform): void {
    if (!obj.camera) return;
    const mvp = viewProj.mul(cameraModelMatrix(obj, pose));
    this.shader.setMat4('u_mvp', mvp);
    this.shader.setVec4('u_color', color[0], color[1], color[2], 1);
    this.vao(obj.camera.focalLength).draw(this.gl.LINES);
  }

  private vao(focalLength: number): VertexArray {
    let vao = this.cache.get(focalLength);
    if (!vao) {
      vao = new VertexArray(this.gl, [
        { location: 0, size: 3, data: frustumLineData(focalLength) },
      ]);
      this.cache.set(focalLength, vao);
    }
    return vao;
  }
}
