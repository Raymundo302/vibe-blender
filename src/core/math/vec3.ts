/** Immutable-style 3D vector. Methods return new Vec3; nothing mutates. */
export class Vec3 {
  constructor(
    public readonly x = 0,
    public readonly y = 0,
    public readonly z = 0,
  ) {}

  static readonly ZERO = new Vec3(0, 0, 0);
  static readonly ONE = new Vec3(1, 1, 1);
  static readonly X = new Vec3(1, 0, 0);
  static readonly Y = new Vec3(0, 1, 0);
  static readonly Z = new Vec3(0, 0, 1);

  add(v: Vec3): Vec3 { return new Vec3(this.x + v.x, this.y + v.y, this.z + v.z); }
  sub(v: Vec3): Vec3 { return new Vec3(this.x - v.x, this.y - v.y, this.z - v.z); }
  mul(v: Vec3): Vec3 { return new Vec3(this.x * v.x, this.y * v.y, this.z * v.z); }
  scale(s: number): Vec3 { return new Vec3(this.x * s, this.y * s, this.z * s); }
  negate(): Vec3 { return new Vec3(-this.x, -this.y, -this.z); }

  dot(v: Vec3): number { return this.x * v.x + this.y * v.y + this.z * v.z; }

  cross(v: Vec3): Vec3 {
    return new Vec3(
      this.y * v.z - this.z * v.y,
      this.z * v.x - this.x * v.z,
      this.x * v.y - this.y * v.x,
    );
  }

  length(): number { return Math.sqrt(this.dot(this)); }
  lengthSq(): number { return this.dot(this); }
  distanceTo(v: Vec3): number { return this.sub(v).length(); }

  normalize(): Vec3 {
    const len = this.length();
    return len > 1e-12 ? this.scale(1 / len) : Vec3.ZERO;
  }

  lerp(v: Vec3, t: number): Vec3 {
    return new Vec3(
      this.x + (v.x - this.x) * t,
      this.y + (v.y - this.y) * t,
      this.z + (v.z - this.z) * t,
    );
  }

  equalsApprox(v: Vec3, eps = 1e-6): boolean {
    return Math.abs(this.x - v.x) < eps && Math.abs(this.y - v.y) < eps && Math.abs(this.z - v.z) < eps;
  }

  toArray(): [number, number, number] { return [this.x, this.y, this.z]; }
  static fromArray(a: ArrayLike<number>, offset = 0): Vec3 {
    return new Vec3(a[offset], a[offset + 1], a[offset + 2]);
  }
}
