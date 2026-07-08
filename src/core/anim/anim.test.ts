import { describe, it, expect } from 'vitest';
import { Scene } from '../scene/Scene';
import { makeCube } from '../mesh/primitives';
import { Vec3 } from '../math/vec3';
import { Quat } from '../math/quat';
import { Transform } from '../math/transform';
import { evalFCurve, insertKey, deleteKey, type AnimData, type FCurve } from './fcurve';
import { readChannel, writeChannel } from './channels';
import { applyAnimation } from './sampler';
import { InsertKeysCommand, DeleteKeysCommand, LOC_ROT_SCALE } from './animCommands';
import { serializeScene, applySceneJson } from '../../io/sceneJson';
import { OrbitCamera } from '../../camera/OrbitCamera';

describe('fcurve evaluation', () => {
  const curve = (interp: 'constant' | 'linear' | 'bezier'): FCurve => ({
    channelPath: 'location.x',
    keys: [
      { frame: 10, value: 0, interp },
      { frame: 20, value: 10, interp },
    ],
  });

  it('clamps outside the key range', () => {
    expect(evalFCurve(curve('linear'), 1)).toBe(0);
    expect(evalFCurve(curve('linear'), 99)).toBe(10);
  });

  it('constant steps, linear lerps', () => {
    expect(evalFCurve(curve('constant'), 15)).toBe(0);
    expect(evalFCurve(curve('linear'), 15)).toBeCloseTo(5);
  });

  it('bezier passes through keys, is smooth mid-span and monotone-ish', () => {
    const c = curve('bezier');
    expect(evalFCurve(c, 10)).toBeCloseTo(0);
    expect(evalFCurve(c, 20)).toBeCloseTo(10);
    const mid = evalFCurve(c, 15);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(10);
    // ease: slower at the ends than linear near the start key
    expect(evalFCurve(c, 11)).toBeLessThan(1.001);
  });

  it('insertKey keeps keys sorted and replaces same-frame keys', () => {
    const anim: AnimData = { fcurves: [] };
    insertKey(anim, 'location.x', 20, 2, 'linear');
    insertKey(anim, 'location.x', 10, 1, 'linear');
    const replaced = insertKey(anim, 'location.x', 20, 5, 'linear');
    expect(anim.fcurves[0].keys.map((k) => k.frame)).toEqual([10, 20]);
    expect(replaced?.value).toBe(2);
    expect(deleteKey(anim, 'location.x', 10)?.value).toBe(1);
    deleteKey(anim, 'location.x', 20);
    expect(anim.fcurves.length).toBe(0); // empty curve dropped
  });
});

describe('channels', () => {
  it('reads and writes transform channels through euler bridging', () => {
    const scene = new Scene();
    const obj = scene.add('Cube', makeCube());
    obj.transform = new Transform(new Vec3(1, 2, 3));
    expect(readChannel(scene, obj, 'location.y')).toBe(2);
    writeChannel(scene, obj, 'rotation.z', Math.PI / 2);
    expect(readChannel(scene, obj, 'rotation.z')).toBeCloseTo(Math.PI / 2);
    expect(readChannel(scene, obj, 'location.y')).toBe(2); // untouched
    expect(readChannel(scene, obj, 'light.power')).toBeNull(); // not a light
  });

  it('reads/writes light payload channels', () => {
    const scene = new Scene();
    const l = scene.addLight('Sun', 'sun');
    writeChannel(scene, l, 'light.power', 7);
    expect(readChannel(scene, l, 'light.power')).toBe(7);
    writeChannel(scene, l, 'light.color.g', 0.25);
    expect(l.light!.color[1]).toBe(0.25);
  });
});

describe('sampler', () => {
  it('applies transform curves at a frame; parented child rides along', () => {
    const scene = new Scene();
    const parent = scene.add('P', makeCube());
    const child = scene.add('C', makeCube());
    scene.setParentKeepTransform(child, parent);
    child.transform = new Transform(new Vec3(0, 1, 0));
    parent.anim = { fcurves: [] };
    insertKey(parent.anim, 'location.x', 1, 0, 'linear');
    insertKey(parent.anim, 'location.x', 11, 10, 'linear');

    applyAnimation(scene, 6);
    expect(parent.transform.position.x).toBeCloseTo(5);
    expect(scene.worldTransformOf(child).position.x).toBeCloseTo(5);
    expect(scene.worldTransformOf(child).position.y).toBeCloseTo(1);
  });

  it('unanimated channels keep their static values', () => {
    const scene = new Scene();
    const obj = scene.add('Cube', makeCube());
    obj.transform = new Transform(new Vec3(0, 0, 9), undefined, new Vec3(2, 2, 2));
    obj.anim = { fcurves: [] };
    insertKey(obj.anim, 'location.x', 1, 5, 'linear');
    applyAnimation(scene, 1);
    expect(obj.transform.position.x).toBe(5);
    expect(obj.transform.position.z).toBe(9);
    expect(obj.transform.scale.x).toBe(2);
  });
});

