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

describe('shadePrefs persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.assign(shadePrefs, defaultShadePrefs());
  });

  it('defaults: toggles off, AO tuner at its documented midpoints', () => {
    expect(defaultShadePrefs()).toEqual({
      ao: false, aoMode: 'screen', aoMethod: 2, aoRadius: 1.2, aoStrength: 0.9, aoSamples: 48, wireOverlay: false, wireHiddenLine: false,
    });
  });

  it('round-trips through localStorage (booleans + numbers)', () => {
    shadePrefs.ao = true;
    shadePrefs.aoMode = 'object';
    shadePrefs.aoMethod = 4;
    shadePrefs.wireHiddenLine = true;
    shadePrefs.aoRadius = 1.7;
    shadePrefs.aoStrength = 1.6;
    saveShadePrefs();
    Object.assign(shadePrefs, defaultShadePrefs());
    loadShadePrefs();
    expect(shadePrefs).toEqual({
      ao: true, aoMode: 'object', aoMethod: 4, aoRadius: 1.7, aoStrength: 1.6, aoSamples: 48, wireOverlay: false, wireHiddenLine: true,
    });
  });

  it('clamps out-of-range stored tuner values into the slider bounds', () => {
    localStorage.setItem('vibe-shading-v2', JSON.stringify({ aoRadius: 99, aoStrength: -3 }));
    loadShadePrefs();
    expect(shadePrefs.aoRadius).toBe(2.5);
    expect(shadePrefs.aoStrength).toBe(0);
  });

  it('rejects non-finite numbers (falls back to defaults)', () => {
    localStorage.setItem('vibe-shading-v2', JSON.stringify({ aoRadius: null, aoStrength: 'big' }));
    loadShadePrefs();
    expect(shadePrefs.aoRadius).toBe(1.2);
    expect(shadePrefs.aoStrength).toBe(0.9);
  });

  it('sanitizes an invalid stored aoMode / aoMethod', () => {
    localStorage.setItem('vibe-shading-v2', JSON.stringify({ aoMode: 'quantum', aoMethod: 42 }));
    loadShadePrefs();
    expect(shadePrefs.aoMode).toBe('screen');
    expect(shadePrefs.aoMethod).toBe(5);
  });

  it('malformed storage falls back to defaults', () => {
    localStorage.setItem('vibe-shading-v2', '{not json');
    shadePrefs.ao = true;
    loadShadePrefs();
    expect(shadePrefs).toEqual(defaultShadePrefs());
  });

  it('missing keys fall back individually', () => {
    localStorage.setItem('vibe-shading-v2', JSON.stringify({ ao: true }));
    loadShadePrefs();
    expect(shadePrefs).toEqual({
      ao: true, aoMode: 'screen', aoMethod: 2, aoRadius: 1.2, aoStrength: 0.9, aoSamples: 48, wireOverlay: false, wireHiddenLine: false,
    });
  });
});
