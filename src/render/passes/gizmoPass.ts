import { Shader } from '../gl/Shader';
import { VertexArray } from '../gl/VertexArray';
import { Mat4 } from '../../core/math/mat4';
import { Vec3 } from '../../core/math/vec3';
import type { PickingPass } from './pickingPass';

/**
 * Translate gizmo (architecture: color-ID picking A3) — three world-axis move
 * arrows drawn at the active object, at a constant screen size. Handles are
 * pickable by rendering them into the shared id buffer with reserved ids far
 * above any object id, so a hit never collides with a real object.
 */

/** Gizmo pick ids live far above object ids: X = base, Y = base+1, Z = base+2. */
export const GIZMO_PICK_BASE = 0xf00000;

export type GizmoAxis = 'x' | 'y' | 'z';
export const GIZMO_AXES: readonly GizmoAxis[] = ['x', 'y', 'z'];

// Blender-ish axis colors (X red, Y green, Z blue).
const AXIS_COLOR: Record<GizmoAxis, readonly [number, number, number]> = {
  x: [0.89, 0.35, 0.35],
  y: [0.45, 0.78, 0.31],
  z: [0.33, 0.5, 0.9],
};

// Local geometry is built along +X (unit length ≈ 1) and rotated onto each axis.
const SHAFT = 0.85; // shaft line runs 0 → SHAFT
const TIP = 1.1; //    cone tip apex
const CONE_R = 0.055; // cone base radius
const PICK_R = 0.09; //  half-width of the fat pick box (~6px worth at K=0.18)
const PICK_LEN = 1.15; // pick box overshoots the tip so it stays grabbable

/**
 * Rotation that maps local +X onto the given world axis (column-major).
 * Kept as constants so the whole gizmo is a single rotate+scale+translate.
 */
