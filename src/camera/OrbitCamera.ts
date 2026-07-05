import { Vec3 } from '../core/math/vec3';
import { Mat4 } from '../core/math/mat4';
import { rayFromNdc, type Ray } from '../core/math/ray';

/**
 * Blender-style turntable camera: yaw around world Y, pitch clamped short of
 * the poles, orbiting `target` at `distance`.
 */
export class OrbitCamera {
  target = Vec3.ZERO;
  distance = 8;
  /** Radians. yaw 0 looks down -Z; Blender home view is over-the-shoulder. */
  yaw = Math.PI / 4;
  pitch = Math.PI / 6;

  fovY = (50 * Math.PI) / 180;
  near = 0.1;
  far = 1000;

  private static readonly PITCH_LIMIT = Math.PI / 2 - 0.001;

  get eye(): Vec3 {
    const cp = Math.cos(this.pitch);
    return this.target.add(
      new Vec3(
        Math.sin(this.yaw) * cp,
        Math.sin(this.pitch),
        Math.cos(this.yaw) * cp,
      ).scale(this.distance),
    );
  }

  get forward(): Vec3 {
    return this.target.sub(this.eye).normalize();
  }

  viewMatrix(): Mat4 {
    return Mat4.lookAt(this.eye, this.target, Vec3.Y);
  }

  projMatrix(aspect: number): Mat4 {
    return Mat4.perspective(this.fovY, aspect, this.near, this.far);
  }

  orbit(dxPx: number, dyPx: number): void {
    this.yaw -= dxPx * 0.008;
    this.pitch += dyPx * 0.008;
    this.pitch = Math.max(-OrbitCamera.PITCH_LIMIT, Math.min(OrbitCamera.PITCH_LIMIT, this.pitch));
  }

  pan(dxPx: number, dyPx: number, viewportHeightPx: number): void {
    // Scale pixel motion to world units at the target's depth
    const worldPerPx = (2 * this.distance * Math.tan(this.fovY / 2)) / viewportHeightPx;
    const view = this.viewMatrix().invert();
    const right = view.transformDir(Vec3.X);
    const up = view.transformDir(Vec3.Y);
    this.target = this.target
      .add(right.scale(-dxPx * worldPerPx))
      .add(up.scale(dyPx * worldPerPx));
  }

  zoom(wheelDelta: number): void {
    this.distance *= Math.exp(wheelDelta * 0.001);
    this.distance = Math.max(0.05, Math.min(500, this.distance));
  }

  /** World-space ray under a pointer position (CSS px within the viewport). */
  pointerRay(px: number, py: number, viewportW: number, viewportH: number): Ray {
    const ndcX = (px / viewportW) * 2 - 1;
    const ndcY = 1 - (py / viewportH) * 2;
    const invViewProj = this.projMatrix(viewportW / viewportH).mul(this.viewMatrix()).invert();
    return rayFromNdc(ndcX, ndcY, invViewProj);
  }
}
