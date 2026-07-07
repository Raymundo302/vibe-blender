import { describe, expect, it } from 'vitest';
import { Scene } from './Scene';
import { makeCube } from '../mesh/primitives';
import { EditableMesh } from '../mesh/EditableMesh';
import { Vec3 } from '../math/vec3';
import type { Modifier, ModifierContext } from '../modifiers/Modifier';

/** Test modifier: replaces the mesh with its target's evaluated mesh (clone). */
function targetCopier(targetId: number): Modifier {
  return {
    type: 'test-copier',
    name: 'Copier',
    enabled: true,
    apply(mesh: EditableMesh, ctx?: ModifierContext) {
      const t = ctx?.target(targetId);
      return t ? t.mesh.clone() : mesh;
    },
    params: () => ({ target: targetId }),
    setParam() {},
    fields: () => [{ key: 'target', label: 'Target', kind: 'object' as const }],
    depVersion: (ctx?: ModifierContext) => ctx?.target(targetId)?.version ?? 'none',
  };
}

describe('ModifierContext (P9 core)', () => {
  it('resolves targets to their evaluated mesh and re-evaluates when the target changes', () => {
    const scene = new Scene();
    const host = scene.add('Host', makeCube());
    const target = scene.add('Target', makeCube());
    host.modifiers.push(targetCopier(target.id));
    host.modifiersVersion++;

    const ctx = scene.modifierContext(host);
    expect(host.evaluatedMesh(ctx).verts.size).toBe(8);

    // Mutate the target — the host's cache must miss via depVersion.
    target.mesh.addVert(new Vec3(9, 9, 9));
    const ctx2 = scene.modifierContext(host);
    expect(host.evaluatedMesh(ctx2).verts.size).toBe(9);
  });

  it('breaks reference cycles (A→B→A resolves the inner lookup to null)', () => {
    const scene = new Scene();
    const a = scene.add('A', makeCube());
    const b = scene.add('B', makeCube());
    a.modifiers.push(targetCopier(b.id));
    a.modifiersVersion++;
    b.modifiers.push(targetCopier(a.id));
    b.modifiersVersion++;

    // Must not infinitely recurse; A sees B's evaluation where B's copier
    // found A blocked (visited) and fell back to B's own base mesh.
    const mesh = a.evaluatedMesh(scene.modifierContext(a));
    expect(mesh.verts.size).toBe(8);
  });

  it('non-mesh and missing targets resolve to null', () => {
    const scene = new Scene();
    const host = scene.add('Host', makeCube());
    const light = scene.addLight('L', 'point');
    const ctx = scene.modifierContext(host);
    expect(ctx.target(light.id)).toBeNull();
    expect(ctx.target(999)).toBeNull();
  });
});

describe('crease + tint attributes (P9 core)', () => {
  it('setCrease clamps, clears at 0, and survives clone/copyFrom', () => {
    const mesh = makeCube();
    const [a, b] = [...mesh.verts.keys()];
    mesh.setCrease(a, b, 2);
    expect(mesh.crease(a, b)).toBe(1);
    const copy = mesh.clone();
    expect(copy.crease(a, b)).toBe(1);
    const other = new EditableMesh();
    other.copyFrom(mesh);
    expect(other.crease(a, b)).toBe(1);
    mesh.setCrease(a, b, 0);
    expect(mesh.creases.size).toBe(0);
  });

  it('faceTints survive clone and land in the GPU corner colors', async () => {
    const { meshToRenderData } = await import('../mesh/meshToGpu');
    const mesh = makeCube();
    const faceId = [...mesh.faces.keys()][0];
    mesh.faceTints.set(faceId, [1, 0, 0]);
    const data = meshToRenderData(mesh);
    // First face is triangulated first: its corners are red, later ones white.
    expect(data.triangleColors[0]).toBe(1);
    expect(data.triangleColors[1]).toBe(0);
    expect(data.triangleColors[data.triangleColors.length - 1]).toBe(1);
    expect(mesh.clone().faceTints.get(faceId)).toEqual([1, 0, 0]);
  });
});
