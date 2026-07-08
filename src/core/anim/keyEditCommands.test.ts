import { describe, it, expect } from 'vitest';
import { Scene } from '../scene/Scene';
import { makeCube } from '../mesh/primitives';
import type { SceneObject } from '../scene/Scene';
import { insertKey, findCurve } from './fcurve';
import { MoveKeysCommand, SetKeyInterpCommand } from './keyEditCommands';

/** frames present on a given channel, sorted. */
function frames(obj: SceneObject, path: string): number[] {
  const c = obj.anim && findCurve(obj.anim, path);
  return c ? c.keys.map((k) => k.frame) : [];
}
function valueAt(obj: SceneObject, path: string, frame: number): number | undefined {
  const c = obj.anim && findCurve(obj.anim, path);
  return c?.keys.find((k) => k.frame === frame)?.value;
}
function interpAt(obj: SceneObject, path: string, frame: number): string | undefined {
  const c = obj.anim && findCurve(obj.anim, path);
  return c?.keys.find((k) => k.frame === frame)?.interp;
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

  it('channelPaths restricts a move to the named channel only', () => {
    const scene = new Scene();
    const obj = scene.add('Cube', makeCube());
    obj.anim = { fcurves: [] };
    insertKey(obj.anim, 'location.x', 10, 1, 'bezier');
    insertKey(obj.anim, 'location.y', 10, 2, 'bezier'); // same frame, other channel

    const cmd = MoveKeysCommand.perform('Move', [
      { object: obj, fromFrame: 10, toFrame: 15, channelPaths: ['location.x'] },
    ]);
    expect(cmd).not.toBeNull();
    // Only location.x moved; location.y untouched at 10.
    expect(frames(obj, 'location.x')).toEqual([15]);
    expect(frames(obj, 'location.y')).toEqual([10]);

    cmd!.undo();
    expect(frames(obj, 'location.x')).toEqual([10]);
    expect(frames(obj, 'location.y')).toEqual([10]);
  });
});

describe('SetKeyInterpCommand', () => {
  it('round-trips with mixed before-values', () => {
    const scene = new Scene();
    const obj = scene.add('Cube', makeCube());
    obj.anim = { fcurves: [] };
    // Three keys with THREE different starting interps.
    insertKey(obj.anim, 'location.x', 1, 0, 'constant');
    insertKey(obj.anim, 'location.y', 1, 0, 'linear');
    insertKey(obj.anim, 'location.z', 1, 0, 'bezier');

    const cmd = SetKeyInterpCommand.perform('Set Interp', [
      { object: obj, channelPath: 'location.x', frame: 1 },
      { object: obj, channelPath: 'location.y', frame: 1 },
      { object: obj, channelPath: 'location.z', frame: 1 },
    ], 'linear');
    expect(cmd).not.toBeNull();

    // All three now linear.
    expect(interpAt(obj, 'location.x', 1)).toBe('linear');
    expect(interpAt(obj, 'location.y', 1)).toBe('linear');
    expect(interpAt(obj, 'location.z', 1)).toBe('linear');

    // Undo restores EACH key's original (mixed) interp.
    cmd!.undo();
    expect(interpAt(obj, 'location.x', 1)).toBe('constant');
    expect(interpAt(obj, 'location.y', 1)).toBe('linear');
    expect(interpAt(obj, 'location.z', 1)).toBe('bezier');

    cmd!.redo();
    expect(interpAt(obj, 'location.x', 1)).toBe('linear');
    expect(interpAt(obj, 'location.y', 1)).toBe('linear');
    expect(interpAt(obj, 'location.z', 1)).toBe('linear');
  });

  it('skips keys already at the target interp, and returns null for a pure no-op', () => {
    const scene = new Scene();
    const obj = scene.add('Cube', makeCube());
    obj.anim = { fcurves: [] };
    insertKey(obj.anim, 'location.x', 1, 0, 'linear');   // already linear
    insertKey(obj.anim, 'location.y', 1, 0, 'constant'); // will change

    const cmd = SetKeyInterpCommand.perform('Set Interp', [
      { object: obj, channelPath: 'location.x', frame: 1 },
      { object: obj, channelPath: 'location.y', frame: 1 },
    ], 'linear');
    expect(cmd).not.toBeNull();
    expect(interpAt(obj, 'location.y', 1)).toBe('linear');

    // Undo only touches the one that changed.
    cmd!.undo();
    expect(interpAt(obj, 'location.x', 1)).toBe('linear');
    expect(interpAt(obj, 'location.y', 1)).toBe('constant');

    // Everything already linear → nothing to do.
    insertKey(obj.anim, 'location.y', 1, 0, 'linear');
    expect(SetKeyInterpCommand.perform('Set Interp', [
      { object: obj, channelPath: 'location.x', frame: 1 },
      { object: obj, channelPath: 'location.y', frame: 1 },
    ], 'linear')).toBeNull();
  });
});
