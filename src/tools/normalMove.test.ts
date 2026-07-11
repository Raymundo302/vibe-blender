import { describe, it, expect } from 'vitest';
import { Scene } from '../core/scene/Scene';
import { OrbitCamera } from '../camera/OrbitCamera';
import { UndoStack } from '../core/undo/UndoStack';
import type { OperatorContext } from '../core/operator/Operator';
import { makeCube } from '../core/mesh/primitives';
import { Vec3 } from '../core/math/vec3';
import { NormalMoveOperator } from './normalMove';

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

/** A cube in edit mode with `vertId` selected (vert mode). */
function cubeWithVert(scene: Scene, vertId: number) {
  const obj = scene.add('Cube', makeCube(1));
  scene.activeId = obj.id;
  scene.enterEditMode(obj.id);
  const sel = scene.editMode!;
  sel.setElementMode('vert', obj.mesh);
  sel.verts.add(vertId);
  sel.touch();
  return obj;
}

const SQRT3 = Math.sqrt(3);
const DIAG = new Vec3(1, 1, 1).scale(1 / SQRT3);

describe('NormalMoveOperator', () => {
  it('moves a cube corner along its diagonal vertex normal', () => {
    const { ctx, scene } = makeCtx();
    // Vert 6 = (1,1,1); its area-weighted normal is the cube diagonal.
    const obj = cubeWithVert(scene, 6);
    const start = obj.mesh.verts.get(6)!.co;

    const op = new NormalMoveOperator();
    expect(op.start(ctx, { x: 400, y: 300 })).toBe(true);
    // Numeric d = 1: pos = start + diag·1.
    op.onKey(ctx, '1');
    const expected = start.add(DIAG);
    expect(obj.mesh.verts.get(6)!.co.equalsApprox(expected)).toBe(true);
  });

  it('LOCKS the captured normals — mutating the mesh mid-op does not re-derive them', () => {
    const { ctx, scene } = makeCtx();
    const obj = cubeWithVert(scene, 6);
    const start = obj.mesh.verts.get(6)!.co;

    const op = new NormalMoveOperator();
    op.start(ctx, { x: 400, y: 300 });

    // Mutate the mesh mid-op: drag two neighbours far away, which WOULD change
    // vert 6's freshly-computed vertex normal. The op must ignore that.
    obj.mesh.setVertCo(5, new Vec3(9, -9, 9));
    obj.mesh.setVertCo(7, new Vec3(-9, 9, 9));

    // Apply d = 2 via numeric. The offset must still be along the ORIGINAL diag.
    op.onKey(ctx, '2');
    const offset = obj.mesh.verts.get(6)!.co.sub(start);
    expect(offset.length()).toBeCloseTo(2, 6);
    expect(offset.normalize().equalsApprox(DIAG)).toBe(true);
    // Explicitly: NOT along whatever the mutated mesh's normal would now be.
    expect(obj.mesh.verts.get(6)!.co.equalsApprox(start.add(DIAG.scale(2)))).toBe(true);
  });

  it('confirm pushes one Normal Move undo entry; undo restores the start', () => {
    const { ctx, scene, undo } = makeCtx();
    const obj = cubeWithVert(scene, 6);
    const start = obj.mesh.verts.get(6)!.co;

    const op = new NormalMoveOperator();
    op.start(ctx, { x: 400, y: 300 });
    op.onKey(ctx, '1');
    op.confirm(ctx);

    expect(undo.undo()).toBe('Normal Move');
    expect(undo.undo()).toBe(null);
    expect(obj.mesh.verts.get(6)!.co.equalsApprox(start)).toBe(true);
  });

  it('cancel restores the starting position', () => {
    const { ctx, scene } = makeCtx();
    const obj = cubeWithVert(scene, 6);
    const start = obj.mesh.verts.get(6)!.co;

    const op = new NormalMoveOperator();
    op.start(ctx, { x: 400, y: 300 });
    op.onKey(ctx, '3');
    expect(obj.mesh.verts.get(6)!.co.equalsApprox(start)).toBe(false);
    op.cancel(ctx);
    expect(obj.mesh.verts.get(6)!.co.equalsApprox(start)).toBe(true);
  });

  it('a wire vert with no faces gets a zero normal → stays put', () => {
    const { ctx, scene } = makeCtx();
    // Two lone verts joined by nothing but an edge (no faces).
    const obj = scene.add('Wire', makeCube(1));
    // Add an isolated vert with no incident face.
    const loneId = obj.mesh.addVert(new Vec3(5, 5, 5));
    scene.activeId = obj.id;
    scene.enterEditMode(obj.id);
    const sel = scene.editMode!;
    sel.setElementMode('vert', obj.mesh);
    sel.verts.add(loneId);
    sel.touch();
    const start = obj.mesh.verts.get(loneId)!.co;

    const op = new NormalMoveOperator();
    op.start(ctx, { x: 400, y: 300 });
    op.onKey(ctx, '5');
    expect(obj.mesh.verts.get(loneId)!.co.equalsApprox(start)).toBe(true);
  });

  it('start() returns false when nothing is selected', () => {
    const { ctx, scene } = makeCtx();
    const obj = scene.add('Cube', makeCube(1));
    scene.activeId = obj.id;
    scene.enterEditMode(obj.id);
    const op = new NormalMoveOperator();
    expect(op.start(ctx, { x: 400, y: 300 })).toBe(false);
  });

  it("sets cycleRequested on a second 'g'", () => {
    const { ctx, scene } = makeCtx();
    cubeWithVert(scene, 6);
    const op = new NormalMoveOperator();
    op.start(ctx, { x: 400, y: 300 });
    expect(op.cycleRequested).toBe(false);
    expect(op.onKey(ctx, 'g')).toBe(true);
    expect(op.cycleRequested).toBe(true);
  });
});
