import { describe, expect, it, beforeEach } from 'vitest';
import {
  combFor, setComb, defaultCombPref, loadCombPrefs, saveCombPrefs,
  COMB_SCALE_RANGE, COMB_SAMPLES_RANGE,
} from './combPrefs';

// Plain-Node vitest env (no DOM) — stub a minimal in-memory localStorage the
// module reads/writes (mirrors shadePrefs.test.ts / overlayPrefs.test.ts).
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void { this.map.set(k, String(v)); }
  removeItem(k: string): void { this.map.delete(k); }
  clear(): void { this.map.clear(); }
}
(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();

const KEY = 'vibe-curve-combs';

describe('combPrefs', () => {
  beforeEach(() => {
    localStorage.clear();
    loadCombPrefs(); // fresh, empty map
  });

  it('defaults: comb off, scale 1, samples 64', () => {
    expect(defaultCombPref()).toEqual({ on: false, scale: 1, samples: 64 });
    // A never-touched object id reads the defaults.
    expect(combFor(42)).toEqual({ on: false, scale: 1, samples: 64 });
  });

  it('combFor returns a stable object across calls (in-place mutation sticks)', () => {
    const a = combFor(7);
    a.on = true;
    expect(combFor(7).on).toBe(true);
    expect(combFor(7)).toBe(a);
  });

  it('setComb clamps samples into 8..256 (and rounds)', () => {
    expect(setComb(1, { samples: 999 }).samples).toBe(COMB_SAMPLES_RANGE.max); // 256
    expect(setComb(2, { samples: 2 }).samples).toBe(COMB_SAMPLES_RANGE.min);   // 8
    expect(setComb(3, { samples: 63.7 }).samples).toBe(64);                    // rounded
  });

  it('setComb clamps scale into 0.01..100', () => {
    expect(setComb(1, { scale: 0.0001 }).scale).toBe(COMB_SCALE_RANGE.min); // 0.01
    expect(setComb(2, { scale: 500 }).scale).toBe(COMB_SCALE_RANGE.max);    // 100
    expect(setComb(3, { scale: 2.5 }).scale).toBe(2.5);                     // in range
  });

  it('rejects non-finite scale / samples (falls back to default)', () => {
    expect(setComb(1, { scale: NaN }).scale).toBe(1);
    expect(setComb(2, { samples: Infinity }).samples).toBe(64);
  });

  it('round-trips through localStorage (per-id map)', () => {
    setComb(10, { on: true, scale: 2, samples: 128 });
    setComb(11, { on: false, scale: 0.5, samples: 32 });
    // A raw save is written by setComb; confirm the persisted blob shape.
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({
      10: { on: true, scale: 2, samples: 128 },
      11: { on: false, scale: 0.5, samples: 32 },
    });
    loadCombPrefs(); // simulate a fresh session
    expect(combFor(10)).toEqual({ on: true, scale: 2, samples: 128 });
    expect(combFor(11)).toEqual({ on: false, scale: 0.5, samples: 32 });
    // An id that was never stored still reads defaults.
    expect(combFor(99)).toEqual({ on: false, scale: 1, samples: 64 });
  });

  it('sanitizes hand-edited / out-of-range stored values on load', () => {
    localStorage.setItem(KEY, JSON.stringify({
      5: { on: true, scale: 999, samples: -3 },
      6: { on: 'yes', scale: 'big', samples: null }, // wrong types → defaults per field
    }));
    loadCombPrefs();
    expect(combFor(5)).toEqual({ on: true, scale: 100, samples: 8 });
    expect(combFor(6)).toEqual({ on: false, scale: 1, samples: 64 });
  });

  it('malformed storage falls back to all-defaults', () => {
    localStorage.setItem(KEY, '{not json');
    loadCombPrefs();
    expect(combFor(1)).toEqual({ on: false, scale: 1, samples: 64 });
  });

  it('saveCombPrefs persists the current in-memory map', () => {
    combFor(3).on = true;
    combFor(3).scale = 4;
    saveCombPrefs();
    loadCombPrefs();
    expect(combFor(3)).toEqual({ on: true, scale: 4, samples: 64 });
  });
});
