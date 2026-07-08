import { describe, it, expect } from 'vitest';
import { Scene } from '../scene/Scene';
import { makeCube } from '../mesh/primitives';
import type { SceneObject } from '../scene/Scene';
import { insertKey, findCurve } from './fcurve';
import { MoveKeysCommand } from './keyEditCommands';

/** frames present on a given channel, sorted. */
function frames(obj: SceneObject, path: string): number[] {
  const c = obj.anim && findCurve(obj.anim, path);
  return c ? c.keys.map((k) => k.frame) : [];
}
function valueAt(obj: SceneObject, path: string, frame: number): number | undefined {
  const c = obj.anim && findCurve(obj.anim, path);
  return c?.keys.find((k) => k.frame === frame)?.value;
}

describe('MoveKeysCommand', () => {
  it('moves every channel keyed at a frame and round-trips on undo', () => {
    const scene = new Scene();
    const obj = scene.add('Cube', makeCube());
    obj.anim = { fcurves: [] };
    insertKey(obj.anim, 'location.x', 1, 0, 'bezier');
    insertKey(obj.anim, 'location.x', 12, 5, 'bezier');
    insertKey(obj.anim, 'location.x', 24, 10, 'bezier');
    insertKey(obj.anim, 'location.y', 12, 7, 'linear'); // a second channel at the same frame

    const cmd = MoveKeysCommand.perform('Move Keys', [{ object: obj, fromFrame: 12, toFrame: 16 }]);
    expect(cmd).not.toBeNull();

    // Both channels moved 12 -> 16; other keys untouched.
    expect(frames(obj, 'location.x')).toEqual([1, 16, 24]);
    expect(frames(obj, 'location.y')).toEqual([16]);
    expect(valueAt(obj, 'location.x', 16)).toBe(5);
    expect(valueAt(obj, 'location.y', 16)).toBe(7);

    cmd!.undo();
    expect(frames(obj, 'location.x')).toEqual([1, 12, 24]);
    expect(frames(obj, 'location.y')).toEqual([12]);
    expect(valueAt(obj, 'location.x', 12)).toBe(5);

    cmd!.redo();
    expect(frames(obj, 'location.x')).toEqual([1, 16, 24]);
    expect(valueAt(obj, 'location.x', 16)).toBe(5);
  });

  it('replaces a colliding key at the target and restores it on undo', () => {
    const scene = new Scene();
    const obj = scene.add('Cube', makeCube());
    obj.anim = { fcurves: [] };
    insertKey(obj.anim, 'location.x', 5, 100, 'linear');
    insertKey(obj.anim, 'location.x', 10, 200, 'constant');

    // Move 5 -> 10: the moved key (value 100) overwrites the key at 10 (value 200).
    const cmd = MoveKeysCommand.perform('Move Keys', [{ object: obj, fromFrame: 5, toFrame: 10 }]);
    expect(cmd).not.toBeNull();
    expect(frames(obj, 'location.x')).toEqual([10]);
    expect(valueAt(obj, 'location.x', 10)).toBe(100);

    // Undo restores BOTH the source key at 5 and the clobbered key at 10.
    cmd!.undo();
    expect(frames(obj, 'location.x')).toEqual([5, 10]);
    expect(valueAt(obj, 'location.x', 5)).toBe(100);
    expect(valueAt(obj, 'location.x', 10)).toBe(200);
    expect(findCurve(obj.anim!, 'location.x')!.keys.find((k) => k.frame === 10)!.interp).toBe('constant');

    cmd!.redo();
    expect(frames(obj, 'location.x')).toEqual([10]);
    expect(valueAt(obj, 'location.x', 10)).toBe(100);
  });

  it('moves keys across multiple objects in one command', () => {
    const scene = new Scene();
    const a = scene.add('A', makeCube());
    const b = scene.add('B', makeCube());
    a.anim = { fcurves: [] };
    b.anim = { fcurves: [] };
    insertKey(a.anim, 'location.x', 3, 1, 'linear');
    insertKey(b.anim, 'rotation.z', 3, 2, 'linear');

    const cmd = MoveKeysCommand.perform('Move Keys', [
      { object: a, fromFrame: 3, toFrame: 8 },
      { object: b, fromFrame: 3, toFrame: 8 },
    ]);
    expect(cmd).not.toBeNull();
    expect(frames(a, 'location.x')).toEqual([8]);
    expect(frames(b, 'rotation.z')).toEqual([8]);

    cmd!.undo();
    expect(frames(a, 'location.x')).toEqual([3]);
    expect(frames(b, 'rotation.z')).toEqual([3]);
  });

  it('returns null for a no-op move (same frame)', () => {
    const scene = new Scene();
    const obj = scene.add('Cube', makeCube());
    obj.anim = { fcurves: [] };
    insertKey(obj.anim, 'location.x', 5, 1, 'linear');
    expect(MoveKeysCommand.perform('Move', [{ object: obj, fromFrame: 5, toFrame: 5 }])).toBeNull();
    // Moving a frame with no keys is also a no-op.
    expect(MoveKeysCommand.perform('Move', [{ object: obj, fromFrame: 99, toFrame: 40 }])).toBeNull();
  });
});
