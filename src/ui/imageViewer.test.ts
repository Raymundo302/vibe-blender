import { describe, expect, it } from 'vitest';
import {
  clampZoom,
  fitView,
  screenToImage,
  imageToScreen,
  zoomAroundPoint,
  MIN_ZOOM,
  MAX_ZOOM,
  type ViewTransform,
} from './imageViewer';

describe('clampZoom', () => {
  it('clamps to the [MIN,MAX] range', () => {
    expect(clampZoom(0.001)).toBe(MIN_ZOOM);
    expect(clampZoom(1000)).toBe(MAX_ZOOM);
    expect(clampZoom(2)).toBe(2);
  });
  it('honours custom bounds', () => {
    expect(clampZoom(5, 1, 4)).toBe(4);
    expect(clampZoom(0.5, 1, 4)).toBe(1);
  });
});

describe('fitView', () => {
  it('letterboxes a wide image (width-bound) and centres it', () => {
    // 200x100 image into a 400x400 view, pad 1 → zoom = min(2,4)=2.
    const v = fitView(200, 100, 400, 400, 1);
    expect(v.zoom).toBe(2);
    // Drawn size 400x200 → centred: panX 0, panY (400-200)/2 = 100.
    expect(v.panX).toBe(0);
    expect(v.panY).toBe(100);
  });

  it('letterboxes a tall image (height-bound)', () => {
    const v = fitView(100, 200, 400, 400, 1);
    expect(v.zoom).toBe(2);
    expect(v.panY).toBe(0);
    expect(v.panX).toBe(100);
  });

  it('applies padding (< 1) to leave a margin', () => {
    const v = fitView(100, 100, 400, 400, 0.5);
    expect(v.zoom).toBe(2); // min(4,4)*0.5
  });

  it('returns identity for degenerate inputs', () => {
    expect(fitView(0, 100, 400, 400)).toEqual({ zoom: 1, panX: 0, panY: 0 });
    expect(fitView(100, 100, 0, 400)).toEqual({ zoom: 1, panX: 0, panY: 0 });
  });

  it('never exceeds MAX_ZOOM when fitting a tiny image', () => {
    const v = fitView(1, 1, 4000, 4000, 1);
    expect(v.zoom).toBe(MAX_ZOOM);
  });
});

describe('screen↔image mapping round-trips', () => {
  it('imageToScreen is the inverse of screenToImage', () => {
    const v: ViewTransform = { zoom: 3, panX: 40, panY: -12 };
    const [sx, sy] = imageToScreen(v, 10, 7);
    expect(sx).toBe(70);
    expect(sy).toBe(9);
    const [ix, iy] = screenToImage(v, sx, sy);
    expect(ix).toBeCloseTo(10, 10);
    expect(iy).toBeCloseTo(7, 10);
  });
});

describe('zoomAroundPoint', () => {
  it('keeps the image point under the cursor fixed', () => {
    const v: ViewTransform = { zoom: 1, panX: 0, panY: 0 };
    const before = screenToImage(v, 150, 90);
    const nv = zoomAroundPoint(v, 150, 90, 2);
    expect(nv.zoom).toBe(2);
    const after = screenToImage(nv, 150, 90);
    expect(after[0]).toBeCloseTo(before[0], 10);
    expect(after[1]).toBeCloseTo(before[1], 10);
    // The pixel that was under the cursor still lands under the cursor.
    const [sx, sy] = imageToScreen(nv, before[0], before[1]);
    expect(sx).toBeCloseTo(150, 10);
    expect(sy).toBeCloseTo(90, 10);
  });

  it('clamps the resulting zoom to the range', () => {
    const v: ViewTransform = { zoom: 20, panX: 0, panY: 0 };
    expect(zoomAroundPoint(v, 10, 10, 100).zoom).toBe(MAX_ZOOM);
    const v2: ViewTransform = { zoom: 0.2, panX: 0, panY: 0 };
    expect(zoomAroundPoint(v2, 10, 10, 0.01).zoom).toBe(MIN_ZOOM);
  });

  it('zooming out then in around the same point restores the view', () => {
    const v: ViewTransform = { zoom: 4, panX: 33, panY: 51 };
    const out = zoomAroundPoint(v, 200, 120, 0.5);
    const back = zoomAroundPoint(out, 200, 120, 2);
    expect(back.zoom).toBeCloseTo(v.zoom, 10);
    expect(back.panX).toBeCloseTo(v.panX, 8);
    expect(back.panY).toBeCloseTo(v.panY, 8);
  });
});