describe('keyframe commands', () => {
  it('InsertKeysCommand keys LocRotScale and undoes cleanly (incl. anim removal)', () => {
    const scene = new Scene();
    const obj = scene.add('Cube', makeCube());
    obj.transform = new Transform(new Vec3(3, 0, 0));
    const cmd = InsertKeysCommand.perform('Key', scene, [obj], LOC_ROT_SCALE, 1);
    expect(cmd).not.toBeNull();
    expect(obj.anim!.fcurves.length).toBe(9);
    expect(obj.anim!.fcurves.find((c) => c.channelPath === 'location.x')!.keys[0].value).toBe(3);
    cmd!.undo();
    expect(obj.anim).toBeUndefined();
    cmd!.redo();
    expect(obj.anim!.fcurves.length).toBe(9);
  });

  it('insert over an existing key restores it on undo', () => {
    const scene = new Scene();
    const obj = scene.add('Cube', makeCube());
    obj.anim = { fcurves: [] };
    insertKey(obj.anim, 'location.x', 5, 111, 'linear');
    obj.transform = new Transform(new Vec3(222, 0, 0));
    const cmd = InsertKeysCommand.perform('Key', scene, [obj], ['location.x'], 5)!;
    expect(obj.anim.fcurves[0].keys[0].value).toBe(222);
    cmd.undo();
    expect(obj.anim.fcurves[0].keys[0].value).toBe(111);
  });

  it('DeleteKeysCommand round-trips', () => {
    const scene = new Scene();
    const obj = scene.add('Cube', makeCube());
    obj.anim = { fcurves: [] };
    insertKey(obj.anim, 'location.x', 5, 1, 'bezier');
    const cmd = DeleteKeysCommand.perform('Del', scene, [{ object: obj, channelPath: 'location.x', frame: 5 }])!;
    expect(obj.anim).toBeDefined();
    expect(obj.anim!.fcurves.length).toBe(0);
    cmd.undo();
    expect(obj.anim!.fcurves[0].keys[0].value).toBe(1);
  });
});

describe('sceneJson v7 animation', () => {
  it('round-trips fcurves + frame range byte-identically', () => {
    const scene = new Scene();
    const cam = new OrbitCamera();
    const obj = scene.add('Cube', makeCube());
    obj.anim = { fcurves: [] };
    insertKey(obj.anim, 'location.x', 1, 0, 'linear');
    insertKey(obj.anim, 'location.x', 24, 4.5, 'bezier');
    scene.frameEnd = 48;
    scene.frameCurrent = 12;
    // A live app is always POSED at frameCurrent when it saves (the timeline
    // samples on scrub) — mirror that, since load re-poses at frameCurrent.
    applyAnimation(scene, scene.frameCurrent);
    const json = serializeScene(scene, cam);
    const scene2 = new Scene();
    applySceneJson(json, scene2, new OrbitCamera());
    expect(scene2.frameEnd).toBe(48);
    expect(scene2.frameCurrent).toBe(12);
    expect(scene2.objects[0].anim!.fcurves[0].keys.length).toBe(2);
    expect(serializeScene(scene2, cam)).toBe(json);
  });

  it('rejects a bad interp before mutating; loads pre-v7 files', () => {
    const scene = new Scene();
    const cam = new OrbitCamera();
    const obj = scene.add('Cube', makeCube());
    obj.anim = { fcurves: [] };
    insertKey(obj.anim, 'location.x', 1, 0, 'linear');
    const data = JSON.parse(serializeScene(scene, cam));
    data.objects[0].anim.fcurves[0].keys[0][2] = 'wiggly';
    const target = new Scene();
    target.add('Keep', makeCube());
    expect(() => applySceneJson(JSON.stringify(data), target, new OrbitCamera())).toThrow(/interp/);
    expect(target.objects.length).toBe(1);

    const old = JSON.parse(serializeScene(new SceneWithCube(), cam));
    old.version = 6;
    delete old.frameStart; delete old.frameEnd; delete old.frameCurrent;
    for (const o of old.objects) delete o.anim;
    const scene3 = new Scene();
    applySceneJson(JSON.stringify(old), scene3, new OrbitCamera());
    expect(scene3.frameEnd).toBe(120);
    expect(scene3.objects[0].anim).toBeUndefined();
  });
});

/** Tiny helper for the pre-v7 case. */
class SceneWithCube extends Scene {
  constructor() {
    super();
    this.add('Cube', makeCube());
  }
}

describe('F16-1 sampler precision', () => {
  it('location-only animation leaves the rotation quaternion IDENTICAL', () => {
    const scene = new Scene();
    const obj = scene.add('Cube', makeCube());
    const rot = Quat.fromAxisAngle(new Vec3(0.3, 0.8, 0.1).normalize(), 0.7345);
    obj.transform = new Transform(new Vec3(1, 2, 3), rot, new Vec3(1, 1, 1));
    obj.anim = { fcurves: [] };
    insertKey(obj.anim, 'location.x', 1, 0, 'linear');
    insertKey(obj.anim, 'location.x', 10, 9, 'linear');
    applyAnimation(scene, 5);
    expect(obj.transform.rotation).toBe(rot); // same object — no rebuild at all
    expect(obj.transform.position.y).toBe(2);
  });
});
