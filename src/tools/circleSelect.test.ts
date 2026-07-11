import { describe, it, expect } from 'vitest';
import { makeCube } from '../core/mesh/primitives';
import { Vec3 } from '../core/math/vec3';
import { Mat4 } from '../core/math/mat4';
import { projectToScreen } from './boxSelect';
import {
  elementsInCircle,
  captureSelection,
  commitSelectionChange,
  selectionEquals,
  cycleSelectMode,
  selectModeState,
  selectModeLabel,
} from './circleSelect';
import { EditModeState } from '../core/scene/EditMode';
import { UndoStack } from '../core/undo/UndoStack';

const WIDTH = 800;
const HEIGHT = 600;

/** A deterministic camera looking down -Z at the origin from (0,0,5). */
function knownMvp(): Mat4 {
  const proj = Mat4.perspective((60 * Math.PI) / 180, WIDTH / HEIGHT, 0.1, 100);
  const view = Mat4.lookAt(new Vec3(0, 0, 5), Vec3.ZERO, Vec3.Y);
  return proj.mul(view); // model = identity (cube already at origin)
}

describe('cycleSelectMode', () => {
  it('cycles Box → Circle → Lasso → Box', () => {
    selectModeState.mode = 'box';
    expect(cycleSelectMode()).toBe('circle');
    expect(cycleSelectMode()).toBe('lasso');
    expect(cycleSelectMode()).toBe('box');
    selectModeState.mode = 'box';
  });

  it('labels each mode', () => {
    expect(selectModeLabel('box')).toBe('Box');
    expect(selectModeLabel('circle')).toBe('Circle');
    expect(selectModeLabel('lasso')).toBe('Lasso');
  });
});

describe('elementsInCircle', () => {
  it('vert mode: a huge circle over the whole cube selects all 8 verts', () => {
    const mesh = makeCube();
    const hits = elementsInCircle(mesh, 'vert', knownMvp(), WIDTH, HEIGHT, WIDTH / 2, HEIGHT / 2, 5000);
    expect(hits.verts.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('vert mode: a tight circle around one projected vert selects only that vert', () => {
    const mesh = makeCube();
    const mvp = knownMvp();
    const p = projectToScreen(mesh.verts.get(6)!.co, mvp, WIDTH, HEIGHT)!;
    const hits = elementsInCircle(mesh, 'vert', mvp, WIDTH, HEIGHT, p.x, p.y, 3);
    expect(hits.verts).toEqual([6]);
  });

  it('edge mode: an edge counts when EITHER endpoint is inside (unlike box=both)', () => {
    const mesh = makeCube();
    const mvp = knownMvp();
    // A tight circle on ONE vert: box needs both ends (0 edges); circle needs
    // either end, so every edge touching that vert is selected.
    const p = projectToScreen(mesh.verts.get(6)!.co, mvp, WIDTH, HEIGHT)!;
    const hits = elementsInCircle(mesh, 'edge', mvp, WIDTH, HEIGHT, p.x, p.y, 3);
    // vert 6 has exactly 3 incident edges on a cube.
    expect(hits.edges.length).toBe(3);
    for (const key of hits.edges) expect(key.split(',').map(Number)).toContain(6);
  });

  it('face mode: a face counts when ANY of its verts is inside', () => {
    const mesh = makeCube();
    const mvp = knownMvp();
    const p = projectToScreen(mesh.verts.get(6)!.co, mvp, WIDTH, HEIGHT)!;
    const hits = elementsInCircle(mesh, 'face', mvp, WIDTH, HEIGHT, p.x, p.y, 3);
    // vert 6 is a corner of exactly 3 faces.
    expect(hits.faces.length).toBe(3);
  });

  it('a circle over empty space selects nothing', () => {
    const mesh = makeCube();
    const hits = elementsInCircle(mesh, 'vert', knownMvp(), WIDTH, HEIGHT, 5, 5, 3);
    expect(hits.verts).toEqual([]);
  });
});

describe('selection undo contract (commitSelectionChange)', () => {
  it('pushes exactly one entry and restores the prior selection on undo', () => {
    const mesh = makeCube();
    const sel = new EditModeState(0);
    sel.verts.add(0);
    const undo = new UndoStack();
    const before = captureSelection(sel);

    // Simulate a paint session that adds three verts.
    sel.verts.add(1);
    sel.verts.add(2);
    sel.verts.add(3);

    const pushes0 = undo.pushCount;
    const pushed = commitSelectionChange(undo, sel, before, 'Circle Select');
    expect(pushed).toBe(true);
    expect(undo.pushCount).toBe(pushes0 + 1);
    expect([...sel.verts].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);

    undo.undo();
    expect([...sel.verts].sort((a, b) => a - b)).toEqual([0]);

    undo.redo();
    expect([...sel.verts].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    void mesh;
  });

  it('pushes NO entry when the selection is unchanged', () => {
    const sel = new EditModeState(0);
    sel.verts.add(4);
    const undo = new UndoStack();
    const before = captureSelection(sel);
    const pushes0 = undo.pushCount;
    const pushed = commitSelectionChange(undo, sel, before, 'Circle Select');
    expect(pushed).toBe(false);
    expect(undo.pushCount).toBe(pushes0);
  });

  it('selectionEquals is order-independent', () => {
    const a = { verts: [1, 2, 3], edges: ['0,1'], faces: [] };
    const b = { verts: [3, 1, 2], edges: ['0,1'], faces: [] };
    const c = { verts: [1, 2], edges: ['0,1'], faces: [] };
    expect(selectionEquals(a, b)).toBe(true);
    expect(selectionEquals(a, c)).toBe(false);
  });
});
