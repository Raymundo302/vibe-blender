import { describe, it, expect } from 'vitest';
import { makeCube } from '../core/mesh/primitives';
import { Vec3 } from '../core/math/vec3';
import { Mat4 } from '../core/math/mat4';
import { projectToScreen } from './boxSelect';
import { pointInPolygon, elementsInLasso, type Pt } from './lassoSelect';

const WIDTH = 800;
const HEIGHT = 600;

function knownMvp(): Mat4 {
  const proj = Mat4.perspective((60 * Math.PI) / 180, WIDTH / HEIGHT, 0.1, 100);
  const view = Mat4.lookAt(new Vec3(0, 0, 5), Vec3.ZERO, Vec3.Y);
  return proj.mul(view);
}

describe('pointInPolygon', () => {
  it('convex: a square contains interior points and excludes exterior ones', () => {
    const sq: Pt[] = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
    ];
    expect(pointInPolygon({ x: 2, y: 2 }, sq)).toBe(true);
    expect(pointInPolygon({ x: 5, y: 5 }, sq)).toBe(false);
    expect(pointInPolygon({ x: 2, y: -1 }, sq)).toBe(false);
  });

  it('concave: an L-shape excludes points in the notch', () => {
    // Bottom strip (y0..2) + right column (x2..4); top-left notch removed.
    const L: Pt[] = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 2, y: 4 },
      { x: 2, y: 2 },
      { x: 0, y: 2 },
    ];
    expect(pointInPolygon({ x: 1, y: 1 }, L)).toBe(true); // bottom strip
    expect(pointInPolygon({ x: 3, y: 3 }, L)).toBe(true); // right column
    expect(pointInPolygon({ x: 1, y: 3 }, L)).toBe(false); // the notch
  });

  it('self-touching / self-crossing loop: even-odd fills the two bowtie lobes', () => {
    // A squiggle that crosses itself: the two diagonals meet at (2,2), leaving a
    // left lobe and a right lobe filled, the top/bottom centre empty.
    const bowtie: Pt[] = [
      { x: 0, y: 0 },
      { x: 0, y: 4 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
    ];
    expect(pointInPolygon({ x: 0.5, y: 2 }, bowtie)).toBe(true); // left lobe
    expect(pointInPolygon({ x: 3.5, y: 2 }, bowtie)).toBe(true); // right lobe
    expect(pointInPolygon({ x: 2, y: 3.5 }, bowtie)).toBe(false); // top centre
    expect(pointInPolygon({ x: 2, y: 0.5 }, bowtie)).toBe(false); // bottom centre
  });
});

describe('elementsInLasso', () => {
  const fullScreen: Pt[] = [
    { x: -10, y: -10 },
    { x: WIDTH + 10, y: -10 },
    { x: WIDTH + 10, y: HEIGHT + 10 },
    { x: -10, y: HEIGHT + 10 },
  ];

  it('vert mode: a screen-covering loop selects all 8 cube verts', () => {
    const mesh = makeCube();
    const hits = elementsInLasso(mesh, 'vert', knownMvp(), WIDTH, HEIGHT, fullScreen);
    expect(hits.verts.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('edge mode: a screen-covering loop selects all 12 edges (by midpoint)', () => {
    const mesh = makeCube();
    const hits = elementsInLasso(mesh, 'edge', knownMvp(), WIDTH, HEIGHT, fullScreen);
    expect(hits.edges.length).toBe(12);
  });

  it('face mode: a screen-covering loop selects all 6 faces (by centroid)', () => {
    const mesh = makeCube();
    const hits = elementsInLasso(mesh, 'face', knownMvp(), WIDTH, HEIGHT, fullScreen);
    expect(hits.faces.length).toBe(6);
  });

  it('vert mode: a tiny loop around one projected vert selects only that vert', () => {
    const mesh = makeCube();
    const mvp = knownMvp();
    const p = projectToScreen(mesh.verts.get(6)!.co, mvp, WIDTH, HEIGHT)!;
    const tiny: Pt[] = [
      { x: p.x - 3, y: p.y - 3 },
      { x: p.x + 3, y: p.y - 3 },
      { x: p.x + 3, y: p.y + 3 },
      { x: p.x - 3, y: p.y + 3 },
    ];
    const hits = elementsInLasso(mesh, 'vert', mvp, WIDTH, HEIGHT, tiny);
    expect(hits.verts).toEqual([6]);
  });

  it('a loop over empty space selects nothing', () => {
    const mesh = makeCube();
    const empty: Pt[] = [
      { x: 2, y: 2 },
      { x: 8, y: 2 },
      { x: 8, y: 8 },
      { x: 2, y: 8 },
    ];
    const hits = elementsInLasso(mesh, 'vert', knownMvp(), WIDTH, HEIGHT, empty);
    expect(hits.verts).toEqual([]);
  });
});
