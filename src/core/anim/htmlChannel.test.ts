import { describe, it, expect } from 'vitest';
import { Scene } from '../scene/Scene';
import { EditableMesh } from '../mesh/EditableMesh';
import { defaultHtmlPlaneData } from '../scene/objectData';
import { readChannel, writeChannel } from './channels';

/** A mesh object carrying an HTML-plane payload. */
function htmlPlane(scene: Scene) {
  const obj = scene.add('page', new EditableMesh());
  obj.html = defaultHtmlPlaneData('file', '<div/>');
  return obj;
}

describe('html.playing channel (UR7-1)', () => {
  it('reads the boolean as 0/1', () => {
    const scene = new Scene();
    const obj = htmlPlane(scene);
    obj.html!.playing = false;
    expect(readChannel(scene, obj, 'html.playing')).toBe(0);
    obj.html!.playing = true;
    expect(readChannel(scene, obj, 'html.playing')).toBe(1);
  });

  it('writes 0/1 back to the boolean (>0.5 = playing)', () => {
    const scene = new Scene();
    const obj = htmlPlane(scene);
    expect(writeChannel(scene, obj, 'html.playing', 1)).toBe(true);
    expect(obj.html!.playing).toBe(true);
    expect(writeChannel(scene, obj, 'html.playing', 0)).toBe(true);
    expect(obj.html!.playing).toBe(false);
    // Any positive keyed value reads as on; anything <= 0.5 as off.
    writeChannel(scene, obj, 'html.playing', 0.9);
    expect(obj.html!.playing).toBe(true);
    writeChannel(scene, obj, 'html.playing', 0.3);
    expect(obj.html!.playing).toBe(false);
  });

  it('round-trips write → read for both states', () => {
    const scene = new Scene();
    const obj = htmlPlane(scene);
    for (const v of [1, 0]) {
      writeChannel(scene, obj, 'html.playing', v);
      expect(readChannel(scene, obj, 'html.playing')).toBe(v);
    }
  });

  it('no-ops for objects without an html payload', () => {
    const scene = new Scene();
    const obj = scene.add('plain', new EditableMesh());
    expect(readChannel(scene, obj, 'html.playing')).toBeNull();
    expect(writeChannel(scene, obj, 'html.playing', 1)).toBe(false);
  });

  it('rejects an unknown html sub-channel', () => {
    const scene = new Scene();
    const obj = htmlPlane(scene);
    expect(readChannel(scene, obj, 'html.nope')).toBeNull();
    expect(writeChannel(scene, obj, 'html.nope', 1)).toBe(false);
  });
});
