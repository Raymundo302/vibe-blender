import { describe, it, expect } from 'vitest';
import { rgbToHex, hexToRgb, cloneLight, LightCommand } from './lightTab';
import { Scene } from '../core/scene/Scene';
import type { LightData } from '../core/scene/objectData';

describe('lightTab hex ↔ rgb', () => {
  it('round-trips a set of hex colors through rgb and back', () => {
    for (const hex of ['#000000', '#ffffff', '#ff8000', '#3a7bd5', '#010203']) {
      expect(rgbToHex(hexToRgb(hex))).toBe(hex);
    }
  });

  it('clamps out-of-range rgb before formatting', () => {
    expect(rgbToHex([-0.5, 2, 0.5])).toBe('#00ff80');
  });

  it('maps pure channels to expected floats', () => {
    expect(hexToRgb('#ff0000')).toEqual([1, 0, 0]);
    expect(hexToRgb('#00ff00')).toEqual([0, 1, 0]);
    expect(hexToRgb('#0000ff')).toEqual([0, 0, 1]);
  });
});

describe('cloneLight', () => {
  it('deep-copies the color triple (no shared reference)', () => {
    const l: LightData = { type: 'spot', color: [0.2, 0.4, 0.6], power: 50, spotAngle: 1, spotBlend: 0.3 };
    const c = cloneLight(l);
    expect(c).toEqual(l);
    c.color[0] = 0.9;
    expect(l.color[0]).toBe(0.2);
  });
});

describe('LightCommand undo/redo', () => {
  it('restores the exact prior LightData on undo and re-applies on redo', () => {
    const scene = new Scene();
    const obj = scene.addLight('Point', 'point');
    const before = cloneLight(obj.light!);

    const cmd = LightCommand.capture('Edit', obj, (l) => {
      l.type = 'spot';
      l.color = [0.1, 0.2, 0.3];
      l.power = 12;
      l.spotAngle = 0.75;
      l.spotBlend = 0.4;
    });

    // Mutation applied by capture().
    expect(obj.light).toEqual({
      type: 'spot', color: [0.1, 0.2, 0.3], power: 12, spotAngle: 0.75, spotBlend: 0.4,
    });

    cmd.undo();
    expect(obj.light).toEqual(before);

    cmd.redo();
    expect(obj.light).toEqual({
      type: 'spot', color: [0.1, 0.2, 0.3], power: 12, spotAngle: 0.75, spotBlend: 0.4,
    });
  });

  it('undo snapshot is independent of later live mutations', () => {
    const scene = new Scene();
    const obj = scene.addLight('Point', 'point');
    const cmd = LightCommand.capture('Edit', obj, (l) => { l.power = 5; });
    // Mutate the live light after the command was captured.
    obj.light!.power = 999;
    cmd.undo();
    expect(obj.light!.power).toBe(100); // defaultLight('point').power
  });
});
