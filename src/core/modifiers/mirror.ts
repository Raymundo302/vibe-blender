import { EditableMesh } from '../mesh/EditableMesh';
import { Vec3 } from '../math/vec3';
import {
  registerModifier,
  type Modifier,
  type ModifierField,
  type ModifierParams,
} from './Modifier';

type Axis = 'x' | 'y' | 'z';

/** Reflect a coordinate across the object-space plane perpendicular to `axis`. */
function reflect(co: Vec3, axis: Axis): Vec3 {
  return new Vec3(
    axis === 'x' ? -co.x : co.x,
    axis === 'y' ? -co.y : co.y,
    axis === 'z' ? -co.z : co.z,
  );
}

/**
 * Mirror modifier (P4-5). Output = the input clone plus a reflected copy of all
 * geometry across an object-space axis plane. Reflection flips orientation, so
 * every mirrored face's winding is REVERSED to keep its normal pointing outward
 * (backface culling is on). No merge at the seam in v1 — verts on the plane
 * simply duplicate. Deterministic: original verts/faces first (ids preserved by
 * clone), then mirrored verts in original iteration order, then mirrored faces.
 */
class MirrorModifier implements Modifier {
  readonly type = 'mirror';
  name = 'Mirror';
  enabled = true;
  private axis: Axis = 'x';

  constructor(params?: ModifierParams) {
    if (params) this.ingest(params);
  }

  apply(mesh: EditableMesh): EditableMesh {
    const out = mesh.clone(); // originals with ids + id counters intact
    const mirroredId = new Map<number, number>();
    for (const v of mesh.verts.values()) {
      mirroredId.set(v.id, out.addVert(reflect(v.co, this.axis)));
    }
    for (const f of mesh.faces.values()) {
      const verts = f.verts.map((id) => mirroredId.get(id)!).reverse();
      out.addFace(verts);
    }
    return out;
  }

  params(): ModifierParams {
    return { axis: this.axis };
  }

  setParam(key: string, value: number | boolean | string): void {
    if (key === 'axis' && (value === 'x' || value === 'y' || value === 'z')) this.axis = value;
  }

  private ingest(p: ModifierParams): void {
    if (p.axis === 'x' || p.axis === 'y' || p.axis === 'z') this.axis = p.axis;
  }

  fields(): ModifierField[] {
    return [{ key: 'axis', label: 'Axis', kind: 'axis' }];
  }
}

registerModifier('mirror', 'Mirror', (p) => new MirrorModifier(p));
