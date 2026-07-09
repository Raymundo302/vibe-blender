import { describe, it, expect } from 'vitest';
import './themes90s'; // side effect: registers the six 90s themes
import { themes } from './themes'; // side effect: registers claude + default

/** sRGB hex → relative luminance (WCAG 2.x). */
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`bad hex: ${hex}`);
  const n = parseInt(m[1], 16);
  const chan = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const r = chan((n >> 16) & 0xff);
  const g = chan((n >> 8) & 0xff);
  const b = chan(n & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colors (>= 1). */
function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

const REQUIRED_TOKENS = [
  'bg', 'panel', 'panel2', 'input', 'border', 'text',
  'text-dim', 'accent', 'accent-contrast', 'hover', 'chip',
];

describe('theme registry', () => {
  it('registers the eight themes (claude, default + six 90s)', () => {
    const ids = themes().map((t) => t.id);
    for (const id of [
      'claude', 'default', 'retro-dos', 'sunset-grid',
      'teal-machine', 'grunge-console', 'ice-blue', 'carbon-fusion',
    ]) {
      expect(ids, `missing theme ${id}`).toContain(id);
    }
  });

  it('every theme defines all 11 CSS tokens with valid 6-digit hex', () => {
    for (const theme of themes()) {
      for (const token of REQUIRED_TOKENS) {
        const v = theme.css[token];
        expect(v, `${theme.id}.${token} missing`).toBeTruthy();
        expect(v, `${theme.id}.${token} = ${v} not #rrggbb`).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    }
  });

  it('every theme keeps text vs panel contrast >= 4.0', () => {
    for (const theme of themes()) {
      const ratio = contrast(theme.css.text, theme.css.panel);
      expect(ratio, `${theme.id}: text/panel contrast ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.0);
    }
  });

  it('every viewport palette has 5 sane rgb triples in 0..1', () => {
    for (const theme of themes()) {
      const vp = theme.viewport;
      for (const key of ['background', 'grid', 'axisX', 'axisY', 'selection'] as const) {
        const rgb = vp[key];
        expect(rgb, `${theme.id}.${key}`).toHaveLength(3);
        for (const c of rgb) {
          expect(c, `${theme.id}.${key} channel ${c}`).toBeGreaterThanOrEqual(0);
          expect(c, `${theme.id}.${key} channel ${c}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});
