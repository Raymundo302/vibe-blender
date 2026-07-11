import { describe, it, expect } from 'vitest';
import {
  INLINED_PROPERTIES,
  inlineStyleDecl,
  buildFragmentSource,
  planeLocalToPagePx,
  pagePxToPlaneLocal,
  planeExtent,
  type PlaneExtent,
} from './extractElement';
import { makeImagePlaneMesh } from './imagePlane';

describe('inlineStyleDecl (pure computed-style subset walker)', () => {
  it('emits only props that DIFFER from the tag default, in subset order', () => {
    const defaults = { color: 'rgb(0, 0, 0)', 'background-color': 'rgba(0, 0, 0, 0)', display: 'block', width: 'auto' };
    const current = {
      color: 'rgb(0, 0, 0)', // == default → skipped
      'background-color': 'rgb(240, 130, 20)', // differs → kept
      display: 'flex', // differs → kept
      width: '200px', // differs → kept
    };
    const decl = inlineStyleDecl(current, defaults, ['color', 'display', 'background-color', 'width']);
    // Order follows the `props` argument; the equal `color` is dropped.
    expect(decl).toBe('display:flex;background-color:rgb(240, 130, 20);width:200px');
  });

  it('skips empty / missing values', () => {
    const decl = inlineStyleDecl(
      { color: '', 'font-size': '16px' },
      { color: 'rgb(0, 0, 0)', 'font-size': 'medium' },
      ['color', 'font-size', 'opacity'],
    );
    expect(decl).toBe('font-size:16px');
  });

  it('carries font, border, shadow, transform and animation longhands in the default subset', () => {
    for (const p of [
      'font-family', 'font-size', 'color', 'background-color',
      'border-top-width', 'border-top-left-radius', 'box-shadow', 'transform',
      'animation-name', 'animation-duration', 'top', 'left', 'width', 'height',
    ]) {
      expect(INLINED_PROPERTIES).toContain(p);
    }
  });
});

describe('buildFragmentSource', () => {
  it('wraps the inlined element in a body with keyframes in the head', () => {
    const src = buildFragmentSource('<div style="width:10px"></div>', '@keyframes b{from{top:0}to{top:9px}}');
    expect(src).toContain('<body><div style="width:10px"></div></body>');
    expect(src).toContain('<style>@keyframes b{from{top:0}to{top:9px}}</style>');
    expect(src).toContain('<html>');
  });

  it('omits the style block when there are no keyframes', () => {
    const src = buildFragmentSource('<span>x</span>', '');
    expect(src).toBe('<html><head></head><body><span>x</span></body></html>');
  });
});

describe('page-px ↔ plane-local mapping (inverts the raster UV layout)', () => {
  const ext: PlaneExtent = { minX: -1.5, maxX: 1.5, minY: -1, maxY: 1 };
  const pageW = 1024;
  const pageH = 768;

  it('page-top-left maps to the plane top-left corner (minX, maxY)', () => {
    const v = pagePxToPlaneLocal(0, 0, ext, pageW, pageH);
    expect(v.x).toBeCloseTo(ext.minX, 6);
    expect(v.y).toBeCloseTo(ext.maxY, 6);
  });

  it('page-bottom-right maps to the plane bottom-right corner (maxX, minY)', () => {
    const v = pagePxToPlaneLocal(pageW, pageH, ext, pageW, pageH);
    expect(v.x).toBeCloseTo(ext.maxX, 6);
    expect(v.y).toBeCloseTo(ext.minY, 6);
  });

  it('round-trips an arbitrary page point through local space', () => {
    const [px, py] = [312.5, 590];
    const v = pagePxToPlaneLocal(px, py, ext, pageW, pageH);
    const back = planeLocalToPagePx(v.x, v.y, ext, pageW, pageH);
    expect(back.x).toBeCloseTo(px, 4);
    expect(back.y).toBeCloseTo(py, 4);
  });

  it('planeExtent reads the quad extent from an image-plane mesh', () => {
    const mesh = makeImagePlaneMesh(1024, 768); // aspect 4:3 → X∈[-4/3,4/3], Y∈[-1,1]
    const e = planeExtent(mesh)!;
    expect(e.maxX - e.minX).toBeCloseTo(2 * (1024 / 768), 5);
    expect(e.maxY - e.minY).toBeCloseTo(2, 5);
    expect(e.maxY).toBeCloseTo(1, 5);
  });
});
