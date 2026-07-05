import { Vec3 } from './vec3';
import type { Mat4 } from './mat4';

export interface Ray {
  origin: Vec3;
  dir: Vec3; // normalized
}

/**
 * Ray from a screen position through the scene.
 * ndcX/ndcY in [-1, 1], invViewProj = inverse(proj * view).
 */
export function rayFromNdc(ndcX: number, ndcY: number, invViewProj: Mat4): Ray {
  const near = invViewProj.transformPoint(new Vec3(ndcX, ndcY, -1));
  const far = invViewProj.transformPoint(new Vec3(ndcX, ndcY, 1));
  return { origin: near, dir: far.sub(near).normalize() };
}

/**
 * Intersect ray with the plane through `point` with normal `normal`.
 * Returns the hit point, or null if the ray is parallel to the plane.
 */
export function rayPlane(ray: Ray, point: Vec3, normal: Vec3): Vec3 | null {
  const denom = ray.dir.dot(normal);
  if (Math.abs(denom) < 1e-9) return null;
  const t = point.sub(ray.origin).dot(normal) / denom;
  return ray.origin.add(ray.dir.scale(t));
}
