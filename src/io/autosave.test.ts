import { describe, it, expect } from 'vitest';
import {
  wrapAutosave,
  parseAutosave,
  AUTOSAVE_FORMAT,
  AUTOSAVE_VERSION,
} from './autosave';

/**
 * The autosave envelope is pure data — no DOM, no localStorage — so we can test
 * the wrapper shape and round-trip directly (the interval + storage side of the
 * feature is exercised by the e2e suite, per the P6-4 spec).
 */
describe('autosave wrapper', () => {
  it('wraps a scene string with format/version/timestamp', () => {
    const w = wrapAutosave('SCENE_JSON', 1234);
    expect(w).toEqual({
      format: AUTOSAVE_FORMAT,
      version: AUTOSAVE_VERSION,
      savedAt: 1234,
      scene: 'SCENE_JSON',
    });
  });

  it('defaults savedAt to the current time', () => {
    const before = Date.now();
    const w = wrapAutosave('X');
    expect(w.savedAt).toBeGreaterThanOrEqual(before);
    expect(w.savedAt).toBeLessThanOrEqual(Date.now());
  });

  it('round-trips through JSON', () => {
    const w = wrapAutosave('{"objects":[]}', 42);
    const back = parseAutosave(JSON.stringify(w));
    expect(back).toEqual(w);
  });

  it('returns null for missing / non-JSON / foreign payloads', () => {
    expect(parseAutosave(null)).toBeNull();
    expect(parseAutosave('{ not json')).toBeNull();
    expect(parseAutosave('"a string"')).toBeNull();
    expect(parseAutosave('42')).toBeNull();
    expect(parseAutosave(JSON.stringify({ format: 'other', version: 1, savedAt: 0, scene: 'x' }))).toBeNull();
    expect(parseAutosave(JSON.stringify({ format: AUTOSAVE_FORMAT, version: 1 }))).toBeNull();
    expect(parseAutosave(JSON.stringify({ format: AUTOSAVE_FORMAT, version: 1, savedAt: 0, scene: 5 }))).toBeNull();
  });
});
