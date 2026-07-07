import { describe, it, expect } from 'vitest';
import {
  prepareScene,
  traceRay,
  mulberry32,
  sampleMaterialTexture,
  sampleImageBilinear,
} from './tracer';
import type { Snapshot, SnapMaterial, SnapLight, SnapCamera } from './snapshot';
import { Scene } from '../core/scene/Scene';
import { OrbitCamera } from '../camera/OrbitCamera';
import { makeCube } from '../core/mesh/primitives';
import { serializeScene, applySceneJson } from '../io/sceneJson';

// A dummy camera — the texture tests drive traceRay directly, not renderSample.
const CAMERA: SnapCamera = {
  position: [0, 5, 0],
  forward: [0, -1, 0],
  right: [1, 0, 0],
  up: [0, 0, -1],
  fovY: 1,
};

/** A flat unit quad in the y=0 plane, normal +Y, UVs = ((x+1)/2, (z+1)/2). */
function quadSnapshot(material: SnapMaterial): Snapshot {
  // A(-1,0,1) B(1,0,1) C(1,0,-1) D(-1,0,-1); tri0 = A,B,C  tri1 = A,C,D.
  const A = [-1, 0, 1], B = [1, 0, 1], C = [1, 0, -1], D = [-1, 0, -1];
  const uv = (p: number[]) => [(p[0] + 1) / 2, (p[2] + 1) / 2];
  const tris = new Float32Array([...A, ...B, ...C, ...A, ...C, ...D]);
  const triUV = new Float32Array([
    ...uv(A), ...uv(B), ...uv(C),
    ...uv(A), ...uv(C), ...uv(D),
  ]);
  const sun: SnapLight = {
    type: 1,
    position: [0, 0, 0],
    direction: [0, -1, 0], // straight down: L toward the sun = +Y = the quad normal
    energy: [10, 10, 10],
    cosInner: 1,
    cosOuter: 0,
    radius: 0,
  };
  return {
    tris,
    triMat: Int32Array.from([0, 0]),
    triUV,
    materials: [material],
    lights: [sun],
    camera: CAMERA,
    // Flat BLACK world so a missed bounce ray contributes nothing → the only
    // radiance is the first hit's direct lighting = albedo·energy·NdotL/π,
    // making the checker contrast exact and RNG-independent.
    world: { mode: 0, color: [0, 0, 0], horizon: [0, 0, 0], zenith: [0, 0, 0], strength: 1, hdri: null },
  };
}

const checkerMat: SnapMaterial = {
  baseColor: [1, 1, 1], metallic: 0, roughness: 1,
  emissive: [0, 0, 0], emissiveStrength: 0, texKind: 'checker',
};

describe('checker texture sampling', () => {
  it('alternates between the two checker colors across 8×8 cells', () => {
    const dark = sampleMaterialTexture(checkerMat, 0.75, 0.5); // cell (6,4) sum10 even
    const light = sampleMaterialTexture(checkerMat, 0.375, 0.5); // cell (3,4) sum7 odd
    expect(dark[0]).toBeCloseTo(0.2, 6);
    expect(light[0]).toBeCloseTo(1.0, 6);
  });

  it('two rays hitting different UV cells return alternating (light/dark) radiance', () => {
    const scene = prepareScene(quadSnapshot(checkerMat));
    const out: [number, number, number] = [0, 0, 0];
    // P1 = (0.5, 0) → u=0.75 → dark cell; P2 = (-0.25, 0) → u=0.375 → light cell.
    traceRay(scene, 0.5, 5, 0, 0, -1, 0, mulberry32(1), out);
    const darkR = out[0];
    traceRay(scene, -0.25, 5, 0, 0, -1, 0, mulberry32(1), out);
    const lightR = out[0];
    expect(darkR).toBeCloseTo((0.2 * 10) / Math.PI, 4);
    expect(lightR).toBeCloseTo((1.0 * 10) / Math.PI, 4);
    expect(lightR).toBeGreaterThan(darkR * 2);
  });
});

describe('image texture sampling', () => {
  // 2×2 test image, row 0 = top: (0,0)=red (1,0)=green (0,1)=blue (1,1)=white.
  const img = {
    width: 2, height: 2,
    pixels: new Float32Array([1, 0, 0, 0, 1, 0,   0, 0, 1, 1, 1, 1]),
  };
  const imageMat: SnapMaterial = {
    baseColor: [1, 1, 1], metallic: 0, roughness: 1,
    emissive: [0, 0, 0], emissiveStrength: 0, texKind: 'image', texImage: img,
  };

  it('bilinear sample at texel centers returns each corner color exactly', () => {
    const out: [number, number, number] = [0, 0, 0];
    sampleImageBilinear(img, 0.25, 0.25, out); expect([...out]).toEqual([1, 0, 0]); // red
    sampleImageBilinear(img, 0.75, 0.25, out); expect([...out]).toEqual([0, 1, 0]); // green
    sampleImageBilinear(img, 0.25, 0.75, out); expect([...out]).toEqual([0, 0, 1]); // blue
    sampleImageBilinear(img, 0.75, 0.75, out); expect([...out]).toEqual([1, 1, 1]); // white
  });

  it('sampleMaterialTexture routes image materials through the image', () => {
    expect(sampleMaterialTexture(imageMat, 0.25, 0.25)).toEqual([1, 0, 0]);
  });

  it('image material with no decoded pixels samples white (no tint)', () => {
    const noPixels: SnapMaterial = { ...imageMat, texImage: null };
    expect(sampleMaterialTexture(noPixels, 0.25, 0.25)).toEqual([1, 1, 1]);
  });

  it("'none' materials multiply by white (unchanged albedo)", () => {
    const none: SnapMaterial = { ...checkerMat, texKind: 'none' };
    expect(sampleMaterialTexture(none, 0.3, 0.7)).toEqual([1, 1, 1]);
  });
});

describe('material texture serialization', () => {
  it('texKind / texDataUrl round-trip byte-identically', () => {
    const scene = new Scene();
    const camera = new OrbitCamera();
    const obj = scene.add('Cube', makeCube());
    const chk = scene.addMaterial('Checker');
    chk.texKind = 'checker';
    obj.materialId = chk.id;
    const pic = scene.addMaterial('Pic');
    pic.texKind = 'image';
    pic.texDataUrl = 'data:image/png;base64,ABCD';

    const s1 = serializeScene(scene, camera);
    applySceneJson(s1, scene, camera);
    expect(serializeScene(scene, camera)).toBe(s1);
    expect(scene.materials[0].texKind).toBe('checker');
    expect(scene.materials[1].texKind).toBe('image');
    expect(scene.materials[1].texDataUrl).toBe('data:image/png;base64,ABCD');
  });
});
