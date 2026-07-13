import { describe, it, expect, beforeEach } from 'vitest';
import {
  objectTypes, defaultObjectTypePrefs, loadObjectTypePrefs, saveObjectTypePrefs,
  typeShown, typePickable, TYPE_KINDS,
} from './objectTypePrefs';

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

describe('objectTypePrefs', () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset the singleton to defaults between tests.
    const d = defaultObjectTypePrefs();
    for (const k of TYPE_KINDS) objectTypes[k] = { ...d[k] };
  });

  it('defaults every type to shown + selectable', () => {
    const d = defaultObjectTypePrefs();
    for (const k of TYPE_KINDS) {
      expect(d[k].show).toBe(true);
      expect(d[k].select).toBe(true);
    }
  });

  it('typeShown / typePickable reflect the singleton', () => {
    objectTypes.mesh = { show: true, select: false };
    expect(typeShown('mesh')).toBe(true);
    expect(typePickable('mesh')).toBe(false); // shown but not selectable
    objectTypes.light = { show: false, select: true };
    expect(typeShown('light')).toBe(false);
    expect(typePickable('light')).toBe(false); // hidden ⇒ not pickable
  });

  it('round-trips through localStorage', () => {
    objectTypes.camera = { show: false, select: false };
    objectTypes.curve = { show: true, select: false };
    saveObjectTypePrefs();
    // Wipe the singleton, then reload.
    for (const k of TYPE_KINDS) objectTypes[k] = { show: true, select: true };
    const loaded = loadObjectTypePrefs();
    expect(loaded).toBe(objectTypes);
    expect(objectTypes.camera).toEqual({ show: false, select: false });
    expect(objectTypes.curve).toEqual({ show: true, select: false });
    expect(objectTypes.mesh).toEqual({ show: true, select: true }); // untouched key defaults
  });

  it('malformed storage falls back to defaults', () => {
    localStorage.setItem('vibe-object-types', '{not json');
    loadObjectTypePrefs();
    for (const k of TYPE_KINDS) expect(objectTypes[k]).toEqual({ show: true, select: true });
  });
});
