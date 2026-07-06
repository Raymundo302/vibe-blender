import { describe, it, expect } from 'vitest';
import { Scene } from '../core/scene/Scene';
import { OrbitCamera } from '../camera/OrbitCamera';
import { UndoStack } from '../core/undo/UndoStack';
import type { OperatorContext } from '../core/operator/Operator';
import { makeCube } from '../core/mesh/primitives';
import { Vec3 } from '../core/math/vec3';
import { Mat4 } from '../core/math/mat4';
import { centroid, worldDeltaToLocal, EditTranslateOperator, EditScaleOperator } from './editTransform';

/** Fake context: real Scene/OrbitCamera/UndoStack, stubbed viewport + status. */
function makeCtx(): { ctx: OperatorContext; scene: Scene; undo: UndoStack; statuses: string[] } {
  const scene = new Scene();
  const camera = new OrbitCamera();
  const undo = new UndoStack();
  const statuses: string[] = [];
  const ctx: OperatorContext = {
    scene,
    camera,
    undo,
    viewportSize: () => ({ width: 800, height: 600 }),
    setStatus: (t: string) => statuses.push(t),
  };
  return { ctx, scene, undo, statuses };
}

/** A cube object in edit mode with every vert selected (pivot = origin). */
function cubeInEditMode(scene: Scene) {
  const obj = scene.add('Cube', makeCube());
  scene.activeId = obj.id;
  scene.enterEditMode(obj.id);
  scene.editMode!.selectAll(obj.mesh);
  return obj;
}

describe('centroid', () => {
  it('is the average of the points', () => {
    const c = centroid([new Vec3(0, 0, 0), new Vec3(2, 0, 0), new Vec3(1, 3, 0)]);
    expect(c.equalsApprox(new Vec3(1, 1, 0))).toBe(true);
  });
  it('is ZERO for an empty list', () => {
    expect(centroid([])).toBe(Vec3.ZERO);
  });
});

describe('worldDeltaToLocal', () => {
  it('is identity through an identity matrix', () => {
    const d = new Vec3(1, -2, 3);
    expect(worldDeltaToLocal(d, Mat4.identity()).equalsApprox(d)).toBe(true);
  });
  it('divides by scale through the inverse of a scaling matrix', () => {
    const inv = Mat4.scaling(new Vec3(2, 4, 5)).invert();
    expect(worldDeltaToLocal(new Vec3(2, 4, 5), inv).equalsApprox(new Vec3(1, 1, 1))).toBe(true);
  });
});

describe('EditScaleOperator', () => {
  it('numeric "2" doubles every vert coordinate about the origin pivot', () => {
    const { ctx, scene, undo } = makeCtx();
    const obj = cubeInEditMode(scene);
    const v0 = obj.mesh.verts.get(0)!.co;

    const op = new EditScaleOperator();
    expect(op.start(ctx, { x: 400, y: 300 })).toBe(true);
    expect(op.onKey(ctx, '2')).toBe(true);
    expect(obj.mesh.verts.get(0)!.co.equalsApprox(v0.scale(2))).toBe(true);

    op.confirm(ctx);
    // Exactly one command pushed, named 'Scale'; undo restores the original.
    expect(undo.undo()).toBe('Scale');
    expect(undo.undo()).toBe(null);
    expect(obj.mesh.verts.get(0)!.co.equalsApprox(v0)).toBe(true);
  });

  it('cancel restores the starting positions', () => {
    const { ctx, scene } = makeCtx();
    const obj = cubeInEditMode(scene);
    const v0 = obj.mesh.verts.get(0)!.co;

    const op = new EditScaleOperator();
    op.start(ctx, { x: 400, y: 300 });
    op.onKey(ctx, '3');
    expect(obj.mesh.verts.get(0)!.co.equalsApprox(v0)).toBe(false);
    op.cancel(ctx);
    expect(obj.mesh.verts.get(0)!.co.equalsApprox(v0)).toBe(true);
  });
});

describe('EditTranslateOperator', () => {
  it('start() returns false when nothing is selected (no dead modal state)', () => {
    const { ctx, scene } = makeCtx();
    const obj = scene.add('Cube', makeCube());
    scene.activeId = obj.id;
    scene.enterEditMode(obj.id);
    // selection is empty by default
    const op = new EditTranslateOperator();
    expect(op.start(ctx, { x: 400, y: 300 })).toBe(false);
  });
});
