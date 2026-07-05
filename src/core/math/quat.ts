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
