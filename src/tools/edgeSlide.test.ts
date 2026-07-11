import { describe, it, expect } from 'vitest';
import { Scene } from '../core/scene/Scene';
import { OrbitCamera } from '../camera/OrbitCamera';
import { UndoStack } from '../core/undo/UndoStack';
import type { OperatorContext } from '../core/operator/Operator';
import { EditableMesh } from '../core/mesh/EditableMesh';
import { Vec3 } from '../core/math/vec3';
import {
  pickRails,
  slidePosition,
  railGuideSegments,
  projectScreenRail,
  pickSlideT,
  EdgeSlideOperator,
  type Rail,
} from './edgeSlide';

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

  it('t>1 extrapolates PAST the far vert, collinearly (UR4-2)', () => {
    // Rail A is +X len 1, far vert at x=2. t=1.5 → x = 1 + 1.5 = 2.5, past it,
    // on the same line (y,z unchanged).
    const p = slidePosition(base, rails, 1.5);
    expect(p.x).toBeCloseTo(2.5, 6);
    expect(p.y).toBeCloseTo(0, 6);
    expect(p.z).toBeCloseTo(0, 6);
    // Collinear with base→far: the far vert (2,0,0) lies on the base→p segment.
    const far = mesh.verts.get(4)!.co; // +X neighbour
    const dir = p.sub(base).normalize();
    expect(far.sub(base).normalize().equalsApprox(dir)).toBe(true);
    // t=3 keeps extrapolating linearly.
    expect(slidePosition(base, rails, 3).x).toBeCloseTo(4, 6);
  });

  it('a single-rail vert only slides for the matching (positive) sign', () => {
    const one = { a: rails.a, b: null };
    expect(slidePosition(base, one, 0.5).x).toBeCloseTo(1.5, 6);
    expect(slidePosition(base, one, -0.5).equalsApprox(base)).toBe(true);
  });
});

describe('railGuideSegments', () => {
  const mesh = quadStrip();
  const rails = pickRails(mesh, 2, new Set([2, 3]));
  const base = mesh.verts.get(2)!.co; // (1, 0, 0)

  it('spans a rail ±2·dir·len about base (both rails)', () => {
    const segs = railGuideSegments(base, rails);
    expect(segs).toHaveLength(2);
    // Rail A (+X, len 1): base(1,0,0) ± 2 → (-1,0,0) → (3,0,0).
    expect(segs[0].a.equalsApprox(new Vec3(-1, 0, 0))).toBe(true);
    expect(segs[0].b.equalsApprox(new Vec3(3, 0, 0))).toBe(true);
    // Rail B (-X, len 1): base ∓ 2 → (3,0,0) → (-1,0,0).
    expect(segs[1].a.equalsApprox(new Vec3(3, 0, 0))).toBe(true);
    expect(segs[1].b.equalsApprox(new Vec3(-1, 0, 0))).toBe(true);
  });

  it('a single-rail vert yields exactly one segment', () => {
    const segs = railGuideSegments(base, { a: rails.a, b: null });
    expect(segs).toHaveLength(1);
    expect(segs[0].a.equalsApprox(new Vec3(-1, 0, 0))).toBe(true);
    expect(segs[0].b.equalsApprox(new Vec3(3, 0, 0))).toBe(true);
  });

  it('a zero-rail vert yields no segments', () => {
    expect(railGuideSegments(base, { a: null, b: null })).toHaveLength(0);
  });
});

describe('proximity rail pick (projectScreenRail + pickSlideT)', () => {
  // Synthetic projector: local (x,y,z) → screen; base at (100,100), 100px / unit.
  const project = (p: Vec3) => ({ x: 100 + p.x * 100, y: 100 + p.y * 100 });
  const base = new Vec3(0, 0, 0);
  const railA: Rail = { farId: 1, dir: new Vec3(1, 0, 0), length: 1 }; // +X screen
  const railB: Rail = { farId: 2, dir: new Vec3(0, 1, 0), length: 1 }; // +Y screen (divergent corner)

  const sa = projectScreenRail(base, railA, project)!;
  const sb = projectScreenRail(base, railB, project)!;

  it('projects a rail to origin + unit screen dir + length', () => {
    expect(sa).toEqual({ ox: 100, oy: 100, dx: 1, dy: 0, len: 100 });
    expect(sb).toEqual({ ox: 100, oy: 100, dx: 0, dy: 1, len: 100 });
  });

  it('excludes a rail that projects to a point (< 2px)', () => {
    const pt = (_: Vec3) => ({ x: 100, y: 100 }); // everything collapses to base
    expect(projectScreenRail(base, railA, pt)).toBe(null);
  });

  it('returns null for a missing rail', () => {
    expect(projectScreenRail(base, null, project)).toBe(null);
  });

  it('a point near rail A picks A → positive t', () => {
    const t = pickSlideT(sa, sb, 150, 105); // hugging the +X line
    expect(t).toBeCloseTo(0.5, 6);
  });

  it('a point near rail B picks B → negative t', () => {
    const t = pickSlideT(sa, sb, 105, 150); // hugging the +Y line
    expect(t).toBeCloseTo(-0.5, 6);
  });

  it('collinear rails: the projection sign alone chooses the side', () => {
    const railBopp: Rail = { farId: 2, dir: new Vec3(-1, 0, 0), length: 1 }; // -X (opposite A)
    const sBopp = projectScreenRail(base, railBopp, project)!;
    // +X side → toward rail A (t > 0).
    expect(pickSlideT(sa, sBopp, 160, 100)).toBeCloseTo(0.6, 6);
    // -X side → toward rail B (t < 0), even though the tie picks rail A's math.
    expect(pickSlideT(sa, sBopp, 60, 100)).toBeCloseTo(-0.4, 6);
  });

  it('no rails → null (t stays put)', () => {
    expect(pickSlideT(null, null, 150, 105)).toBe(null);
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

  it('guideSegments() is null before start and holds one segment per rail after', () => {
    const { ctx, scene } = makeCtx();
    stripInEditMode(scene);

    const op = new EdgeSlideOperator();
    expect(op.guideSegments()).toBe(null);
    op.start(ctx, { x: 400, y: 300 });
    // Verts 2 and 3 each have two rails (±X) → 4 world-space segments. The strip
    // object sits at the origin (identity world matrix), so world == local.
    const segs = op.guideSegments();
    expect(segs).not.toBe(null);
    expect(segs!).toHaveLength(4);
    // Vert 2 base (1,0,0), +X rail ±2 → (-1,0,0) → (3,0,0).
    const hasV2PlusX = segs!.some(
      (s) => s.a.equalsApprox(new Vec3(-1, 0, 0)) && s.b.equalsApprox(new Vec3(3, 0, 0)),
    );
    expect(hasV2PlusX).toBe(true);
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
