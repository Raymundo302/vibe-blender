import { Vec3 } from './vec3';

/** Immutable-style unit quaternion (x, y, z, w). */
export class Quat {
  constructor(
    public readonly x = 0,
    public readonly y = 0,
    public readonly z = 0,
    public readonly w = 1,
  ) {}

  static identity(): Quat { return new Quat(); }

  static fromAxisAngle(axis: Vec3, angleRad: number): Quat {
    const a = axis.normalize();
    const half = angleRad / 2;
    const s = Math.sin(half);
    return new Quat(a.x * s, a.y * s, a.z * s, Math.cos(half));
  }

  /**
   * Build a rotation from intrinsic XYZ Euler angles (radians) — Blender's
   * default rotation mode. Composed as Rx * Ry * Rz, matching toEulerXYZ so the
   * two round-trip. `mul` applies the right operand first, so this rotates about
   * Z, then Y, then X, which is the intrinsic XYZ convention.
   */
  static fromEulerXYZ(x: number, y: number, z: number): Quat {
    return Quat.fromAxisAngle(Vec3.X, x)
      .mul(Quat.fromAxisAngle(Vec3.Y, y))
      .mul(Quat.fromAxisAngle(Vec3.Z, z));
  }

  /**
   * Decompose into intrinsic XYZ Euler angles (radians), inverse of
   * fromEulerXYZ. At the gimbal singularity (pitch ≈ ±90°, where the X and Z
   * axes align) X is pinned to 0 and its rotation is folded into Z so the result
   * still reconstructs the same orientation.
   */
  toEulerXYZ(): { x: number; y: number; z: number } {
    const { x, y, z, w } = this;
    // Rotation-matrix entries we need (row-major, R * v), from the unit quat.
    const r00 = 1 - 2 * (y * y + z * z);
    const r01 = 2 * (x * y - w * z);
    const r02 = 2 * (x * z + w * y); // == sin(pitch)
    const r10 = 2 * (x * y + w * z);
    const r11 = 1 - 2 * (x * x + z * z);
    const r12 = 2 * (y * z - w * x);
    const r22 = 1 - 2 * (x * x + y * y);

    const sy = Math.max(-1, Math.min(1, r02));
    if (Math.abs(sy) < 0.9999999) {
      return {
        x: Math.atan2(-r12, r22),
        y: Math.asin(sy),
        z: Math.atan2(-r01, r00),
      };
    }
    // Gimbal lock: cos(pitch) ≈ 0. Pin X to 0; recover the combined Z rotation.
    return {
      x: 0,
      y: sy > 0 ? Math.PI / 2 : -Math.PI / 2,
      z: Math.atan2(r10, r11),
    };
  }

  /** Returns this * other (applies `other`'s rotation first, then this). */
  mul(o: Quat): Quat {
    return new Quat(
      this.w * o.x + this.x * o.w + this.y * o.z - this.z * o.y,
      this.w * o.y + this.y * o.w + this.z * o.x - this.x * o.z,
      this.w * o.z + this.z * o.w + this.x * o.y - this.y * o.x,
      this.w * o.w - this.x * o.x - this.y * o.y - this.z * o.z,
    );
  }

  normalize(): Quat {
    const len = Math.sqrt(this.x ** 2 + this.y ** 2 + this.z ** 2 + this.w ** 2);
    if (len < 1e-12) return Quat.identity();
    return new Quat(this.x / len, this.y / len, this.z / len, this.w / len);
  }

  conjugate(): Quat { return new Quat(-this.x, -this.y, -this.z, this.w); }

  rotate(v: Vec3): Vec3 {
    // v' = q * v * q^-1, expanded to avoid constructing quats
    const { x, y, z, w } = this;
    const tx = 2 * (y * v.z - z * v.y);
    const ty = 2 * (z * v.x - x * v.z);
    const tz = 2 * (x * v.y - y * v.x);
    return new Vec3(
      v.x + w * tx + y * tz - z * ty,
      v.y + w * ty + z * tx - x * tz,
      v.z + w * tz + x * ty - y * tx,
    );
  }
}
