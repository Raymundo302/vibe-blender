import { describe, it, expect, beforeEach } from 'vitest';
import {
  overlays,
  defaultOverlayPrefs,
  loadOverlayPrefs,
  saveOverlayPrefs,
  type OverlayPrefs,
} from './overlayPrefs';

const KEY = 'vibe-overlays';

// The vitest environment is plain Node (no DOM), so stub a minimal in-memory
// localStorage the module can read/write.
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void { this.map.set(k, String(v)); }
  removeItem(k: string): void { this.map.delete(k); }
  clear(): void { this.map.clear(); }
}
(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();

/** Reset the singleton + storage to a known state before each case. */
function reset(): void {
  localStorage.clear();
  Object.assign(overlays, defaultOverlayPrefs());
}

describe('overlayPrefs', () => {
  beforeEach(reset);

  it('defaults every overlay to true', () => {
    const d = defaultOverlayPrefs();
    expect(d).toEqual({ grid: true, originPoints: true, icons: true, frustums: true, cursor3d: true });
  });

  it('round-trips saved prefs through localStorage', () => {
    overlays.grid = false;
    overlays.frustums = false;
    overlays.cursor3d = false;
    saveOverlayPrefs();

    // Wipe the in-memory singleton, then reload from storage.
    Object.assign(overlays, defaultOverlayPrefs());
    const loaded = loadOverlayPrefs();

    expect(loaded).toBe(overlays); // returns the singleton
    expect(overlays.grid).toBe(false);
    expect(overlays.frustums).toBe(false);
    expect(overlays.cursor3d).toBe(false);
    expect(overlays.originPoints).toBe(true);
    expect(overlays.icons).toBe(true);
  });

  it('falls back to defaults on malformed JSON', () => {
    localStorage.setItem(KEY, '{not valid json');
    overlays.grid = false; // dirty the singleton first
    loadOverlayPrefs();
    expect(overlays).toEqual(defaultOverlayPrefs());
  });

  it('falls back to defaults when stored value is not an object', () => {
    localStorage.setItem(KEY, '42');
    loadOverlayPrefs();
    expect(overlays).toEqual(defaultOverlayPrefs());
  });

  it('fills missing keys with defaults and ignores non-boolean values', () => {
    localStorage.setItem(KEY, JSON.stringify({ grid: false, icons: 'yes' }));
    loadOverlayPrefs();
    expect(overlays.grid).toBe(false); // honored
    expect(overlays.icons).toBe(true); // non-boolean → default
    expect(overlays.originPoints).toBe(true); // missing → default
    expect(overlays.frustums).toBe(true);
    expect(overlays.cursor3d).toBe(true);
  });

  it('ignores unknown extra keys in stored JSON', () => {
    localStorage.setItem(KEY, JSON.stringify({ grid: false, bogus: true } as unknown as OverlayPrefs));
    loadOverlayPrefs();
    expect(overlays.grid).toBe(false);
    expect('bogus' in overlays).toBe(false);
  });
});
