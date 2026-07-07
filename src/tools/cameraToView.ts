import { Vec3 } from '../core/math/vec3';
import { Quat } from '../core/math/quat';
import { Transform } from '../core/math/transform';

/**
 * Camera-to-view helper (Ctrl+Alt+Numpad0): build a camera Transform whose pose
 * reproduces a viewpoint given by eye / forward / up. Cameras look down local
 * -Z (objectForward convention), so the camera's world basis is:
 *   z = -forward   (camera +Z points backward, toward the viewer)
 *   x = up × z     (right)
 *   y = z × x      (re-orthogonalized up)
 * matching Mat4.lookAt, so cameraViewMatrix(obj) round-trips to the same view.
 *
 * Pure + unit-tested (no SceneObject/Scene dependency) so the math is verifiable
 * in isolation; the InputManager applies the result via a transform command.
 */
export function cameraTransformFromView(eye: Vec3, forward: Vec3, up: Vec3): Transform {
  const z = forward.scale(-1).normalize(); // camera looks down -Z
  const x = up.cross(z).normalize();
  const y = z.cross(x); // already unit-length (x, z orthonormal)
  return new Transform(eye, quatFromBasis(x, y, z));
}

/**
 * Quaternion from an orthonormal basis whose vectors are the COLUMNS of the
 * rotation matrix (world axes of local X/Y/Z). Standard trace method, picking
 * the largest diagonal term for numerical stability.
 */
export function quatFromBasis(x: Vec3, y: Vec3, z: Vec3): Quat {
  // Column-vector basis → row-major rotation entries m[row][col].
  const m00 = x.x, m01 = y.x, m02 = z.x;
  const m10 = x.y, m11 = y.y, m12 = z.y;
  const m20 = x.z, m21 = y.z, m22 = z.z;
  const trace = m00 + m11 + m22;

  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    return new Quat((m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s).normalize();
  }
  if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    return new Quat(0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s).normalize();
  }
  if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    return new Quat((m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s).normalize();
  }
  const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
  return new Quat((m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s).normalize();
}
