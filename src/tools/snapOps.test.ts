import { describe, it, expect } from 'vitest';
import { Scene } from '../core/scene/Scene';
import { UndoStack } from '../core/undo/UndoStack';
import { makeCube } from '../core/mesh/primitives';
import { Vec3 } from '../core/math/vec3';
import { Transform } from '../core/math/transform';
import { SNAP_STEP } from '../core/snap';
import {
  cursorToOrigin,
  cursorToSelected,
  cursorToGrid,
  selectionToCursor,
  selectionToGrid,
} from './snapOps';

const close = (a: Vec3, b: Vec3, eps = 1e-5): void => {
  expect(Math.abs(a.x - b.x)).toBeLessThan(eps);
  expect(Math.abs(a.y - b.y)).toBeLessThan(eps);
  expect(Math.abs(a.z - b.z)).toBeLessThan(eps);
};

describe('snapOps — cursor moves', () => {
  it('cursorToOrigin resets the cursor', () => {
    const scene = new Scene();
    scene.cursor = new Vec3(3, 4, 5);
    cursorToOrigin(scene);
    close(scene.cursor, Vec3.ZERO);
  });

  it('cursorToSelected uses WORLD positions (object mode, one parented)', () => {
    const scene = new Scene();
    const parent = scene.add('P', makeCube());
    const child = scene.add('C', makeCube());
    parent.transform = new Transform(new Vec3(10, 0, 0));
    child.transform = new Transform(new Vec3(0, 4, 0)); // local
    child.parentId = parent.id; // world = (10, 4, 0)

    const a = scene.add('A', makeCube());
    a.transform = new Transform(new Vec3(2, 0, 0)); // world = (2, 0, 0)

    scene.selection.clear();
    scene.selection.add(child.id);
    scene.selection.add(a.id);

    cursorToSelected(scene);
    // median of world (10,4,0) and (2,0,0) = (6,2,0)
    close(scene.cursor, new Vec3(6, 2, 0));
  });

  it('cursorToGrid snaps to SNAP_STEP (0.5) multiples', () => {
    const scene = new Scene();
    scene.cursor = new Vec3(0.62, -0.3, 1.24);
    cursorToGrid(scene);
    close(scene.cursor, new Vec3(0.5, -0.5, 1.0));
    expect(SNAP_STEP).toBe(0.5);
    for (const c of [scene.cursor.x, scene.cursor.y, scene.cursor.z]) {
      expect(Math.abs((c / SNAP_STEP) - Math.round(c / SNAP_STEP))).toBeLessThan(1e-9);
    }
  });
});

describe('snapOps — selection moves (undoable)', () => {
  it('selectionToCursor moves a parented child to the cursor in WORLD space, one undo restores', () => {
    const scene = new Scene();
    const undo = new UndoStack();
    const parent = scene.add('P', makeCube());
    const child = scene.add('C', makeCube());
    parent.transform = new Transform(new Vec3(10, 0, 0));
    child.transform = new Transform(new Vec3(0, 4, 0));
    child.parentId = parent.id;

    const root = scene.add('R', makeCube());
    root.transform = new Transform(new Vec3(-3, 1, 2));

    const childBefore = child.transform;
    const rootBefore = root.transform;

    scene.cursor = new Vec3(1, 2, 3);
    scene.selection.clear();
    scene.selection.add(child.id);
    scene.selection.add(root.id);

    selectionToCursor(scene, undo);
    // Both objects now sit at the cursor in WORLD space.
    close(scene.worldTransformOf(child).position, new Vec3(1, 2, 3));
    close(scene.worldTransformOf(root).position, new Vec3(1, 2, 3));
    // The child's LOCAL transform accounts for its parent (10,0,0) → (-9,2,3).
    close(child.transform.position, new Vec3(-9, 2, 3));

    // A single undo restores BOTH objects' local transforms.
    undo.undo();
    close(child.transform.position, childBefore.position);
    close(root.transform.position, rootBefore.position);
    close(scene.worldTransformOf(child).position, new Vec3(10, 4, 0));
  });

  it('selectionToGrid snaps each selected object world position to 0.5 multiples', () => {
    const scene = new Scene();
    const undo = new UndoStack();
    const a = scene.add('A', makeCube());
    const b = scene.add('B', makeCube());
    a.transform = new Transform(new Vec3(0.62, -0.3, 1.24));
    b.transform = new Transform(new Vec3(2.1, 2.4, -1.9));

    scene.selection.clear();
    scene.selection.add(a.id);
    scene.selection.add(b.id);

    selectionToGrid(scene, undo);
    close(a.transform.position, new Vec3(0.5, -0.5, 1.0));
    close(b.transform.position, new Vec3(2.0, 2.5, -2.0));

    undo.undo();
    close(a.transform.position, new Vec3(0.62, -0.3, 1.24));
    close(b.transform.position, new Vec3(2.1, 2.4, -1.9));
  });
});
