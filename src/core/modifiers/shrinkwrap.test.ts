import { describe, expect, it } from 'vitest';
import { Scene } from '../scene/Scene';
import { EditableMesh } from '../mesh/EditableMesh';
import { makeCube } from '../mesh/primitives';
import { Vec3 } from '../math/vec3';
import { createModifier } from './Modifier';
import './shrinkwrap'; // registers 'shrinkwrap'

/** A small quad hovering at y=3, entirely over a unit cube's top face. */
function hoverPlane(): EditableMesh {
  return EditableMesh.fromData(
    [
      [-0.5, 3, -0.5],
      [0.5, 3, -0.5],
      [0.5, 3, 0.5],
      [-0.5, 3, 0.5],
    ],
    [[0, 3, 2, 1]],
  );
}

describe('Shrinkwrap modifier', () => {
  it('snaps host verts onto the target cube top face (identity host)', () => {
    const scene = new Scene();
    const host = scene.add('Host', hoverPlane());
    const target = scene.add('Target', makeCube());
    const mod = createModifier('shrinkwrap', { target: target.id, offset: 0 });
    host.modifiers.push(mod);
    host.modifiersVersion++;

    const evaluated = host.evaluatedMesh(scene.modifierContext(host));
    for (const v of evaluated.verts.values()) {
      expect(Math.abs(v.co.y - 1)).toBeLessThan(1e-4); // cube top = y 1
    }
  });

  it('applies a positive offset along the surface normal', () => {
    const scene = new Scene();
    const host = scene.add('Host', hoverPlane());
    const target = scene.add('Target', makeCube());
    host.modifiers.push(createModifier('shrinkwrap', { target: target.id, offset: 0.5 }));
    host.modifiersVersion++;

    const evaluated = host.evaluatedMesh(scene.modifierContext(host));
    for (const v of evaluated.verts.values()) {
      expect(Math.abs(v.co.y - 1.5)).toBeLessThan(1e-4); // top + offset
    }
  });

  it('preserves topology, creases and tints', () => {
    const scene = new Scene();
    const mesh = hoverPlane();
    const [a, b] = [...mesh.verts.keys()];
    mesh.setCrease(a, b, 0.7);
    const faceId = [...mesh.faces.keys()][0];
    mesh.faceTints.set(faceId, [1, 0, 0]);
    const host = scene.add('Host', mesh);
    const target = scene.add('Target', makeCube());
    host.modifiers.push(createModifier('shrinkwrap', { target: target.id }));
    host.modifiersVersion++;

    const evaluated = host.evaluatedMesh(scene.modifierContext(host));
    expect(evaluated.verts.size).toBe(mesh.verts.size);
    expect(evaluated.faces.size).toBe(mesh.faces.size);
    expect(evaluated.crease(a, b)).toBe(0.7);
    expect(evaluated.faceTints.get(faceId)).toEqual([1, 0, 0]);
  });

  it('is identity without a ModifierContext', () => {
    const target = 5;
    const mod = createModifier('shrinkwrap', { target, offset: 0.5 });
    const mesh = hoverPlane();
    expect(mod.apply(mesh)).toBe(mesh); // same reference, untouched
  });

  it('changes depVersion when the target transform moves', () => {
    const scene = new Scene();
    const host = scene.add('Host', hoverPlane());
    const target = scene.add('Target', makeCube());
    const mod = createModifier('shrinkwrap', { target: target.id });
    host.modifiers.push(mod);
    host.modifiersVersion++;

    const before = mod.depVersion!(scene.modifierContext(host));
    target.transform = target.transform.withPosition(new Vec3(0, 2, 0));
    const after = mod.depVersion!(scene.modifierContext(host));
    expect(after).not.toBe(before);
  });

  it('does not hang on a mutual wrap cycle and both still render', () => {
    const scene = new Scene();
    const a = scene.add('A', makeCube());
    const b = scene.add('B', makeCube());
    a.modifiers.push(createModifier('shrinkwrap', { target: b.id }));
    a.modifiersVersion++;
    b.modifiers.push(createModifier('shrinkwrap', { target: a.id }));
    b.modifiersVersion++;

    // The context cycle guard hands the inner lookup a null → identity fallback.
    expect(a.evaluatedMesh(scene.modifierContext(a)).verts.size).toBe(8);
    expect(b.evaluatedMesh(scene.modifierContext(b)).verts.size).toBe(8);
  });
});