const AXIS_ROT: Record<GizmoAxis, Mat4> = {
  x: Mat4.identity(),
  // +X → +Y : rotate +90° about Z
  y: new Mat4([0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  // +X → +Z : rotate -90° about Y
  z: new Mat4([0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 0, 1]),
};

/**
 * Constant-screen-size factor: world-length of one gizmo unit at `origin`.
 * `distance * tan(fovY/2) * K` keeps the arrows a fixed pixel size regardless
 * of zoom. Exported (pure) so it can be unit-tested without a GL context.
 */
export function gizmoScreenScale(eye: Vec3, origin: Vec3, fovY: number, k = 0.18): number {
  return eye.distanceTo(origin) * Math.tan(fovY / 2) * k;
}

/** Model matrix placing a unit +X arrow onto `axis` at `origin`, scaled by `scale`. */
export function gizmoModelMatrix(origin: Vec3, scale: number, axis: GizmoAxis, orient: Mat4 = Mat4.identity()): Mat4 {
  return Mat4.translation(origin)
    .mul(orient) // transform-orientation basis (identity = Global/world axes)
    .mul(Mat4.scaling(new Vec3(scale, scale, scale)))
    .mul(AXIS_ROT[axis]);
}

/**
 * Clamp a world-space segment A→B so both endpoints stay a margin `near` in
 * front of the eye plane (dot(P − eye, forward) ≥ near). Returns the trimmed
 * segment, or null if the whole segment is behind the eye. Rasterizers
 * (SwiftShader) DROP LINES with an endpoint behind the eye instead of clipping,
 * so guide lines must be clamped on the CPU — same lesson as the axis guide.
 */
export function clampSegmentNear(
  a: Vec3, b: Vec3, eye: Vec3, forward: Vec3, near: number,
): { a: Vec3; b: Vec3 } | null {
  const da = a.sub(eye).dot(forward);
  const db = b.sub(eye).dot(forward);
  const delta = db - da;
  let t0 = 0;
  let t1 = 1;
  if (Math.abs(delta) < 1e-9) {
    if (da < near) return null; // whole segment behind the eye plane
  } else {
    const tCut = (near - da) / delta;
    if (delta > 0) t0 = Math.max(t0, tCut);
    else t1 = Math.min(t1, tCut);
  }
  if (t1 <= t0) return null;
  const dir = b.sub(a);
  return { a: a.add(dir.scale(t0)), b: a.add(dir.scale(t1)) };
}

function coneTris(x0: number, x1: number, r: number, segs: number): Float32Array {
  const out: number[] = [];
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const b0 = [x0, r * Math.cos(a0), r * Math.sin(a0)];
    const b1 = [x0, r * Math.cos(a1), r * Math.sin(a1)];
    out.push(x1, 0, 0, ...b0, ...b1); // side
    out.push(x0, 0, 0, ...b1, ...b0); // base cap
  }
  return new Float32Array(out);
}

function boxTris(x0: number, x1: number, r: number): Float32Array {
  const A = [x0, -r, -r], B = [x1, -r, -r], C = [x1, r, -r], D = [x0, r, -r];
  const E = [x0, -r, r], F = [x1, -r, r], G = [x1, r, r], H = [x0, r, r];
  const quad = (a: number[], b: number[], c: number[], d: number[]): number[] =>
    [...a, ...b, ...c, ...a, ...c, ...d];
  return new Float32Array([
    ...quad(A, B, C, D),
    ...quad(E, H, G, F),
    ...quad(A, D, H, E),
    ...quad(B, F, G, C),
    ...quad(A, E, F, B),
    ...quad(D, C, G, H),
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

export class GizmoPass {
  private readonly shader: Shader;
  private readonly shaft: VertexArray; // 2-vertex line
  private readonly cone: VertexArray; //  triangles
  private readonly pickBox: VertexArray; // fat triangles for picking
  /** Two-way guide line for the modal axis-lock indicator, re-uploaded per
   *  draw: renderAxis clamps its extent against the camera near plane on the
   *  CPU, because rasterizers (SwiftShader at least) drop LINES with an
   *  endpoint behind the eye instead of clipping them. */
  private readonly guide: VertexArray;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.shader = new Shader(gl, VERT, FRAG, 'gizmo');
    this.shaft = new VertexArray(gl, [{ location: 0, size: 3, data: new Float32Array([0, 0, 0, SHAFT, 0, 0]) }]);
    this.cone = new VertexArray(gl, [{ location: 0, size: 3, data: coneTris(SHAFT, TIP, CONE_R, 12) }]);
    this.pickBox = new VertexArray(gl, [{ location: 0, size: 3, data: boxTris(0, PICK_LEN, PICK_R) }]);
    this.guide = new VertexArray(gl, [{ location: 0, size: 3, data: new Float32Array(6) }]);
  }

  /**
   * Draw the visible arrows. Caller must have cleared the depth buffer first so
   * the gizmo wins over everything. Uniform-color flat shading, no cull (the
   * cone/line are thin and viewed from all sides).
   */
  render(viewProj: Mat4, origin: Vec3, scale: number, orient: Mat4 = Mat4.identity()): void {
    const gl = this.gl;
    this.shader.use();
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    for (const axis of GIZMO_AXES) {
      const mvp = viewProj.mul(gizmoModelMatrix(origin, scale, axis, orient));
      const [r, g, b] = AXIS_COLOR[axis];
      this.shader.setMat4('u_mvp', mvp);
      this.shader.setVec4('u_color', r, g, b, 1);
      this.shaft.draw(gl.LINES);
      this.cone.draw(gl.TRIANGLES);
    }
    gl.enable(gl.CULL_FACE);
  }

  /**
   * Modal axis-lock indicator: ONE axis's arrow plus a long guide line through
   * the pivot (Blender's constraint line), in the axis color. Drawn while a
   * G/R/S runs with X/Y/Z locked, where the full gizmo is hidden. Caller
   * clears the depth buffer first, same as render(). `eye`/`forward` are the
   * viewpoint, used to clamp the guide in front of the camera (see `guide`).
   */
  renderAxis(
    viewProj: Mat4, origin: Vec3, scale: number, axis: GizmoAxis,
    eye: Vec3, forward: Vec3,
  ): void {
    const gl = this.gl;
    this.shader.use();
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    const mvp = viewProj.mul(gizmoModelMatrix(origin, scale, axis));
    const [r, g, b] = AXIS_COLOR[axis];
    this.shader.setMat4('u_mvp', mvp);
    this.shader.setVec4('u_color', r, g, b, 1);

    // Guide extent in gizmo-local t along +X (world P(t) = origin + dir·scale·t):
    // ±T reaches ~7× the eye distance (scale is 0.18·dist·tan(fov/2)), always
    // off-screen sideways; then clamp t so every point stays a margin in front
    // of the eye plane — dot(P(t) − eye, forward) ≥ NEAR.
    const T = 100;
    const NEAR = 0.3;
    const dir = axis === 'x' ? new Vec3(1, 0, 0) : axis === 'y' ? new Vec3(0, 1, 0) : new Vec3(0, 0, 1);
    const a = origin.sub(eye).dot(forward);
    const b2 = dir.dot(forward) * scale;
    let t0 = -T;
    let t1 = T;
    if (Math.abs(b2) < 1e-9) {
      if (a < NEAR) t0 = t1 = 0; // whole line behind the camera: skip
    } else {
      const tCut = (NEAR - a) / b2;
      if (b2 > 0) t0 = Math.max(t0, tCut);
      else t1 = Math.min(t1, tCut);
    }
    if (t1 > t0) {
      this.guide.update(0, new Float32Array([t0, 0, 0, t1, 0, 0]));
      this.guide.draw(gl.LINES);
    }
    this.shaft.draw(gl.LINES);
    this.cone.draw(gl.TRIANGLES);
    gl.enable(gl.CULL_FACE);
  }

  /**
   * Draw a set of WORLD-space guide lines (edge-slide tangent rails, etc.) in a
   * light neutral grey — same pass/style as the axis guide, but a color distinct
   * from the X/Y/Z axis colors. Each segment is CPU-clamped against the near
   * plane (see {@link clampSegmentNear}). Caller clears the depth buffer first,
   * same as {@link render}. `eye`/`forward` are the current viewpoint.
   */
  renderGuides(
    viewProj: Mat4, segments: readonly { a: Vec3; b: Vec3 }[],
    eye: Vec3, forward: Vec3,
  ): void {
    if (segments.length === 0) return;
    const gl = this.gl;
    this.shader.use();
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    this.shader.setMat4('u_mvp', viewProj);
    this.shader.setVec4('u_color', 0.8, 0.8, 0.8, 1); // theme highlight grey
    const NEAR = 0.3;
    for (const seg of segments) {
      const c = clampSegmentNear(seg.a, seg.b, eye, forward, NEAR);
      if (!c) continue;
      this.guide.update(0, new Float32Array([c.a.x, c.a.y, c.a.z, c.b.x, c.b.y, c.b.z]));
      this.guide.draw(gl.LINES);
    }
    gl.enable(gl.CULL_FACE);
  }

  /**
   * Draw the fat pick boxes into the picking FBO (already bound & begun). Caller
   * clears the pick depth buffer first so handles win over objects behind them.
   */
  renderPick(picking: PickingPass, viewProj: Mat4, origin: Vec3, scale: number, orient: Mat4 = Mat4.identity()): void {
    const gl = this.gl;
    gl.disable(gl.CULL_FACE);
    for (let i = 0; i < GIZMO_AXES.length; i++) {
      const axis = GIZMO_AXES[i];
      picking.drawObject(viewProj.mul(gizmoModelMatrix(origin, scale, axis, orient)), GIZMO_PICK_BASE + i);
      this.pickBox.draw(gl.TRIANGLES);
    }
    gl.enable(gl.CULL_FACE);
  }
}
