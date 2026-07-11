import { describe, expect, it, beforeEach } from 'vitest';
import { shadePrefs, defaultShadePrefs, loadShadePrefs, saveShadePrefs } from './shadePrefs';

// The vitest environment is plain Node (no DOM), so stub a minimal in-memory
// localStorage the module can read/write (mirrors overlayPrefs.test.ts).
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void { this.map.set(k, String(v)); }
  removeItem(k: string): void { this.map.delete(k); }
  clear(): void { this.map.clear(); }
}
(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();

const V4 = 'vibe-shading-v4';
const V3 = 'vibe-shading-v3';

describe('shadePrefs persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.assign(shadePrefs, defaultShadePrefs());
  });

  it('defaults: toggles off, AO tuner at its documented midpoints, hidden line per-mode', () => {
    expect(defaultShadePrefs()).toEqual({
      ao: false, aoMode: 'object', aoMethod: 0, aoRadius: 0.3, aoStrength: 1, aoSamples: 48,
      wireOverlay: false, intersections: false,
      hiddenLine: { matcap: true, studio: true, rendered: true, wireframe: false },
    });
  });

  it('round-trips through localStorage (booleans + numbers + hiddenLine record)', () => {
    shadePrefs.ao = true;
    shadePrefs.aoMode = 'object';
    shadePrefs.aoMethod = 2;
    shadePrefs.hiddenLine = { matcap: false, studio: true, rendered: false, wireframe: true };
    shadePrefs.aoRadius = 1.7;
    shadePrefs.aoStrength = 1.6;
    saveShadePrefs();
    Object.assign(shadePrefs, defaultShadePrefs());
    loadShadePrefs();
    expect(shadePrefs).toEqual({
      ao: true, aoMode: 'object', aoMethod: 2, aoRadius: 1.7, aoStrength: 1.6, aoSamples: 48,
      wireOverlay: false, intersections: false,
      hiddenLine: { matcap: false, studio: true, rendered: false, wireframe: true },
    });
  });

  it('MIGRATES a v3 blob: wireHiddenLine lands in .wireframe, other modes default', () => {
    localStorage.setItem(V3, JSON.stringify({
      ao: true, aoMode: 'object', aoMethod: 1, aoRadius: 0.7, wireHiddenLine: true,
    }));
    loadShadePrefs();
    // The v3 scalars still load...
    expect(shadePrefs.ao).toBe(true);
    expect(shadePrefs.aoMethod).toBe(1);
    expect(shadePrefs.aoRadius).toBe(0.7);
    // ...and wireHiddenLine migrates to hiddenLine.wireframe; the solid modes
    // take the new per-mode defaults.
    expect(shadePrefs.hiddenLine).toEqual({
      matcap: true, studio: true, rendered: true, wireframe: true,
    });
  });

  it('MIGRATES a v3 blob with wireHiddenLine=false → .wireframe false (defaults elsewhere)', () => {
    localStorage.setItem(V3, JSON.stringify({ wireHiddenLine: false }));
    loadShadePrefs();
    expect(shadePrefs.hiddenLine).toEqual({
      matcap: true, studio: true, rendered: true, wireframe: false,
    });
  });

  it('prefers the v4 blob over a stale v3 blob (no migration)', () => {
    localStorage.setItem(V3, JSON.stringify({ wireHiddenLine: true }));
    localStorage.setItem(V4, JSON.stringify({
      hiddenLine: { matcap: false, studio: false, rendered: false, wireframe: false },
    }));
    loadShadePrefs();
    expect(shadePrefs.hiddenLine).toEqual({
      matcap: false, studio: false, rendered: false, wireframe: false,
    });
  });

  it('fills missing hiddenLine modes from defaults (partial v4 record)', () => {
    localStorage.setItem(V4, JSON.stringify({ hiddenLine: { matcap: false } }));
    loadShadePrefs();
    expect(shadePrefs.hiddenLine).toEqual({
      matcap: false, studio: true, rendered: true, wireframe: false,
    });
  });

  it('clamps out-of-range stored tuner values into the slider bounds', () => {
    localStorage.setItem(V4, JSON.stringify({ aoRadius: 99, aoStrength: -3 }));
    loadShadePrefs();
    expect(shadePrefs.aoRadius).toBe(2.5);
    expect(shadePrefs.aoStrength).toBe(0);
  });

  it('rejects non-finite numbers (falls back to defaults)', () => {
    localStorage.setItem(V4, JSON.stringify({ aoRadius: null, aoStrength: 'big' }));
    loadShadePrefs();
    expect(shadePrefs.aoRadius).toBe(0.3);
    expect(shadePrefs.aoStrength).toBe(1);
  });

  it('sanitizes an invalid stored aoMode / aoMethod', () => {
    localStorage.setItem(V4, JSON.stringify({ aoMode: 'quantum', aoMethod: 42 }));
    loadShadePrefs();
    expect(shadePrefs.aoMode).toBe('object');
    expect(shadePrefs.aoMethod).toBe(2);
  });

  it('malformed storage falls back to defaults', () => {
    localStorage.setItem(V4, '{not json');
    shadePrefs.ao = true;
    loadShadePrefs();
    expect(shadePrefs).toEqual(defaultShadePrefs());
  });

  it('missing keys fall back individually', () => {
    localStorage.setItem(V4, JSON.stringify({ ao: true }));
    loadShadePrefs();
    expect(shadePrefs).toEqual({
      ao: true, aoMode: 'object', aoMethod: 0, aoRadius: 0.3, aoStrength: 1, aoSamples: 48,
      wireOverlay: false, intersections: false,
      hiddenLine: { matcap: true, studio: true, rendered: true, wireframe: false },
    });
  });
});
