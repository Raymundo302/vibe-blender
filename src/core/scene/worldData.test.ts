import { describe, it, expect } from 'vitest';
import {
  defaultWorld,
  cloneWorld,
  averageWorldColor,
  equirectUV,
  sampleEquirect,
  type HdriImage,
  type World,
} from './worldData';
import { Scene } from './Scene';
import { OrbitCamera } from '../../camera/OrbitCamera';
import { makeCube } from '../mesh/primitives';
import { serializeScene, applySceneJson } from '../../io/sceneJson';
import { sky, worldSky } from '../../renderEngine/tracer';
import type { SnapWorld } from '../../renderEngine/snapshot';

describe('defaultWorld reproduces the pre-P10-4 sky (regression bar)', () => {
  // The tracer's ray-miss must, for the default world, equal the old sky() at
  // every direction — otherwise pre-World scenes would render differently.
  const w = defaultWorld();
  const snap: SnapWorld = {
    mode: 1,
    color: w.color,
    horizon: w.horizon,
    zenith: w.zenith,
    strength: w.strength,
    hdri: null,
  };
  const dirs: [number, number, number][] = [
    [0, 1, 0],      // straight up (zenith)
    [0, -1, 0],     // straight down (ground)
    [0.6, 0.3, -0.74], // an oblique ray
  ];
  for (const [dx, dy, dz] of dirs) {
    it(`miss color matches sky() at (${dx},${dy},${dz})`, () => {
      const a: [number, number, number] = [0, 0, 0];
      const b: [number, number, number] = [0, 0, 0];
      worldSky(snap, dx, dy, dz, a);
      sky(dy, b);
      expect(a[0]).toBeCloseTo(b[0], 12);
      expect(a[1]).toBeCloseTo(b[1], 12);
      expect(a[2]).toBeCloseTo(b[2], 12);
    });
  }
});

describe('worldSky modes', () => {
  it('flat returns color × strength', () => {
    const w: SnapWorld = { mode: 0, color: [1, 0, 0], horizon: [0, 0, 0], zenith: [0, 0, 0], strength: 2, hdri: null };
    const out: [number, number, number] = [0, 0, 0];
    worldSky(w, 0, 1, 0, out);
    expect(out).toEqual([2, 0, 0]);
  });

  it('gradient falls back for hdri with no pixels', () => {
    const w: SnapWorld = { mode: 2, color: [0, 0, 0], horizon: [0, 0, 0], zenith: [1, 1, 1], strength: 1, hdri: null };
    const out: [number, number, number] = [0, 0, 0];
    worldSky(w, 0, 1, 0, out); // dy=1 → t=1 → zenith
    expect(out[0]).toBeCloseTo(1, 6);
  });
});

describe('equirect lookup math (known pixel ↔ known direction)', () => {
  it('maps up / down to the poles (v = 0 / 1)', () => {
    expect(equirectUV(0, 1, 0).v).toBeCloseTo(0, 6);
    expect(equirectUV(0, -1, 0).v).toBeCloseTo(1, 6);
    expect(equirectUV(0, 1, 0).v).toBeLessThan(equirectUV(0, -1, 0).v);
  });

  it('maps +Z forward to u = 0.5, the horizon to v = 0.5', () => {
    const f = equirectUV(0, 0, 1);
    expect(f.u).toBeCloseTo(0.5, 6);
    expect(f.v).toBeCloseTo(0.5, 6);
  });

  it('samples the pixel a direction maps to', () => {
    // 2×2 image: top row red/green, bottom row blue/white.
    const data = new Float32Array([
      1, 0, 0,  0, 1, 0,
      0, 0, 1,  1, 1, 1,
    ]);
    const img: HdriImage = { width: 2, height: 2, data };
    const out: [number, number, number] = [0, 0, 0];
    // Straight up → v≈0 (top row). u for +Z is 0.5 → px = floor(0.5*2)=1 → green.
    sampleEquirect(img, 0, 1, 0, out);
    expect(out).toEqual([0, 1, 0]);
    // Straight down → v≈1 (bottom row, clamped to py=1) → white at px 1.
    sampleEquirect(img, 0, -1, 0, out);
    expect(out).toEqual([1, 1, 1]);
  });
});

describe('averageWorldColor', () => {
  it('flat is its own color', () => {
    const w = { ...defaultWorld(), mode: 'flat' as const, color: [0.2, 0.4, 0.6] as [number, number, number] };
    expect(averageWorldColor(w)).toEqual([0.2, 0.4, 0.6]);
  });
  it('gradient is the midpoint of horizon and zenith', () => {
    const w: World = { ...defaultWorld(), horizon: [0, 0, 0], zenith: [1, 1, 1] };
    expect(averageWorldColor(w)).toEqual([0.5, 0.5, 0.5]);
  });
});

describe('cloneWorld does not alias mutable arrays', () => {
  it('copies color triples', () => {
    const a = defaultWorld();
    const b = cloneWorld(a);
    b.color[0] = 0.9;
    b.horizon[1] = 0.9;
    expect(a.color[0]).not.toBe(0.9);
    expect(a.horizon[1]).not.toBe(0.9);
  });
});

// ---------------------------------------------------------- serialization -----

function roundTrip(world: Partial<World>): { first: string; second: string; loaded: World } {
  const scene = new Scene();
  const camera = new OrbitCamera();
  scene.add('Cube', makeCube());
  Object.assign(scene.world, world);
  const first = serializeScene(scene, camera);

  const scene2 = new Scene();
  const camera2 = new OrbitCamera();
  applySceneJson(first, scene2, camera2);
  const second = serializeScene(scene2, camera2);
  return { first, second, loaded: scene2.world };
}

describe('world serialization round-trips byte-identically', () => {
  it('flat mode', () => {
    const { first, second, loaded } = roundTrip({ mode: 'flat', color: [1, 0, 0], strength: 2.5 });
    expect(second).toBe(first);
    expect(loaded.mode).toBe('flat');
    expect(loaded.color).toEqual([1, 0, 0]);
    expect(loaded.strength).toBe(2.5);
  });

  it('gradient mode', () => {
    const { first, second, loaded } = roundTrip({ mode: 'gradient', horizon: [0.1, 0.2, 0.3], zenith: [0.4, 0.5, 0.6] });
    expect(second).toBe(first);
    expect(loaded.mode).toBe('gradient');
    expect(loaded.horizon).toEqual([0.1, 0.2, 0.3]);
    expect(loaded.zenith).toEqual([0.4, 0.5, 0.6]);
  });

  it('hdri mode: the packed data URL survives', () => {
    const url = 'data:image/png;base64,AAAABBBBCCCCDDDD==';
    const { first, second, loaded } = roundTrip({ mode: 'hdri', hdri: url });
    expect(second).toBe(first);
    expect(loaded.mode).toBe('hdri');
    expect(loaded.hdri).toBe(url);
  });
});

describe('old scenes (no world key) load with the default world', () => {
  it('a v3 file without "world" defaults to the gradient sky', () => {
    const scene = new Scene();
    const camera = new OrbitCamera();
    scene.add('Cube', makeCube());
    const json = serializeScene(scene, camera);
    // Strip the world block to simulate a pre-P10-4 file.
    const obj = JSON.parse(json);
    delete obj.world;
    const stripped = JSON.stringify(obj, null, 2);
    expect(stripped.includes('"world"')).toBe(false);

    const loaded = new Scene();
    expect(() => applySceneJson(stripped, loaded, new OrbitCamera())).not.toThrow();
    expect(loaded.world.mode).toBe('gradient');
    expect(loaded.world).toEqual(defaultWorld());
  });
});
