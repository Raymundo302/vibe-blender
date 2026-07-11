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

const V5 = 'vibe-shading-v5';
const V4 = 'vibe-shading-v4';
const V3 = 'vibe-shading-v3';

// The full default shape (kept in one place so the shape assertions stay short).
const DEFAULTS = {
  ao: false, aoMode: 'object', aoMethod: 0, aoRadius: 0.3, aoStrength: 1, aoSamples: 48,
  wireOverlay: false, wireColor: [0.05, 0.05, 0.06], wireProximity: true, wireMinPx: 0.6, wireMaxPx: 3.5,
  intersections: false, intersectColor: [0.45, 0.45, 0.48],
  hiddenLine: { matcap: true, studio: true, rendered: true, wireframe: false },
  sections: { ao: false, wire: false, intersect: false },
};

describe('shadePrefs persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.assign(shadePrefs, defaultShadePrefs());
  });

  it('defaults: toggles off, AO tuner at its documented midpoints, hidden line per-mode', () => {
    expect(defaultShadePrefs()).toEqual(DEFAULTS);
  });

  it('round-trips through localStorage (booleans + numbers + hiddenLine record + colors + sections)', () => {
    shadePrefs.ao = true;
    shadePrefs.aoMode = 'object';
    shadePrefs.aoMethod = 2;
    shadePrefs.hiddenLine = { matcap: false, studio: true, rendered: false, wireframe: true };
    shadePrefs.aoRadius = 1.7;
    shadePrefs.aoStrength = 1.6;
    shadePrefs.wireColor = [1, 0, 0];
    shadePrefs.wireProximity = false;
    shadePrefs.wireMinPx = 1.2;
    shadePrefs.wireMaxPx = 6;
    shadePrefs.intersectColor = [0, 1, 1];
    shadePrefs.sections = { ao: true, wire: true, intersect: false };
    saveShadePrefs();
    Object.assign(shadePrefs, defaultShadePrefs());
    loadShadePrefs();
    expect(shadePrefs).toEqual({
      ...DEFAULTS,
      ao: true, aoMode: 'object', aoMethod: 2, aoRadius: 1.7, aoStrength: 1.6,
      wireColor: [1, 0, 0], wireProximity: false, wireMinPx: 1.2, wireMaxPx: 6,
      intersectColor: [0, 1, 1],
      hiddenLine: { matcap: false, studio: true, rendered: false, wireframe: true },
      sections: { ao: true, wire: true, intersect: false },
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
    localStorage.setItem(V5, JSON.stringify({ ao: true }));
    loadShadePrefs();
    expect(shadePrefs).toEqual({ ...DEFAULTS, ao: true });
  });

  it('MIGRATES a v4 blob → its values load + the new v5 fields take defaults', () => {
    localStorage.setItem(V4, JSON.stringify({
      ao: true, aoMode: 'object', aoRadius: 0.8, wireOverlay: true,
      hiddenLine: { matcap: false, studio: true, rendered: true, wireframe: true },
    }));
    loadShadePrefs();
    expect(shadePrefs).toEqual({
      ...DEFAULTS,
      ao: true, aoRadius: 0.8, wireOverlay: true,
      hiddenLine: { matcap: false, studio: true, rendered: true, wireframe: true },
    });
    // The new UR9-1 fields are the defaults (a v4 blob never had them).
    expect(shadePrefs.wireColor).toEqual([0.05, 0.05, 0.06]);
    expect(shadePrefs.wireProximity).toBe(true);
    expect(shadePrefs.wireMinPx).toBe(0.6);
    expect(shadePrefs.wireMaxPx).toBe(3.5);
    expect(shadePrefs.intersectColor).toEqual([0.45, 0.45, 0.48]);
    expect(shadePrefs.sections).toEqual({ ao: false, wire: false, intersect: false });
  });

  it('prefers a v5 blob over a stale v4 blob', () => {
    localStorage.setItem(V4, JSON.stringify({ wireMaxPx: 8 }));
    localStorage.setItem(V5, JSON.stringify({ wireMaxPx: 5 }));
    loadShadePrefs();
    expect(shadePrefs.wireMaxPx).toBe(5);
  });

  it('v3 chain STILL migrates when only a v3 blob exists (wireHiddenLine → .wireframe)', () => {
    localStorage.setItem(V3, JSON.stringify({ aoRadius: 0.9, wireHiddenLine: true }));
    loadShadePrefs();
    expect(shadePrefs.aoRadius).toBe(0.9);
    expect(shadePrefs.hiddenLine.wireframe).toBe(true);
    // And the v5 fields still default in the v3 chain.
    expect(shadePrefs.wireMaxPx).toBe(3.5);
    expect(shadePrefs.sections).toEqual({ ao: false, wire: false, intersect: false });
  });

  it('clamps wireMinPx / wireMaxPx into their slider bounds', () => {
    localStorage.setItem(V5, JSON.stringify({ wireMinPx: 99, wireMaxPx: -1 }));
    loadShadePrefs();
    expect(shadePrefs.wireMinPx).toBe(2);   // WIRE_MIN_PX_RANGE.max
    expect(shadePrefs.wireMaxPx).toBe(1);   // WIRE_MAX_PX_RANGE.min
  });

  it('sanitizes colors: clamps components to 0..1, rejects malformed arrays', () => {
    localStorage.setItem(V5, JSON.stringify({
      wireColor: [2, -1, 0.5],         // out of range → clamped
      intersectColor: [0.1, 0.2],      // wrong length → default
    }));
    loadShadePrefs();
    expect(shadePrefs.wireColor).toEqual([1, 0, 0.5]);
    expect(shadePrefs.intersectColor).toEqual([0.45, 0.45, 0.48]);
  });

  it('rejects a non-finite / non-numeric color component (falls back to default)', () => {
    localStorage.setItem(V5, JSON.stringify({ wireColor: [0.5, 'x', 0.5] }));
    loadShadePrefs();
    expect(shadePrefs.wireColor).toEqual([0.05, 0.05, 0.06]);
  });

  it('fills missing sections booleans from defaults (partial record)', () => {
    localStorage.setItem(V5, JSON.stringify({ sections: { ao: true } }));
    loadShadePrefs();
    expect(shadePrefs.sections).toEqual({ ao: true, wire: false, intersect: false });
  });
});
