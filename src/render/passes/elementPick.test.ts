import { describe, it, expect } from 'vitest';
import {
  VERT_PICK_BASE,
  EDGE_PICK_BASE,
  FACE_PICK_BASE,
  decodePick,
  closestNonZeroId,
} from './elementPickPass';
import type { ElementIndexMaps } from '../../core/mesh/editOverlayData';

const maps: ElementIndexMaps = {
  vertIds: [7, 11, 13],
  edgeKeys: ['0,1', '1,2', '2,3'],
  faceIds: [42, 43],
};

/** Build a single RGBA pixel little-endian, matching encodeId/decodeId. */
function rgba(id: number): [number, number, number, number] {
  return [id & 0xff, (id >> 8) & 0xff, (id >> 16) & 0xff, 255];
}

describe('element pick id encode/decode round-trips', () => {
  it('decodes vert ids from VERT_PICK_BASE + idx', () => {
    maps.vertIds.forEach((vid, idx) => {
      expect(decodePick(VERT_PICK_BASE + idx, maps)).toEqual({ kind: 'vert', id: vid });
    });
  });

  it('decodes edge keys from EDGE_PICK_BASE + idx', () => {
    maps.edgeKeys.forEach((key, idx) => {
      expect(decodePick(EDGE_PICK_BASE + idx, maps)).toEqual({ kind: 'edge', key });
    });
  });

  it('decodes face ids from FACE_PICK_BASE + idx', () => {
    maps.faceIds.forEach((fid, idx) => {
      expect(decodePick(FACE_PICK_BASE + idx, maps)).toEqual({ kind: 'face', id: fid });
    });
  });

  it('returns null for background and out-of-range indices', () => {
    expect(decodePick(0, maps)).toBeNull();
    expect(decodePick(VERT_PICK_BASE + 99, maps)).toBeNull();
    expect(decodePick(EDGE_PICK_BASE + 99, maps)).toBeNull();
    expect(decodePick(FACE_PICK_BASE + 99, maps)).toBeNull();
  });

  it('keeps the three namespaces disjoint', () => {
    expect(VERT_PICK_BASE).toBeLessThan(EDGE_PICK_BASE);
    expect(EDGE_PICK_BASE).toBeLessThan(FACE_PICK_BASE);
  });
});

describe('closestNonZeroId region scan', () => {
  const W = 9;
  const H = 9;

  function region(entries: Array<{ c: number; r: number; id: number }>): Uint8Array {
    const buf = new Uint8Array(W * H * 4);
    for (const { c, r, id } of entries) {
      buf.set(rgba(id), (r * W + c) * 4);
    }
    return buf;
  }

  it('takes the exact-center hit when present', () => {
    const buf = region([
      { c: 4, r: 4, id: 500 },
      { c: 0, r: 0, id: 999 },
    ]);
    expect(closestNonZeroId(buf, W, H, 4, 4)).toBe(500);
  });

  it('prefers the nearer of two off-center hits (Chebyshev)', () => {
    // near hit at distance 1, far hit at distance 3
    const buf = region([
      { c: 5, r: 4, id: 111 },
      { c: 7, r: 4, id: 222 },
    ]);
    expect(closestNonZeroId(buf, W, H, 4, 4)).toBe(111);
  });

  it('returns 0 when the whole region is background', () => {
    expect(closestNonZeroId(new Uint8Array(W * H * 4), W, H, 4, 4)).toBe(0);
  });

  it('finds a lone hit anywhere in the region', () => {
    const buf = region([{ c: 8, r: 8, id: FACE_PICK_BASE + 1 }]);
    expect(closestNonZeroId(buf, W, H, 4, 4)).toBe(FACE_PICK_BASE + 1);
  });
});
