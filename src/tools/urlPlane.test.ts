import { describe, it, expect } from 'vitest';
import { hostOf, pausedCardFragment, pausedCardSvg } from './urlPlane';

describe('hostOf', () => {
  it('extracts the host of an absolute URL', () => {
    expect(hostOf('https://example.com/path?q=1')).toBe('example.com');
    expect(hostOf('http://sub.example.org:8080/x')).toBe('sub.example.org:8080');
  });

  it('prefixes https:// for a bare host', () => {
    expect(hostOf('example.com/page')).toBe('example.com');
  });

  it('falls back to the trimmed input when unparseable', () => {
    expect(hostOf('  not a url  ')).toBe('not a url');
  });

  it('handles data: URLs without throwing (host is empty → the input)', () => {
    const d = 'data:text/html,<h1>hi</h1>';
    expect(typeof hostOf(d)).toBe('string');
  });
});

describe('pausedCardFragment', () => {
  it('names the host and the paused-portal message, info-grey (not red)', () => {
    const f = pausedCardFragment('example.com');
    expect(f).toContain('example.com');
    expect(f.toLowerCase()).toContain('paused web portal');
    // Info-grey ground, not the red error card.
    expect(f).toContain('#2b2f36');
    expect(f).not.toContain('#3a2020');
  });

  it('escapes angle brackets / ampersands in the host (XML-safe)', () => {
    const f = pausedCardFragment('<a&b>');
    expect(f).toContain('&lt;a&amp;b&gt;');
    expect(f).not.toContain('<a&b>');
  });
});

describe('pausedCardSvg', () => {
  it('embeds the card in a sized foreignObject SVG', () => {
    const svg = pausedCardSvg('example.com', 640, 480);
    expect(svg).toContain('<svg');
    expect(svg).toContain('width="640"');
    expect(svg).toContain('foreignObject');
    expect(svg).toContain('example.com');
  });
});
