import { describe, it, expect, beforeAll } from 'vitest';
import { registerModifier, createModifier, cloneModifier, type Modifier } from './Modifier';
import { ModifierStackCommand, ApplyModifierCommand } from '../undo/modifierCommands';
import { Scene } from '../scene/Scene';
import { makeCube } from '../mesh/primitives';
import { Vec3 } from '../math/vec3';
import { UndoStack } from '../undo/UndoStack';
import type { EditableMesh } from '../mesh/EditableMesh';

/** Test modifier: translates every vert by `offset` along X. */
function makeShift(params?: Record<string, number | boolean | string>): Modifier {
  let offset = typeof params?.offset === 'number' ? params.offset : 1;
  return {
    type: 'shift',
    name: 'Shift',
    enabled: true,
    apply(mesh: EditableMesh) {
      const out = mesh.clone();
      for (const v of out.verts.values()) out.setVertCo(v.id, v.co.add(new Vec3(offset, 0, 0)));
      return out;
    },
    params: () => ({ offset }),
    setParam(key, value) { if (key === 'offset') offset = value as number; },
    fields: () => [{ key: 'offset', label: 'Offset', kind: 'number' as const }],
  };
}

beforeAll(() => registerModifier('shift', 'Shift (test)', makeShift));

function cubeObj() {
  const scene = new Scene();
  return { scene, obj: scene.add('Cube', makeCube()) };
}

describe('modifier evaluation', () => {
  it('empty stack returns the base mesh itself (no copy)', () => {
    const { obj } = cubeObj();
    expect(obj.evaluatedMesh()).toBe(obj.mesh);
  });

  it('applies enabled modifiers in order without touching the base', () => {
    const { obj } = cubeObj();
    obj.modifiers.push(createModifier('shift', { offset: 2 }), createModifier('shift', { offset: 3 }));
    obj.modifiersVersion++;
    const out = obj.evaluatedMesh();
    expect(out.verts.get(0)!.co.x).toBe(-1 + 5);
    expect(obj.mesh.verts.get(0)!.co.x).toBe(-1); // base untouched
  });

  it('caches until mesh or stack version changes; disabled modifiers skipped', () => {
    const { obj } = cubeObj();
    obj.modifiers.push(createModifier('shift'));
    obj.modifiersVersion++;
    const a = obj.evaluatedMesh();
    expect(obj.evaluatedMesh()).toBe(a); // cached
    obj.modifiers[0].enabled = false;
    obj.modifiersVersion++;
    expect(obj.evaluatedMesh()).toBe(obj.mesh); // skipped entirely
  });

  it('cloneModifier round-trips params/name/enabled', () => {
    const m = createModifier('shift', { offset: 7 });
    m.name = 'My Shift';
    m.enabled = false;
    const c = cloneModifier(m);
    expect(c.params()).toEqual({ offset: 7 });
    expect(c.name).toBe('My Shift');
    expect(c.enabled).toBe(false);
  });
});

describe('modifier undo commands', () => {
  it('ModifierStackCommand round-trips add + param edit', () => {
    const { obj } = cubeObj();
    const undo = new UndoStack();
    undo.push(ModifierStackCommand.capture('Add Modifier', obj, () => {
      obj.modifiers.push(createModifier('shift', { offset: 4 }));
    }));
    expect(obj.modifiers.length).toBe(1);
    undo.undo();
    expect(obj.modifiers.length).toBe(0);
    undo.redo();
    expect(obj.modifiers.length).toBe(1);
    expect(obj.modifiers[0].params().offset).toBe(4);
  });

  it('ApplyModifierCommand bakes into the base mesh and undoes cleanly', () => {
    const { obj } = cubeObj();
    const undo = new UndoStack();
    obj.modifiers.push(createModifier('shift', { offset: 2 }));
    obj.modifiersVersion++;

    undo.push(new ApplyModifierCommand(obj, obj.modifiers[0]));
    expect(obj.modifiers.length).toBe(0);
    expect(obj.mesh.verts.get(0)!.co.x).toBe(1); // -1 + 2 baked in

    undo.undo();
    expect(obj.mesh.verts.get(0)!.co.x).toBe(-1);
    expect(obj.modifiers.length).toBe(1);
    undo.redo();
    expect(obj.mesh.verts.get(0)!.co.x).toBe(1);
  });

  it('refuses to apply a non-first modifier', () => {
    const { obj } = cubeObj();
    obj.modifiers.push(createModifier('shift'), createModifier('shift'));
    expect(() => new ApplyModifierCommand(obj, obj.modifiers[1])).toThrow();
  });
});
