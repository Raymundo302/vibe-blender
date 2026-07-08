import { Vec3 } from './vec3';
import { Quat } from './quat';
import { Mat4 } from './mat4';

/** Position / rotation / scale. Immutable — `with*` methods return copies. */
export class Transform {
  constructor(
    public readonly position = Vec3.ZERO,
    public readonly rotation = Quat.identity(),
    public readonly scale = Vec3.ONE,
  ) {}

  withPosition(p: Vec3): Transform { return new Transform(p, this.rotation, this.scale); }
  withRotation(r: Quat): Transform { return new Transform(this.position, r, this.scale); }
  withScale(s: Vec3): Transform { return new Transform(this.position, this.rotation, s); }

  /** Model matrix: T * R * S. */
  matrix(): Mat4 {
    return Mat4.translation(this.position)
      .mul(Mat4.fromQuat(this.rotation))
      .mul(Mat4.scaling(this.scale));
  }

  /**
   * Decompose a TRS matrix back into position/rotation/scale (inverse of
   * matrix(), used by parenting to re-express a world transform in a parent's
   * space). Exact for matrices that ARE T*R*S products; shear (non-uniform
   * parent scale under rotation) is folded into scale as an approximation.
   * A negative determinant (mirrored basis) negates the X scale so the
   * remaining 3x3 is right-handed before the quaternion extraction.
   */
  static fromMat4(m: Mat4): Transform {
    const e = m.m; // column-major
    const position = new Vec3(e[12], e[13], e[14]);
    let sx = Math.hypot(e[0], e[1], e[2]);
    const sy = Math.hypot(e[4], e[5], e[6]);
    const sz = Math.hypot(e[8], e[9], e[10]);
    // det of the upper 3x3 — negative means one axis is mirrored.
    const det =
      e[0] * (e[5] * e[10] - e[6] * e[9]) -
      e[4] * (e[1] * e[10] - e[2] * e[9]) +
      e[8] * (e[1] * e[6] - e[2] * e[5]);
    if (det < 0) sx = -sx;
    const ix = sx < 1e-12 && sx > -1e-12 ? 0 : 1 / sx;
    const iy = sy < 1e-12 ? 0 : 1 / sy;
    const iz = sz < 1e-12 ? 0 : 1 / sz;
    // Row-major entries of the pure-rotation 3x3 (columns un-scaled).
    const rotation = Quat.fromRotationMatrix(
      e[0] * ix, e[4] * iy, e[8] * iz,
      e[1] * ix, e[5] * iy, e[9] * iz,
      e[2] * ix, e[6] * iy, e[10] * iz,
    );
    return new Transform(position, rotation, new Vec3(sx, sy, sz));
  }
}
