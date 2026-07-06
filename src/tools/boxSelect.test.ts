import { describe, it, expect } from 'vitest';
import { makeCube } from '../core/mesh/primitives';
import { Vec3 } from '../core/math/vec3';
import { Mat4 } from '../core/math/mat4';
import { projectToScreen, elementsInRect, invertSelection, type ScreenRect } from './boxSelect';
import { EditModeState } from '../core/scene/EditMode';

const WIDTH = 800;
const HEIGHT = 600;

/** A deterministic camera looking down -Z at the origin from (0,0,5). */
function knownMvp(): Mat4 {
  const proj = Mat4.perspective((60 * Math.PI) / 180, WIDTH / HEIGHT, 0.1, 100);
  const view = Mat4.lookAt(new Vec3(0, 0, 5), Vec3.ZERO, Vec3.Y);
  return proj.mul(view); // model = identity (cube already at origin)
}

/** Rect covering the whole viewport. */
const FULL: ScreenRect = { x0: 0, y0: 0, x1: WIDTH, y1: HEIGHT };

describe('projectToScreen', () => {
  it('projects a point in front of the camera to CSS pixels', () => {
    const p = projectToScreen(Vec3.ZERO, knownMvp(), WIDTH, HEIGHT);
    expect(p).not.toBeNull();
    // Origin is dead center of the screen.
    expect(p!.x).toBeCloseTo(WIDTH / 2, 3);
    expect(p!.y).toBeCloseTo(HEIGHT / 2, 3);
  });

  it('returns null for a point behind the camera', () => {
    // Camera sits at z=5 looking toward -Z; a point far behind it (z=+50) is
    // outside the clip depth range.
    expect(projectToScreen(new Vec3(0, 0, 50), knownMvp(), WIDTH, HEIGHT)).toBeNull();
  });
});

describe('elementsInRect', () => {
  it('vert mode: a full-screen rect selects all 8 cube verts', () => {
    const mesh = makeCube();
    const hits = elementsInRect(mesh, 'vert', knownMvp(), WIDTH, HEIGHT, FULL);
    expect(hits.verts.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('vert mode: a tight rect around one projected vert selects only that vert', () => {
    const mesh = makeCube();
    const mvp = knownMvp();
    const p = projectToScreen(mesh.verts.get(6)!.co, mvp, WIDTH, HEIGHT)!;
    const rect: ScreenRect = { x0: p.x - 2, y0: p.y - 2, x1: p.x + 2, y1: p.y + 2 };
    const hits = elementsInRect(mesh, 'vert', mvp, WIDTH, HEIGHT, rect);
    expect(hits.verts).toEqual([6]);
  });

  it('edge mode: an edge is selected only when BOTH endpoints are inside', () => {
    const mesh = makeCube();
    const mvp = knownMvp();
    // Full rect → every edge (12 on a cube).
    expect(elementsInRect(mesh, 'edge', mvp, WIDTH, HEIGHT, FULL).edges.length).toBe(12);
    // Rect around a single vert → no edge (needs both ends).
    const p = projectToScreen(mesh.verts.get(6)!.co, mvp, WIDTH, HEIGHT)!;
    const tiny: ScreenRect = { x0: p.x - 2, y0: p.y - 2, x1: p.x + 2, y1: p.y + 2 };
    expect(elementsInRect(mesh, 'edge', mvp, WIDTH, HEIGHT, tiny).edges).toEqual([]);
  });

  it('face mode: a face is selected only when ALL corners are inside', () => {
    const mesh = makeCube();
    const mvp = knownMvp();
    expect(elementsInRect(mesh, 'face', mvp, WIDTH, HEIGHT, FULL).faces.length).toBe(6);
    const p = projectToScreen(mesh.verts.get(6)!.co, mvp, WIDTH, HEIGHT)!;
    const tiny: ScreenRect = { x0: p.x - 2, y0: p.y - 2, x1: p.x + 2, y1: p.y + 2 };
    expect(elementsInRect(mesh, 'face', mvp, WIDTH, HEIGHT, tiny).faces).toEqual([]);
  });
});

describe('invertSelection', () => {
  it('replaces the selected verts with their complement', () => {
    const mesh = makeCube();
    const sel = new EditModeState(0);
    sel.verts.add(0);
    sel.verts.add(1);
    const v = sel.version;
    invertSelection(sel, mesh);
    expect([...sel.verts].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(sel.version).toBeGreaterThan(v);
  });

  it('inverting twice returns the original selection', () => {
    const mesh = makeCube();
    const sel = new EditModeState(0);
    sel.verts.add(2);
    sel.verts.add(5);
    invertSelection(sel, mesh);
    invertSelection(sel, mesh);
    expect([...sel.verts].sort((a, b) => a - b)).toEqual([2, 5]);
  });
});
