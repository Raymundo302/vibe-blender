import { Vec3 } from './vec3';
import type { Quat } from './quat';

/**
 * 4x4 matrix over a Float32Array, column-major (WebGL convention):
 * element (row r, col c) is at index c*4 + r.
 */
export class Mat4 {
  readonly m: Float32Array;

  constructor(values?: ArrayLike<number>) {
    this.m = new Float32Array(16);
    if (values) {
      this.m.set(values);
    } else {
      this.m[0] = this.m[5] = this.m[10] = this.m[15] = 1;
    }
  }

  static identity(): Mat4 { return new Mat4(); }

  static translation(v: Vec3): Mat4 {
    const out = new Mat4();
    out.m[12] = v.x; out.m[13] = v.y; out.m[14] = v.z;
    return out;
  }

  static scaling(v: Vec3): Mat4 {
    const out = new Mat4();
    out.m[0] = v.x; out.m[5] = v.y; out.m[10] = v.z;
    return out;
  }

  static fromQuat(q: Quat): Mat4 {
    const { x, y, z, w } = q;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    return new Mat4([
      1 - (yy + zz), xy + wz, xz - wy, 0,
      xy - wz, 1 - (xx + zz), yz + wx, 0,
      xz + wy, yz - wx, 1 - (xx + yy), 0,
      0, 0, 0, 1,
    ]);
  }

  static perspective(fovYRad: number, aspect: number, near: number, far: number): Mat4 {
    const f = 1 / Math.tan(fovYRad / 2);
    const nf = 1 / (near - far);
    const out = new Mat4(new Float32Array(16));
    out.m.fill(0);
    out.m[0] = f / aspect;
    out.m[5] = f;
    out.m[10] = (far + near) * nf;
    out.m[11] = -1;
    out.m[14] = 2 * far * near * nf;
    return out;
  }

  static ortho(left: number, right: number, bottom: number, top: number, near: number, far: number): Mat4 {
    const out = new Mat4();
    out.m[0] = 2 / (right - left);
    out.m[5] = 2 / (top - bottom);
    out.m[10] = -2 / (far - near);
    out.m[12] = -(right + left) / (right - left);
    out.m[13] = -(top + bottom) / (top - bottom);
    out.m[14] = -(far + near) / (far - near);
    return out;
  }

  static lookAt(eye: Vec3, center: Vec3, up: Vec3): Mat4 {
    const z = eye.sub(center).normalize();
    const x = up.cross(z).normalize();
    const y = z.cross(x);
    return new Mat4([
      x.x, y.x, z.x, 0,
      x.y, y.y, z.y, 0,
      x.z, y.z, z.z, 0,
      -x.dot(eye), -y.dot(eye), -z.dot(eye), 1,
    ]);
  }

  /** Returns this * other (applies `other` first, then this). */
  mul(other: Mat4): Mat4 {
    const a = this.m, b = other.m;
    const out = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
      out[c * 4]     = a[0] * b0 + a[4] * b1 + a[8]  * b2 + a[12] * b3;
      out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9]  * b2 + a[13] * b3;
      out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
      out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
    }
    return new Mat4(out);
  }

  invert(): Mat4 {
    const m = this.m;
    const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
    const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
    const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
    const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];

    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;

    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (Math.abs(det) < 1e-12) return Mat4.identity();
    det = 1 / det;

    return new Mat4([
      (a11 * b11 - a12 * b10 + a13 * b09) * det,
      (a02 * b10 - a01 * b11 - a03 * b09) * det,
      (a31 * b05 - a32 * b04 + a33 * b03) * det,
      (a22 * b04 - a21 * b05 - a23 * b03) * det,
      (a12 * b08 - a10 * b11 - a13 * b07) * det,
      (a00 * b11 - a02 * b08 + a03 * b07) * det,
      (a32 * b02 - a30 * b05 - a33 * b01) * det,
      (a20 * b05 - a22 * b02 + a23 * b01) * det,
      (a10 * b10 - a11 * b08 + a13 * b06) * det,
      (a01 * b08 - a00 * b10 - a03 * b06) * det,
      (a30 * b04 - a31 * b02 + a33 * b00) * det,
      (a21 * b02 - a20 * b04 - a23 * b00) * det,
      (a11 * b07 - a10 * b09 - a12 * b06) * det,
      (a00 * b09 - a01 * b07 + a02 * b06) * det,
      (a31 * b01 - a30 * b03 - a32 * b00) * det,
      (a20 * b03 - a21 * b01 + a22 * b00) * det,
    ]);
  }

  transpose(): Mat4 {
    const m = this.m;
    return new Mat4([
      m[0], m[4], m[8], m[12],
      m[1], m[5], m[9], m[13],
      m[2], m[6], m[10], m[14],
      m[3], m[7], m[11], m[15],
    ]);
  }

  /** Transform a point (w = 1), with perspective divide. */
  transformPoint(v: Vec3): Vec3 {
    const m = this.m;
    const w = m[3] * v.x + m[7] * v.y + m[11] * v.z + m[15] || 1;
    return new Vec3(
      (m[0] * v.x + m[4] * v.y + m[8] * v.z + m[12]) / w,
      (m[1] * v.x + m[5] * v.y + m[9] * v.z + m[13]) / w,
      (m[2] * v.x + m[6] * v.y + m[10] * v.z + m[14]) / w,
    );
  }

  /** Transform a direction (w = 0). */
  transformDir(v: Vec3): Vec3 {
    const m = this.m;
    return new Vec3(
      m[0] * v.x + m[4] * v.y + m[8] * v.z,
      m[1] * v.x + m[5] * v.y + m[9] * v.z,
      m[2] * v.x + m[6] * v.y + m[10] * v.z,
    );
  }

  /** Upper-3x3 of transpose(inverse(this)), for transforming normals. */
  normalMatrix(): Float32Array {
    const it = this.invert().transpose().m;
    return new Float32Array([it[0], it[1], it[2], it[4], it[5], it[6], it[8], it[9], it[10]]);
  }
}
