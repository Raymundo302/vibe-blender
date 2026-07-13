import { describe, it, expect } from 'vitest';
import { prepareScene, renderSample } from './tracer';
import { tonemapAccumToRgba } from './renderWindow';
import type { Snapshot, SnapMaterial, SnapCamera } from './snapshot';

/**
 * UR16-3 — transparent film (alpha coverage) math. The CPU tracer, when the
 * snapshot's `transparent` flag is set, must:
 *   - leave a PRIMARY-ray miss with 0 coverage AND no world backdrop radiance,
 *   - mark a PRIMARY-ray hit with coverage 1,
 * and the render-window tonemap must turn summed coverage into a STRAIGHT-alpha
 * byte (miss → 0, full → 255).
 */

const bright: SnapMaterial = {
  baseColor: [0.8, 0.1, 0.1], metallic: 0, roughness: 0.5,
  emissive: [1, 1, 1], emissiveStrength: 3, // shadeless-ish glow so RGB is nonzero
  shadeless: true,
};

// A small quad floating in the CENTER of the frame at z = -2 (camera looks -Z).
function centeredQuad(half: number): number[] {
  return [
    -half, -half, -2, half, half, -2, half, -half, -2,
    -half, -half, -2, -half, half, -2, half, half, -2,
  ];
}

const cam: SnapCamera = {
  position: [0, 0, 3], forward: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0],
  fovY: Math.PI / 3,
};

function makeSnap(transparent: boolean): Snapshot {
  return {
    tris: new Float32Array(centeredQuad(0.4)),
    triMat: Int32Array.from([0, 0]),
    materials: [bright],
    lights: [],
    camera: cam,
    // Non-black world so a leaked backdrop would be obvious.
    world: { mode: 0, color: [0.5, 0.5, 0.5], horizon: [0.5, 0.5, 0.5], zenith: [0.5, 0.5, 0.5], strength: 1, hdri: null },
    transparent,
  };
}

const W = 16, H = 16, PASSES = 8;

describe('transparent film — coverage + straight alpha (UR16-3)', () => {
  it('primary miss has 0 coverage & no backdrop; primary hit has full coverage', () => {
    const scene = prepareScene(makeSnap(true));
    expect(scene.transparent).toBe(true);
    const accum = new Float32Array(W * H * 3);
    const cov = new Float32Array(W * H);
    for (let s = 0; s < PASSES; s++) renderSample(scene, accum, W, H, s, 0x1234567, cov);

    const center = (H / 2) * W + W / 2;
    const corner = 0;
    // Center pixel sits on the quad → covered every pass.
    expect(cov[center]).toBeCloseTo(PASSES, 5);
    // Corner escaped to the world → 0 coverage AND 0 radiance (backdrop skipped).
    expect(cov[corner]).toBe(0);
    expect(accum[corner * 3]).toBe(0);
    expect(accum[corner * 3 + 1]).toBe(0);
    expect(accum[corner * 3 + 2]).toBe(0);
  });

  it('opaque render (transparent off) keeps the world backdrop, no coverage', () => {
    const scene = prepareScene(makeSnap(false));
    expect(scene.transparent).toBe(false);
    const accum = new Float32Array(W * H * 3);
    for (let s = 0; s < PASSES; s++) renderSample(scene, accum, W, H, s, 0x1234567);
    // Corner sees the grey world → nonzero radiance.
    expect(accum[0]).toBeGreaterThan(0);
  });

  it('tonemap writes straight alpha: covered → 255, uncovered → 0', () => {
    const scene = prepareScene(makeSnap(true));
    const accum = new Float32Array(W * H * 3);
    const cov = new Float32Array(W * H);
    for (let s = 0; s < PASSES; s++) renderSample(scene, accum, W, H, s, 0x1234567, cov);
    const out = new Uint8ClampedArray(W * H * 4);
    tonemapAccumToRgba(accum, PASSES, out, { width: W, height: H, glare: null, coverage: cov });

    const center = (H / 2) * W + W / 2;
    expect(out[center * 4 + 3]).toBe(255); // fully covered
    expect(out[0 * 4 + 3]).toBe(0);        // corner miss
    // Straight alpha: the covered pixel still carries a real (nonzero) color.
    expect(out[center * 4] + out[center * 4 + 1] + out[center * 4 + 2]).toBeGreaterThan(0);
    // The uncovered pixel is transparent-black.
    expect(out[0]).toBe(0);
  });
});
