import { describe, it, expect } from 'vitest';
import {
  RASTER_W,
  RASTER_H,
  PARSE_FAILURE_MESSAGE,
  extractParts,
  wrapXhtml,
  buildSvgDocument,
  buildSvgFromParts,
  errorCardFragment,
  pausedAnimationRule,
  pausedAnimationStyle,
  scrollWrap,
  makeHtmlPlaneMesh,
  htmlPlaneExtent,
} from './htmlPlane';
import { makeImagePlaneMesh } from './imagePlane';
import { defaultHtmlPlaneData, HTML_PLANE_DEFAULT_FPS } from '../core/scene/objectData';

describe('extractParts', () => {
  it('pulls the body (and head) inner HTML from a full document', () => {
    const src =
      '<!DOCTYPE html><html><head><style>p{color:red}</style></head>' +
      '<body><p>hi</p></body></html>';
    const { head, body } = extractParts(src);
    expect(body).toBe('<p>hi</p>');
    expect(head).toBe('<style>p{color:red}</style>');
  });

  it('treats a bare fragment as the body with an empty head', () => {
    const { head, body } = extractParts('<div>plain</div>');
    expect(head).toBe('');
    expect(body).toBe('<div>plain</div>');
  });
});

describe('wrapXhtml', () => {
  it('wraps a plain body fragment in an XHTML-namespaced <html> root', () => {
    const out = wrapXhtml('<div>hello</div>');
    // XHTML namespace is mandatory for foreignObject.
    expect(out).toContain('xmlns="http://www.w3.org/1999/xhtml"');
    expect(out.startsWith('<html')).toBe(true);
    expect(out.trimEnd().endsWith('</html>')).toBe(true);
    // The fragment lands inside <body>.
    expect(out).toContain('<body><div>hello</div></body>');
  });

  it('injects an optional head fragment before the body', () => {
    const out = wrapXhtml('<p>x</p>', '<title>T</title>');
    expect(out.indexOf('<title>T</title>')).toBeLessThan(out.indexOf('<body>'));
  });
});

describe('buildSvgDocument', () => {
  it('embeds the content as XHTML in a foreignObject at the given size', () => {
    const svg = buildSvgDocument('<div>x</div>', 800, 600);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('width="800"');
    expect(svg).toContain('height="600"');
    expect(svg).toContain('<foreignObject');
    expect(svg).toContain('xmlns="http://www.w3.org/1999/xhtml"');
    expect(svg).toContain('<div>x</div>');
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
  });

  it('normalizes a full document (body only, not nested <html>)', () => {
    const svg = buildSvgDocument('<html><body><span>ok</span></body></html>');
    // The inner <html> is stripped — only one <html> (the XHTML root) remains.
    expect(svg.match(/<html/g)!.length).toBe(1);
    expect(svg).toContain('<span>ok</span>');
  });

  it('defaults to the documented 1024×768 raster size', () => {
    const svg = buildSvgDocument('<div/>');
    expect(svg).toContain(`width="${RASTER_W}"`);
    expect(svg).toContain(`height="${RASTER_H}"`);
    expect(RASTER_W).toBe(1024);
    expect(RASTER_H).toBe(768);
  });
});

