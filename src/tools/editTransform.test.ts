import { describe, it, expect } from 'vitest';
import { Scene } from '../core/scene/Scene';
import { OrbitCamera } from '../camera/OrbitCamera';
import { UndoStack } from '../core/undo/UndoStack';
import type { OperatorContext } from '../core/operator/Operator';
import { makeCube } from '../core/mesh/primitives';
import { Vec3 } from '../core/math/vec3';
import { Mat4 } from '../core/math/mat4';
import {
  centroid,
  worldDeltaToLocal,
  EditTranslateOperator,
  EditScaleOperator,
  proportionalFalloff,
  computeProportionalWeights,
  proportional,
} from './editTransform';

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

describe('proportional default radius', () => {
  it('defaults to 1.0 world unit (sane for a default-scale scene)', () => {
    expect(proportional.radius).toBeCloseTo(1.0, 6);
  });
});

describe('proportionalFalloff (smooth 3t²−2t³)', () => {
  it('is 1 at the center, 0 at/beyond the radius, 0.5 at half', () => {
    expect(proportionalFalloff(0, 2)).toBeCloseTo(1, 6);
    expect(proportionalFalloff(2, 2)).toBeCloseTo(0, 6);
    expect(proportionalFalloff(1, 2)).toBeCloseTo(0.5, 6);
    expect(proportionalFalloff(3, 2)).toBe(0); // beyond the radius → 0
  });
});

describe('computeProportionalWeights', () => {
  it('selected verts weigh 1; unselected fall off by distance to the nearest', () => {
    const scene = new Scene();
    const obj = scene.add('Cube', makeCube()); // corners at ±1, edge length 2
    const selected = new Set([0]); // corner (-1,-1,-1)
    const w = computeProportionalWeights(obj.mesh, selected, true, 3);
    expect(w.get(0)).toBe(1);
    // Vert 1 (1,-1,-1) is an edge neighbour at distance 2 → t=1/3.
    expect(w.get(1)).toBeCloseTo(proportionalFalloff(2, 3), 6);
    // Vert 6 (1,1,1) is the opposite corner at distance 2√3 > 3 → dropped.
    expect(w.has(6)).toBe(false);
  });

  it('disabled → only the selection, all weight 1', () => {
    const scene = new Scene();
    const obj = scene.add('Cube', makeCube());
    const w = computeProportionalWeights(obj.mesh, new Set([0, 1]), false, 3);
    expect([...w.keys()].sort()).toEqual([0, 1]);
    expect(w.get(0)).toBe(1);
    expect(w.get(1)).toBe(1);
  });
});

describe('EditTranslateOperator — proportional falloff', () => {
  it('moves an unselected neighbour by weight×delta; far vert stays put', () => {
    const { ctx, scene } = makeCtx();
    const obj = scene.add('Cube', makeCube());
    scene.activeId = obj.id;
    scene.enterEditMode(obj.id);
    scene.editMode!.verts.add(0); // select just the corner (-1,-1,-1)
    scene.editMode!.touch();

    const before0 = obj.mesh.verts.get(0)!.co;
    const before1 = obj.mesh.verts.get(1)!.co;
    const before6 = obj.mesh.verts.get(6)!.co;

    proportional.enabled = true;
    proportional.radius = 3;
    try {
      const op = new EditTranslateOperator();
      expect(op.start(ctx, { x: 400, y: 300 })).toBe(true);
      op.onPointerMove(ctx, { x: 480, y: 360 });

      const disp0 = obj.mesh.verts.get(0)!.co.sub(before0);
      const disp1 = obj.mesh.verts.get(1)!.co.sub(before1);
      const disp6 = obj.mesh.verts.get(6)!.co.sub(before6);

      expect(disp0.length()).toBeGreaterThan(1e-4); // selected vert actually moved
      const w1 = proportionalFalloff(2, 3);
      expect(disp1.equalsApprox(disp0.scale(w1))).toBe(true); // neighbour = weight×delta
      expect(disp1.length()).toBeLessThan(disp0.length()); // and less than the selected
      expect(disp6.length()).toBeCloseTo(0, 6); // opposite corner (beyond radius) → 0
    } finally {
      proportional.enabled = false;
      proportional.radius = 1.0; // restore the module default
    }
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
