import { describe, it, expect } from 'vitest';
import { Scene } from '../core/scene/Scene';
import { OrbitCamera } from '../camera/OrbitCamera';
import { UndoStack } from '../core/undo/UndoStack';
import type { OperatorContext } from '../core/operator/Operator';
import { makeCube } from '../core/mesh/primitives';
import { Vec3 } from '../core/math/vec3';
import { Transform } from '../core/math/transform';
import { RotateOperator } from './rotate';
import { ScaleOperator } from './scale';
import { NumericInput } from './numericInput';

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

/** Two mirrored objects so the median (average) pivot is the origin. */
function twoMirrored(scene: Scene): { a: ReturnType<Scene['add']>; b: ReturnType<Scene['add']> } {
  const a = scene.add('A', makeCube());
  const b = scene.add('B', makeCube());
  a.transform = new Transform(new Vec3(1, 0, 0));
  b.transform = new Transform(new Vec3(-1, 0, 0));
  scene.selection.add(a.id);
  scene.selection.add(b.id);
  scene.activeId = a.id;
  return { a, b };
}

describe('RotateOperator', () => {
  it('numeric "90" with Z lock rotates (1,0,0) about the origin to (0,1,0)', () => {
    const { ctx, scene, undo } = makeCtx();
    const { a } = twoMirrored(scene);
    const before = a.transform;

    const op = new RotateOperator();
    expect(op.start(ctx, { x: 400, y: 300 })).toBe(true);
    expect(op.onKey(ctx, 'z')).toBe(true);
    expect(op.onKey(ctx, '9')).toBe(true);
    expect(op.onKey(ctx, '0')).toBe(true);

    // Position swings a quarter turn about Z.
    expect(a.transform.position.equalsApprox(new Vec3(0, 1, 0))).toBe(true);
    // Rotation is 90° about Z.
    const r = a.transform.rotation;
    const s = Math.sin(Math.PI / 4);
    expect(Math.abs(r.x)).toBeLessThan(1e-6);
    expect(Math.abs(r.y)).toBeLessThan(1e-6);
    expect(Math.abs(r.z - s)).toBeLessThan(1e-6);
    expect(Math.abs(r.w - s)).toBeLessThan(1e-6);

    op.confirm(ctx);
    // Exactly one command was pushed.
    expect(undo.undo()).toBe('Rotate');
    expect(undo.undo()).toBe(null);
    // Undo restored the original transform exactly.
    expect(a.transform.position.equalsApprox(before.position)).toBe(true);
    expect(a.transform.rotation).toBe(before.rotation);
  });

  it('cancel restores before transforms and clears the status', () => {
    const { ctx, scene, statuses } = makeCtx();
    const { a, b } = twoMirrored(scene);
    const beforeA = a.transform;
    const beforeB = b.transform;

    const op = new RotateOperator();
    op.start(ctx, { x: 400, y: 300 });
    op.onKey(ctx, 'z');
    op.onKey(ctx, '9');
    op.onKey(ctx, '0');
    // Moved away from start.
    expect(a.transform.position.equalsApprox(beforeA.position)).toBe(false);

    op.cancel(ctx);
    expect(a.transform).toBe(beforeA);
    expect(b.transform).toBe(beforeB);
    expect(statuses[statuses.length - 1]).toBe('');
  });
});

describe('ScaleOperator', () => {
  it('numeric "2" uniform doubles scale and pivot offsets', () => {
    const { ctx, scene } = makeCtx();
    const { a } = twoMirrored(scene);

    const op = new ScaleOperator();
    op.start(ctx, { x: 400, y: 300 });
    expect(op.onKey(ctx, '2')).toBe(true);

    expect(a.transform.position.equalsApprox(new Vec3(2, 0, 0))).toBe(true);
    expect(a.transform.scale.equalsApprox(new Vec3(2, 2, 2))).toBe(true);
  });

  it('axis-locked "2" on X only changes X components', () => {
    const { ctx, scene } = makeCtx();
    const { a } = twoMirrored(scene);

    const op = new ScaleOperator();
    op.start(ctx, { x: 400, y: 300 });
    expect(op.onKey(ctx, 'x')).toBe(true);
    expect(op.onKey(ctx, '2')).toBe(true);

    expect(a.transform.position.equalsApprox(new Vec3(2, 0, 0))).toBe(true);
    expect(a.transform.scale.equalsApprox(new Vec3(2, 1, 1))).toBe(true);
  });
});

describe('NumericInput', () => {
  it('builds 1.5 from "1", ".", "5"', () => {
    const n = new NumericInput();
    expect(n.handleKey('1')).toBe(true);
    expect(n.handleKey('.')).toBe(true);
    expect(n.handleKey('5')).toBe(true);
    expect(n.value).toBe(1.5);
    expect(n.text).toBe('1.5');
  });

  it('Backspace ×3 empties the buffer back to null', () => {
    const n = new NumericInput();
    n.handleKey('1');
    n.handleKey('.');
    n.handleKey('5');
    n.handleKey('Backspace');
    n.handleKey('Backspace');
    n.handleKey('Backspace');
    expect(n.text).toBe('');
    expect(n.value).toBe(null);
  });

  it('"-" toggles the sign', () => {
    const n = new NumericInput();
    n.handleKey('5');
    expect(n.value).toBe(5);
    n.handleKey('-');
    expect(n.value).toBe(-5);
    n.handleKey('-');
    expect(n.value).toBe(5);
  });
});
