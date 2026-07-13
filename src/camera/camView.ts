import { Mat4 } from '../core/math/mat4';

/**
 * Camera-view zoom/pan (Blender's view_camera_zoom / view_camera_offset) — a
 * pure VIEWPORT transform applied while looking through a camera (not view-lock).
 * It scales and translates the rendered frame + passepartout inside the viewport
 * WITHOUT changing what the camera renders (F12 output is unaffected). Kept in
 * one place so the renderer's projection, the OrbitCamera's pointer rays, and
 * the passepartout DOM all use the SAME transform and stay pixel-consistent.
 */
export interface CamView {
  /** Frame scale about the viewport center (1 = fit). */
  zoom: number;
  /** Horizontal frame offset in NDC (−1..1 spans the half-width). */
  panX: number;
  /** Vertical frame offset in NDC (+ = up). */
  panY: number;
}

/** A fresh identity camera-view (no zoom, centered). */
export function identityCamView(): CamView {
  return { zoom: 1, panX: 0, panY: 0 };
}

/** True when the camera-view has no effect (skip the matrix multiply). */
export function isIdentityCamView(cv: CamView): boolean {
  return cv.zoom === 1 && cv.panX === 0 && cv.panY === 0;
}

/**
 * Post-multiply a projection by the camera-view transform: `S · proj`, where S
 * scales clip.xy by `zoom` and shifts NDC by (panX, panY). After the perspective
 * divide this is exactly `ndc' = zoom·ndc + pan`, i.e. a centered zoom plus an
 * NDC pan — identical whether applied to the renderer's frame projection or the
 * OrbitCamera's, so on-screen pixels and pointer rays agree.
 */
export function applyCamView(proj: Mat4, cv: CamView): Mat4 {
  if (isIdentityCamView(cv)) return proj;
  // Column-major S: cols (zoom,0,0,0)(0,zoom,0,0)(0,0,1,0)(panX,panY,0,1).
  const s = new Mat4(new Float32Array([
    cv.zoom, 0, 0, 0,
    0, cv.zoom, 0, 0,
    0, 0, 1, 0,
    cv.panX, cv.panY, 0, 1,
  ]));
  return s.mul(proj);
}

/** Clamp a zoom into a sane on-screen range. */
export function clampCamZoom(z: number): number {
  return Math.max(0.2, Math.min(8, z));
}
