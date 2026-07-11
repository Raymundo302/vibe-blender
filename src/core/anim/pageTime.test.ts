import { describe, it, expect } from 'vitest';
import { pageTime, pageTimePure, samplePlaying, pageTimeRebuildCount } from './pageTime';
import { insertKey, type AnimData, type FCurve } from './fcurve';

/** A constant-interp html.playing curve from [frame, on] pairs. */
function playingCurve(pairs: [number, number][]): FCurve {
  const anim: AnimData = { fcurves: [] };
  for (const [f, on] of pairs) insertKey(anim, 'html.playing', f, on, 'constant');
  return anim.fcurves[0];
}

describe('samplePlaying', () => {
  it('uses the static flag when the channel is unkeyed', () => {
    expect(samplePlaying(undefined, true, 5)).toBe(1);
    expect(samplePlaying(undefined, false, 5)).toBe(0);
  });

  it('samples a keyed curve with constant interpretation (>0.5 = on)', () => {
    const c = playingCurve([[1, 0], [10, 1]]);
    expect(samplePlaying(c, false, 1)).toBe(0);
    expect(samplePlaying(c, false, 9)).toBe(0);
    expect(samplePlaying(c, false, 10)).toBe(1);
    expect(samplePlaying(c, false, 40)).toBe(1);
  });
});

describe('pageTimePure — the integral', () => {
  const fps = 24;
  const start = 1;

  it('is zero at/before frameStart and for the whole off span', () => {
    const c = playingCurve([[1, 0], [10, 1]]);
    expect(pageTimePure(c, false, fps, start, 1)).toBe(0);
    expect(pageTimePure(c, false, fps, start, 5)).toBe(0);
    // frame 10: sum over k=1..9, all off → still 0.
    expect(pageTimePure(c, false, fps, start, 10)).toBe(0);
    // frames 5 and 9 are IDENTICAL page-clocks (the "frozen page" property).
    expect(pageTimePure(c, false, fps, start, 5)).toBe(pageTimePure(c, false, fps, start, 9));
  });

  it('accumulates 1/fps per on-frame once Play is keyed on', () => {
    const c = playingCurve([[1, 0], [10, 1]]);
    // frame 40: on for k=10..39 → 30 frames.
    expect(pageTimePure(c, false, fps, start, 40)).toBeCloseTo(30 / 24, 10);
    // frame 11: on for k=10 only → 1/24.
    expect(pageTimePure(c, false, fps, start, 11)).toBeCloseTo(1 / 24, 10);
  });

  it('handles on/off/on spans (integrates only the on frames)', () => {
    // on at 1, off at 5, on again at 8.
    const c = playingCurve([[1, 1], [5, 0], [8, 1]]);
    // frame 12: on k=1..4 (4) + off k=5..7 + on k=8..11 (4) = 8 frames.
    expect(pageTimePure(c, false, fps, start, 12)).toBeCloseTo(8 / 24, 10);
  });

  it('respects fractional fps', () => {
    const c = playingCurve([[1, 1]]); // always on
    // frame 10: k=1..9 = 9 on frames, at 7.5 fps → 1.2s.
    expect(pageTimePure(c, false, 7.5, start, 10)).toBeCloseTo(9 / 7.5, 10);
  });

  it('honors a non-1 frameStart', () => {
    const c = playingCurve([[5, 1]]);
    // frameStart 5: frame 5 → 0 (empty sum), frame 8 → k=5..7 = 3 on.
    expect(pageTimePure(c, false, fps, 5, 5)).toBe(0);
    expect(pageTimePure(c, false, fps, 5, 8)).toBeCloseTo(3 / 24, 10);
  });

  it('uses the static flag for an unkeyed plane', () => {
    expect(pageTimePure(undefined, true, fps, start, 25)).toBeCloseTo(24 / 24, 10);
    expect(pageTimePure(undefined, false, fps, start, 25)).toBe(0);
  });
});

describe('pageTime — cached, matches the pure integral', () => {
  const fps = 24;
  const start = 1;

  it('returns 0 for a target with no html payload', () => {
    expect(pageTime({}, 40, fps, start)).toBe(0);
  });

  it('agrees with pageTimePure across a scrub range', () => {
    const c = playingCurve([[1, 0], [10, 1]]);
    const target = { anim: { fcurves: [c] }, html: { playing: false } };
    for (const f of [1, 5, 9, 10, 11, 25, 40]) {
      expect(pageTime(target, f, fps, start)).toBeCloseTo(pageTimePure(c, false, fps, start, f), 10);
    }
  });

  it('caches: a second scrub of the same curve does NOT rebuild the prefix sums', () => {
    const c = playingCurve([[1, 0], [10, 1]]);
    const target = { anim: { fcurves: [c] }, html: { playing: false } };
    pageTime(target, 40, fps, start); // first touch → one rebuild
    const before = pageTimeRebuildCount();
    for (const f of [5, 9, 10, 20, 40]) pageTime(target, f, fps, start);
    expect(pageTimeRebuildCount()).toBe(before); // no rebuilds — pure lookups
  });

  it('invalidates on a curve edit (a new key changes the result AND rebuilds)', () => {
    const anim: AnimData = { fcurves: [] };
    insertKey(anim, 'html.playing', 1, 0, 'constant');
    insertKey(anim, 'html.playing', 10, 1, 'constant');
    const target = { anim, html: { playing: false } };
    const t40a = pageTime(target, 40, fps, start);
    expect(t40a).toBeCloseTo(30 / 24, 10);
    const before = pageTimeRebuildCount();
    // Move the "on" key earlier — more on-frames accumulate by frame 40.
    insertKey(anim, 'html.playing', 5, 1, 'constant');
    const t40b = pageTime(target, 40, fps, start);
    expect(pageTimeRebuildCount()).toBeGreaterThan(before); // rebuilt
    expect(t40b).toBeCloseTo(35 / 24, 10); // on for k=5..39 = 35
    expect(t40b).not.toBeCloseTo(t40a, 6);
  });

  it('invalidates when fps or frameStart changes', () => {
    const c = playingCurve([[1, 1]]);
    const target = { anim: { fcurves: [c] }, html: { playing: true } };
    pageTime(target, 10, 24, 1);
    const before = pageTimeRebuildCount();
    pageTime(target, 10, 12, 1); // fps change → rebuild
    expect(pageTimeRebuildCount()).toBeGreaterThan(before);
    const mid = pageTimeRebuildCount();
    pageTime(target, 10, 12, 3); // frameStart change → rebuild
    expect(pageTimeRebuildCount()).toBeGreaterThan(mid);
  });
});
