import { describe, it, expect } from 'vitest';
import {
  RASTER_W,
  RASTER_H,
  PARSE_FAILURE_MESSAGE,
  extractParts,
  wrapXhtml,
  buildSvgDocument,
  errorCardFragment,
} from './htmlPlane';

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