describe('errorCardFragment', () => {
  it('contains the parse-failure message', () => {
    expect(errorCardFragment()).toContain(PARSE_FAILURE_MESSAGE);
    expect(PARSE_FAILURE_MESSAGE).toBe('HTML failed to parse');
  });

  it('XML-escapes the message so the error card itself always parses', () => {
    const out = errorCardFragment('<broken> & "stuff"');
    expect(out).toContain('&lt;broken&gt; &amp;');
    expect(out).not.toContain('<broken>');
  });

  it('is a self-contained fragment (no external resources)', () => {
    const out = errorCardFragment();
    expect(out).not.toMatch(/https?:\/\//);
    expect(out).not.toContain('<script');
  });
});

describe('pausedAnimationRule (UR7-1 page-clock sampling)', () => {
  it('pauses every element and delays it by -t seconds, both !important', () => {
    const rule = pausedAnimationRule(1.25);
    expect(rule).toBe('*{animation-play-state:paused !important;animation-delay:-1.25s !important}');
  });

  it('clamps a negative/non-finite time to 0', () => {
    expect(pausedAnimationRule(-3)).toContain('animation-delay:-0s !important');
    expect(pausedAnimationRule(NaN)).toContain('animation-delay:-0s !important');
  });

  it('wraps the rule in a <style> block', () => {
    expect(pausedAnimationStyle(2)).toBe(
      '<style>*{animation-play-state:paused !important;animation-delay:-2s !important}</style>',
    );
  });

  it('the injected style lands LAST in the head so it wins the cascade', () => {
    // rasterizeHtmlAt appends pausedAnimationStyle after the author head, then
    // builds the SVG — assert on the composed document.
    const svg = buildSvgFromParts('<style>p{color:red}</style>' + pausedAnimationStyle(0.5), '<p>x</p>');
    expect(svg).toContain('animation-play-state:paused !important');
    expect(svg).toContain('animation-delay:-0.5s !important');
    // author style comes before the injected pause style.
    expect(svg.indexOf('p{color:red}')).toBeLessThan(svg.indexOf('animation-play-state'));
  });
});

describe('scrollWrap (UR7-2 scroll consumption)', () => {
  it('returns the body UNCHANGED at scrollY 0 (byte-identical to UR7-1)', () => {
    expect(scrollWrap('<p>hi</p>', 0)).toBe('<p>hi</p>');
  });
  it('clamps a negative/non-finite scroll to 0 (unchanged body)', () => {
    expect(scrollWrap('<p>hi</p>', -50)).toBe('<p>hi</p>');
    expect(scrollWrap('<p>hi</p>', NaN)).toBe('<p>hi</p>');
  });
  it('wraps a scrolled body in a clipping viewport translated up by scrollY px', () => {
    const out = scrollWrap('<p>hi</p>', 600);
    expect(out).toContain('overflow:hidden');
    expect(out).toContain('translateY(-600px)');
    expect(out).toContain('<p>hi</p>');
    // The body sits INSIDE the translated inner div.
    expect(out.indexOf('translateY')).toBeLessThan(out.indexOf('<p>hi</p>'));
  });
});

describe('makeHtmlPlaneMesh + htmlPlaneExtent (UR7-2 page extent geometry)', () => {
  // Helper: min/max Y across a mesh's verts.
  const ys = (m: ReturnType<typeof makeHtmlPlaneMesh>) => [...m.verts.values()].map((v) => v.co.y);
  const xs = (m: ReturnType<typeof makeHtmlPlaneMesh>) => [...m.verts.values()].map((v) => v.co.x);

  it('reproduces the original image-plane quad for the built default (no jump switching)', () => {
    // makeImagePlaneMesh(1024,768) → width 2·1024/768, height 2, top +1, bottom −1.
    const img = makeImagePlaneMesh(1024, 768);
    const ext = htmlPlaneExtent(img)!;
    const html = makeHtmlPlaneMesh(ext.width, ext.topY, 1024, 768);
    expect(Math.max(...ys(html))).toBeCloseTo(1, 6); // top +1
    expect(Math.min(...ys(html))).toBeCloseTo(-1, 6); // bottom −1
    expect(Math.max(...xs(html)) - Math.min(...xs(html))).toBeCloseTo(ext.width, 6);
  });

  it('doubling pageH keeps the width + TOP edge and drops the BOTTOM edge (extends down)', () => {
    const base = makeHtmlPlaneMesh(2.6667, 1, 1024, 768);
    const width0 = Math.max(...xs(base)) - Math.min(...xs(base));
    const top0 = Math.max(...ys(base));
    const bottom0 = Math.min(...ys(base));

    const tall = makeHtmlPlaneMesh(width0, top0, 1024, 1536); // pageH 768→1536
    const width1 = Math.max(...xs(tall)) - Math.min(...xs(tall));
    const top1 = Math.max(...ys(tall));
    const bottom1 = Math.min(...ys(tall));

    expect(width1).toBeCloseTo(width0, 6); // width unchanged
    expect(top1).toBeCloseTo(top0, 6); // top edge fixed
    expect(bottom1).toBeLessThan(bottom0); // bottom extends downward
    // Height doubled downward: new height = 2·old height.
    expect(top0 - bottom1).toBeCloseTo(2 * (top0 - bottom0), 6);
  });

  it('keeps UVs the full 0..1 raster on the single face', () => {
    const m = makeHtmlPlaneMesh(2.6667, 1, 1024, 1536);
    const faceId = [...m.faces.keys()][0];
    const uv = m.uvs.get(faceId)!;
    expect(uv).toEqual([[0, 0], [0, 1], [1, 1], [1, 0]]);
  });

  it('falls back to a finite square for degenerate inputs (no NaN)', () => {
    const m = makeHtmlPlaneMesh(0, NaN, 0, 0);
    for (const v of m.verts.values()) {
      expect(Number.isFinite(v.co.x)).toBe(true);
      expect(Number.isFinite(v.co.y)).toBe(true);
    }
  });

  it('htmlPlaneExtent returns null for an empty mesh', () => {
    const empty = makeHtmlPlaneMesh(2, 1, 1024, 768);
    empty.verts.clear();
    expect(htmlPlaneExtent(empty)).toBeNull();
  });
});

describe('defaultHtmlPlaneData (UR7-1 payload)', () => {
  it('stamps kind + source with the documented defaults', () => {
    const d = defaultHtmlPlaneData('file', '<b>hi</b>');
    expect(d).toEqual({
      kind: 'file',
      source: '<b>hi</b>',
      pageW: RASTER_W,
      pageH: RASTER_H,
      scrollY: 0,
      playing: false,
      fps: HTML_PLANE_DEFAULT_FPS,
    });
    expect(RASTER_W).toBe(1024);
    expect(RASTER_H).toBe(768);
    expect(HTML_PLANE_DEFAULT_FPS).toBe(8);
  });
});
