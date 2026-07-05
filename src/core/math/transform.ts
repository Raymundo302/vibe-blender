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
}
