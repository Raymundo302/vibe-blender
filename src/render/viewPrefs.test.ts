import { describe, expect, it, beforeEach } from 'vitest';
import { viewPrefs, defaultViewPrefs, loadViewPrefs, saveViewPrefs } from './viewPrefs';
import { focalLengthToFovY, fovYToFocalLength } from '../core/scene/objectData';

// Plain-Node vitest env: stub a minimal in-memory localStorage (mirrors
// shadePrefs.test.ts / overlayPrefs.test.ts).
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void { this.map.set(k, String(v)); }
  removeItem(k: string): void { this.map.delete(k); }
  clear(): void { this.map.clear(); }
}
(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();

const KEY = 'vibe-view-v1';

describe('viewPrefs persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.assign(viewPrefs, defaultViewPrefs());
  });

  it('defaults: passepartout on, render engine gpu', () => {
    expect(defaultViewPrefs()).toEqual({ passepartout: true, renderEngine: 'gpu' });
  });

  it('round-trips the render engine through localStorage', () => {
    viewPrefs.renderEngine = 'cpu';
    saveViewPrefs();
    Object.assign(viewPrefs, defaultViewPrefs());
    loadViewPrefs();
    expect(viewPrefs.renderEngine).toBe('cpu');
  });

  it('an unknown stored render engine clamps to the default', () => {
    localStorage.setItem(KEY, JSON.stringify({ passepartout: true, renderEngine: 'quantum' }));
    loadViewPrefs();
    expect(viewPrefs.renderEngine).toBe('gpu');
  });

  it('round-trips through localStorage', () => {
    viewPrefs.passepartout = false;
    saveViewPrefs();
    Object.assign(viewPrefs, defaultViewPrefs());
    loadViewPrefs();
    expect(viewPrefs.passepartout).toBe(false);
  });

  it('missing key falls back to the default', () => {
    loadViewPrefs();
    expect(viewPrefs.passepartout).toBe(true);
  });

  it('a wrong-typed stored value is clamped back to the default', () => {
    localStorage.setItem(KEY, JSON.stringify({ passepartout: 'yes' }));
    loadViewPrefs();
    expect(viewPrefs.passepartout).toBe(true);
  });

  it('malformed JSON leaves defaults intact', () => {
    localStorage.setItem(KEY, '{not json');
    loadViewPrefs();
    expect(viewPrefs.passepartout).toBe(true);
  });
});

describe('mm↔fov shared helper (viewport lens ↔ CameraData convention)', () => {
  it('round-trips a focal length through fov and back', () => {
    for (const mm of [18, 24, 35, 50, 85, 100, 200]) {
      expect(fovYToFocalLength(focalLengthToFovY(mm))).toBeCloseTo(mm, 6);
    }
  });

  it('50mm on the 36×24 sensor ≈ 27° vertical FOV', () => {
    expect((focalLengthToFovY(50) * 180) / Math.PI).toBeCloseTo(27, 0);
  });

  it('a longer lens narrows the FOV', () => {
    expect(focalLengthToFovY(100)).toBeLessThan(focalLengthToFovY(50));
  });
});
