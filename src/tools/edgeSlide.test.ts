import { describe, it, expect } from 'vitest';
import { Scene } from '../core/scene/Scene';
import { OrbitCamera } from '../camera/OrbitCamera';
import { UndoStack } from '../core/undo/UndoStack';
import type { OperatorContext } from '../core/operator/Operator';
import { EditableMesh } from '../core/mesh/EditableMesh';
import { Vec3 } from '../core/math/vec3';
import { pickRails, slidePosition, EdgeSlideOperator } from './edgeSlide';

/** Fake context: real Scene/OrbitCamera/UndoStack, stubbed viewport + status. */
function makeCtx(): { ctx: OperatorContext; scene: Scene; undo: UndoStack } {
  const scene = new Scene();
  const camera = new OrbitCamera();
  const undo = new UndoStack();
  const ctx: OperatorContext = {
    scene,
    camera,
    undo,
    viewportSize: () => ({ width: 800, height: 600 }),
    setStatus: () => {},
  };
  return { ctx, scene, undo };
}

/**
 * 3×1 quad strip in the XY plane (z = 0). Four columns at x = 0,1,2,3, two rows
 * y = 0 (bottom) and y = 1 (top); three quads. Vert ids run column-major:
 *   col x=0 → 0 (bottom) 1 (top); x=1 → 2,3; x=2 → 4,5; x=3 → 6,7.
 * The shared middle edge is 2–3 (the vertical edge at x=1).
 */
function quadStrip(): EditableMesh {
  return EditableMesh.fromData(
    [
      [0, 0, 0], [0, 1, 0],
      [1, 0, 0], [1, 1, 0],
      [2, 0, 0], [2, 1, 0],
      [3, 0, 0], [3, 1, 0],
    ],
    [
      [0, 2, 3, 1],
      [2, 4, 5, 3],
      [4, 6, 7, 5],
    ],
  );
}

describe('pickRails', () => {
  it('picks the two anti-parallel horizontal rails of a middle-edge vert', () => {
    const mesh = quadStrip();
    const selected = new Set([2, 3]); // the middle edge 2–3
    const rails = pickRails(mesh, 2, selected);
    // Vert 2 sits at x=1: rail A (+X, larger far id 4), rail B (-X, far id 0).
    expect(rails.a?.farId).toBe(4);
    expect(rails.b?.farId).toBe(0);
    expect(rails.a?.dir.equalsApprox(new Vec3(1, 0, 0))).toBe(true);
    expect(rails.b?.dir.equalsApprox(new Vec3(-1, 0, 0))).toBe(true);
    expect(rails.a?.length).toBeCloseTo(1, 6);
  });

  it('excludes the selected edge (a rail whose far vert is also selected)', () => {
    const mesh = quadStrip();
    const rails = pickRails(mesh, 2, new Set([2, 3]));
    // Neither rail points at vert 3 (the far end of the selected edge).
    expect(rails.a?.farId).not.toBe(3);
    expect(rails.b?.farId).not.toBe(3);
  });
});

describe('slidePosition', () => {
  const mesh = quadStrip();
  const rails = pickRails(mesh, 2, new Set([2, 3]));
  const base = mesh.verts.get(2)!.co; // (1, 0, 0)

  it('t=0.5 slides toward the +X neighbour by half the rail length', () => {
    const p = slidePosition(base, rails, 0.5);
    expect(p.x).toBeCloseTo(1.5, 6); // hand-checked coordinate
    expect(p.y).toBeCloseTo(0, 6);
  });

  it('t=-0.5 slides the other way (toward -X)', () => {
    const p = slidePosition(base, rails, -0.5);
    expect(p.x).toBeCloseTo(0.5, 6);
  });

  it('t=0 stays put', () => {
    expect(slidePosition(base, rails, 0).equalsApprox(base)).toBe(true);
  });

  it('a single-rail vert only slides for the matching (positive) sign', () => {
    const one = { a: rails.a, b: null };
    expect(slidePosition(base, one, 0.5).x).toBeCloseTo(1.5, 6);
    expect(slidePosition(base, one, -0.5).equalsApprox(base)).toBe(true);
  });
});

describe('EdgeSlideOperator', () => {
  function stripInEditMode(scene: Scene) {
    const obj = scene.add('Strip', quadStrip());
    scene.activeId = obj.id;
    scene.enterEditMode(obj.id);
    const sel = scene.editMode!;
    sel.setElementMode('edge', obj.mesh);
    sel.edges.add(EditableMesh.edgeKey(2, 3)); // select the middle edge
    sel.touch();
    return obj;
  }

  it('numeric "0.5" slides the middle-edge verts +X by half the rail; undo restores', () => {
    const { ctx, scene, undo } = makeCtx();
    const obj = stripInEditMode(scene);

    const op = new EdgeSlideOperator();
    expect(op.start(ctx, { x: 400, y: 300 })).toBe(true);
    expect(op.onKey(ctx, '0')).toBe(true);
    expect(op.onKey(ctx, '.')).toBe(true);
    expect(op.onKey(ctx, '5')).toBe(true);
    expect(obj.mesh.verts.get(2)!.co.equalsApprox(new Vec3(1.5, 0, 0))).toBe(true);
    expect(obj.mesh.verts.get(3)!.co.equalsApprox(new Vec3(1.5, 1, 0))).toBe(true);

    op.confirm(ctx);
    expect(undo.undo()).toBe('Edge Slide');
    expect(undo.undo()).toBe(null);
    expect(obj.mesh.verts.get(2)!.co.equalsApprox(new Vec3(1, 0, 0))).toBe(true);
    expect(obj.mesh.verts.get(3)!.co.equalsApprox(new Vec3(1, 1, 0))).toBe(true);
  });

  it('cancel restores the starting positions', () => {
    const { ctx, scene } = makeCtx();
    const obj = stripInEditMode(scene);

    const op = new EdgeSlideOperator();
    op.start(ctx, { x: 400, y: 300 });
    op.onKey(ctx, '-');
    op.onKey(ctx, '.');
    op.onKey(ctx, '5');
    expect(obj.mesh.verts.get(2)!.co.equalsApprox(new Vec3(0.5, 0, 0))).toBe(true);
    op.cancel(ctx);
    expect(obj.mesh.verts.get(2)!.co.equalsApprox(new Vec3(1, 0, 0))).toBe(true);
  });

  it('start() returns false when nothing is selected', () => {
    const { ctx, scene } = makeCtx();
    const obj = scene.add('Strip', quadStrip());
    scene.activeId = obj.id;
    scene.enterEditMode(obj.id);
    const op = new EdgeSlideOperator();
    expect(op.start(ctx, { x: 400, y: 300 })).toBe(false);
  });
});
