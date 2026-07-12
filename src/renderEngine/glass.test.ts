import { describe, it, expect } from 'vitest';
import { dielectricScatter } from './tracer';
import { clampIor, clampTransmission } from '../core/scene/objectData';

/** Normalize a vector in place (helper for expectations). */
function norm(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

describe('dielectric Fresnel / Snell (UR10-3)', () => {
  const out: [number, number, number] = [0, 0, 0];

  it('refracts a ray entering air→glass toward the normal (Snell)', () => {
    // Ray heading down-right into a surface with an UP normal (+Y), entering.
    // The incidence is 45°; entering a denser medium bends TOWARD the normal so
    // the refraction angle < 45°. Use u=1 to force the transmitted branch.
    const d = norm([1, -1, 0]);
    const r = dielectricScatter(d[0], d[1], d[2], 0, 1, 0, true, 1.5, 1, out);
    expect(r.refracted).toBe(true);
    expect(r.tir).toBe(false);
    // Snell: sin(θt) = sin(θi)/ior. θi=45°, ior=1.5 → sin θt = 0.4714 → θt≈28.1°.
    const sinI = Math.SQRT1_2; // sin 45°
    const expectSinT = sinI / 1.5;
    // Refracted transmission angle measured from -normal (the ray continues down).
    const nd = norm(out);
    const cosT = -nd[1]; // angle from -Y
    const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
    expect(sinT).toBeCloseTo(expectSinT, 4);
    // Transmitted ray keeps the same lateral sign (still heading +x, downward).
    expect(nd[0]).toBeGreaterThan(0);
    expect(nd[1]).toBeLessThan(0);
  });

  it('total internal reflection past the critical angle (glass→air)', () => {
    // Exiting glass (frontFace=false): critical angle for ior 1.5 is asin(1/1.5)
    // ≈ 41.8°. A 60° incidence exceeds it → TIR, no transmitted ray.
    // Ray travelling up-and-out through a surface whose stored normal is +Y.
    const theta = (60 * Math.PI) / 180;
    const d = norm([Math.sin(theta), Math.cos(theta), 0]); // heading up through +Y face
    const r = dielectricScatter(d[0], d[1], d[2], 0, 1, 0, false, 1.5, 0.0, out);
    expect(r.tir).toBe(true);
    expect(r.refracted).toBe(false);
    // Reflected ray flips the normal-component: y goes from + to −, x preserved.
    const nd = norm(out);
    expect(nd[1]).toBeLessThan(0);
    expect(nd[0]).toBeCloseTo(d[0], 6);
    expect(Number.isNaN(nd[0] + nd[1] + nd[2])).toBe(false);
  });

  it('below the critical angle glass→air DOES refract (no false TIR)', () => {
    // 30° < 41.8° critical → transmits.
    const theta = (30 * Math.PI) / 180;
    const d = norm([Math.sin(theta), Math.cos(theta), 0]);
    const r = dielectricScatter(d[0], d[1], d[2], 0, 1, 0, false, 1.5, 1, out);
    expect(r.tir).toBe(false);
    expect(r.refracted).toBe(true);
  });

  it('Fresnel reflectance rises toward grazing: u just below R0 reflects at normal incidence', () => {
    // Normal incidence, ior 1.5 → R0 = ((1.5-1)/(1.5+1))^2 = 0.04. So u=0.03
    // reflects (u < Re≈0.04), u=0.5 refracts.
    const d: [number, number, number] = [0, -1, 0]; // straight down into +Y face
    const rlow = dielectricScatter(d[0], d[1], d[2], 0, 1, 0, true, 1.5, 0.03, out);
    expect(rlow.refracted).toBe(false); // reflected
    const rhigh = dielectricScatter(d[0], d[1], d[2], 0, 1, 0, true, 1.5, 0.5, out);
    expect(rhigh.refracted).toBe(true); // refracted
  });

  it('reflection at normal incidence bounces straight back and never NaNs', () => {
    const d: [number, number, number] = [0, -1, 0];
    const r = dielectricScatter(d[0], d[1], d[2], 0, 1, 0, true, 1.45, 0.0, out);
    expect(r.refracted).toBe(false);
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[1]).toBeCloseTo(1, 6); // reflected up
    expect(out[2]).toBeCloseTo(0, 6);
  });

  it('output direction is always finite across a sweep of angles/iors', () => {
    for (const ior of [1.0, 1.33, 1.45, 1.5, 2.5]) {
      for (let a = 1; a < 90; a += 7) {
        const t = (a * Math.PI) / 180;
        const d = norm([Math.sin(t), -Math.cos(t), 0]);
        for (const front of [true, false]) {
          for (const u of [0, 0.5, 0.999]) {
            const dd = front ? d : norm([Math.sin(t), Math.cos(t), 0]);
            dielectricScatter(dd[0], dd[1], dd[2], 0, 1, 0, front, ior, u, out);
            expect(Number.isFinite(out[0] + out[1] + out[2])).toBe(true);
            expect(Math.hypot(out[0], out[1], out[2])).toBeGreaterThan(0.5);
          }
        }
      }
    }
  });
});

describe('IOR / transmission clamps (UR10-3)', () => {
  it('clamps IOR into [1, 2.5] and defaults on garbage', () => {
    expect(clampIor(1.45)).toBe(1.45);
    expect(clampIor(0.2)).toBe(1);
    expect(clampIor(9)).toBe(2.5);
    expect(clampIor(NaN)).toBe(1.45);
  });
  it('clamps transmission into [0, 1]', () => {
    expect(clampTransmission(0.5)).toBe(0.5);
    expect(clampTransmission(-1)).toBe(0);
    expect(clampTransmission(3)).toBe(1);
    expect(clampTransmission(NaN)).toBe(0);
  });
});
