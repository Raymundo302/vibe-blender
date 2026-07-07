import { EditableMesh } from '../mesh/EditableMesh';
import { Vec3 } from '../math/vec3';
import {
  registerModifier,
  type Modifier,
  type ModifierField,
  type ModifierParams,
} from './Modifier';

const MIN_COUNT = 1;
const MAX_COUNT = 10;

function clampCount(n: number): number {
  return Math.max(MIN_COUNT, Math.min(MAX_COUNT, Math.round(n)));
}

/**
 * Array modifier (P4-5). Emits `count` copies of the input mesh, copy i shifted
 * by i * offset. count includes the original (count 1 = an unchanged clone).
 * Same dedup-free duplication as Mirror — deterministic ordering: the original
 * clone first (ids + counters preserved), then each successive copy's verts in
 * original iteration order followed by that copy's faces.
 */
class ArrayModifier implements Modifier {
  readonly type = 'array';
  name = 'Array';
  enabled = true;
  private count = 2;
  private offset = new Vec3(2, 0, 0);

  constructor(params?: ModifierParams) {
    if (params) this.ingest(params);
  }

  apply(mesh: EditableMesh): EditableMesh {
    const out = mesh.clone(); // copy 0 (offset 0), ids + counters intact
    for (let i = 1; i < this.count; i++) {
      const delta = this.offset.scale(i);
      const copyId = new Map<number, number>();
      for (const v of mesh.verts.values()) {
        copyId.set(v.id, out.addVert(v.co.add(delta)));
      }
      for (const f of mesh.faces.values()) {
        const fid = out.addFace(f.verts.map((id) => copyId.get(id)!));
        // Face UVs (P11-5) copy verbatim — array preserves winding, so the
        // corner order is unchanged and each instanced face maps identically.
        const uv = mesh.uvs.get(f.id);
        if (uv) out.setFaceUVs(fid, uv.map(([u, v]) => [u, v] as [number, number]));
      }
    }
    return out;
  }

  params(): ModifierParams {
    return {
      count: this.count,
      offsetX: this.offset.x,
      offsetY: this.offset.y,
      offsetZ: this.offset.z,
    };
  }

  setParam(key: string, value: number | boolean | string): void {
    if (typeof value !== 'number') return;
    if (key === 'count') this.count = clampCount(value);
    else if (key === 'offsetX') this.offset = new Vec3(value, this.offset.y, this.offset.z);
    else if (key === 'offsetY') this.offset = new Vec3(this.offset.x, value, this.offset.z);
    else if (key === 'offsetZ') this.offset = new Vec3(this.offset.x, this.offset.y, value);
  }

  private ingest(p: ModifierParams): void {
    if (typeof p.count === 'number') this.count = clampCount(p.count);
    const x = typeof p.offsetX === 'number' ? p.offsetX : this.offset.x;
    const y = typeof p.offsetY === 'number' ? p.offsetY : this.offset.y;
    const z = typeof p.offsetZ === 'number' ? p.offsetZ : this.offset.z;
    this.offset = new Vec3(x, y, z);
  }

  fields(): ModifierField[] {
    return [
      { key: 'count', label: 'Count', kind: 'int', min: MIN_COUNT, max: MAX_COUNT, step: 1 },
      { key: 'offsetX', label: 'Offset X', kind: 'number', step: 0.1 },
      { key: 'offsetY', label: 'Offset Y', kind: 'number', step: 0.1 },
      { key: 'offsetZ', label: 'Offset Z', kind: 'number', step: 0.1 },
    ];
  }
}

registerModifier('array', 'Array', (p) => new ArrayModifier(p));
