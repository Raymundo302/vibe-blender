import { EditableMesh } from '../mesh/EditableMesh';
import { Mat4 } from '../math/mat4';
import { closestPointOnMesh } from '../mesh/ops/closestPoint';
import {
  registerModifier,
  type Modifier,
  type ModifierContext,
  type ModifierField,
  type ModifierParams,
} from './Modifier';

/** Serialize a matrix's floats to fixed precision for cache-key comparison. */
function matSig(m: Mat4): string {
  let s = '';
  for (let i = 0; i < 16; i++) s += (i ? ',' : '') + m.m[i].toFixed(4);
  return s;
}

/**
 * Shrinkwrap modifier (P9) — Nearest Surface Point mode. Snaps every host vert
 * onto the closest point of a target object's evaluated surface, the way the
 * donut tutorial makes the icing hug the donut.
 *
 * For each vert: host-local → world → target-local (inv(target) · host · p),
 * find the closest surface point there, push it out along that face's normal by
 * `offset`, then bring it back into host-local space (inv(host) · target · q).
 * Only vert positions change — topology, creases and tints are preserved.
 *
 * Object-referencing, so without a ModifierContext (bare-mesh unit tests) or an
 * unresolvable target it returns the input mesh unchanged.
 */
class ShrinkwrapModifier implements Modifier {
  readonly type = 'shrinkwrap';
  name = 'Shrinkwrap';
  enabled = true;
  private target = -1;
  private offset = 0;

  constructor(params?: ModifierParams) {
    if (params) this.ingest(params);
  }

  apply(mesh: EditableMesh, ctx?: ModifierContext): EditableMesh {
    if (!ctx || this.target < 0) return mesh;
    const t = ctx.target(this.target);
    if (!t || t.mesh.faces.size === 0) return mesh;

    const toTarget = t.matrix.invert().mul(ctx.hostMatrix); // inv(target) · host
    const toHost = ctx.hostMatrix.invert().mul(t.matrix); // inv(host) · target

    const out = mesh.clone();
    for (const v of mesh.verts.values()) {
      const local = toTarget.transformPoint(v.co);
      const hit = closestPointOnMesh(t.mesh, local);
      const snapped = this.offset !== 0 ? hit.point.add(hit.normal.scale(this.offset)) : hit.point;
      out.setVertCo(v.id, toHost.transformPoint(snapped));
    }
    return out;
  }

  params(): ModifierParams {
    return { target: this.target, offset: this.offset };
  }

  setParam(key: string, value: number | boolean | string): void {
    if (key === 'target' && typeof value === 'number') this.target = Math.round(value);
    else if (key === 'offset' && typeof value === 'number') this.offset = value;
  }

  private ingest(p: ModifierParams): void {
    if (typeof p.target === 'number') this.target = Math.round(p.target);
    if (typeof p.offset === 'number') this.offset = p.offset;
  }

  fields(): ModifierField[] {
    return [
      { key: 'target', label: 'Target', kind: 'object' },
      { key: 'offset', label: 'Offset', kind: 'number', step: 0.01 },
    ];
  }

  depVersion(ctx?: ModifierContext): string {
    if (!ctx || this.target < 0) return '';
    const t = ctx.target(this.target);
    if (!t) return 'none';
    return `${t.version}|${matSig(ctx.hostMatrix)}|${matSig(t.matrix)}`;
  }
}

registerModifier('shrinkwrap', 'Shrinkwrap', (p) => new ShrinkwrapModifier(p));

export { ShrinkwrapModifier };
