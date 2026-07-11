import { describe, expect, it } from 'vitest';
import {
  crc32,
  frameCount,
  buildStoreZip,
  seedForFrame,
  ANIM_SEED_BASE,
  probeSupportedMp4,
  MP4_MIME_CANDIDATES,
} from './animRender';

describe('frameCount (inclusive range)', () => {
  it('counts both endpoints', () => {
    expect(frameCount(1, 5)).toBe(5);
    expect(frameCount(1, 1)).toBe(1);
    expect(frameCount(10, 12)).toBe(3);
    expect(frameCount(0, 47)).toBe(48);
  });
  it('floors fractional endpoints', () => {
    expect(frameCount(1.9, 5.2)).toBe(5);
  });
});

describe('crc32', () => {
  it('matches the canonical "123456789" check value', () => {
    const bytes = new TextEncoder().encode('123456789');
    expect(crc32(bytes) >>> 0).toBe(0xcbf43926);
  });
  it('is 0 for empty input', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('buildStoreZip', () => {
  const enc = new TextEncoder();

  it('produces parseable local file headers with correct CRC + store method', () => {
    const payload = enc.encode('hello vibe blender');
    const zip = buildStoreZip([{ name: 'frame_0001.png', data: payload }]);
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);

    // Local file header signature.
    expect(dv.getUint32(0, true)).toBe(0x04034b50);
    // Compression method 0 = store.
    expect(dv.getUint16(8, true)).toBe(0);
    // CRC32 field matches an independent CRC of the payload.
    expect(dv.getUint32(14, true)).toBe(crc32(payload));
    // Compressed size == uncompressed size == payload length (store).
    expect(dv.getUint32(18, true)).toBe(payload.length);
    expect(dv.getUint32(22, true)).toBe(payload.length);

    const nameLen = dv.getUint16(26, true);
    const name = new TextDecoder().decode(zip.subarray(30, 30 + nameLen));
    expect(name).toBe('frame_0001.png');

    // Stored bytes follow the name, uncompressed and byte-identical.
    const dataStart = 30 + nameLen;
    const stored = zip.subarray(dataStart, dataStart + payload.length);
    expect(Array.from(stored)).toEqual(Array.from(payload));
  });

  it('records every entry in the end-of-central-directory record', () => {
    const entries = [
      { name: 'a.bin', data: new Uint8Array([1, 2, 3]) },
      { name: 'b.bin', data: new Uint8Array([4, 5]) },
      { name: 'c.bin', data: new Uint8Array([6, 7, 8, 9]) },
    ];
    const zip = buildStoreZip(entries);
    // Find the EOCD signature (0x06054b50) near the tail.
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const eocdOffset = zip.length - 22;
    expect(dv.getUint32(eocdOffset, true)).toBe(0x06054b50);
    expect(dv.getUint16(eocdOffset + 8, true)).toBe(entries.length);
    expect(dv.getUint16(eocdOffset + 10, true)).toBe(entries.length);

    // Central-directory offset points at a central-dir header signature.
    const cenOffset = dv.getUint32(eocdOffset + 16, true);
    expect(dv.getUint32(cenOffset, true)).toBe(0x02014b50);
  });

  it('is deterministic (same input → identical bytes)', () => {
    const e = [{ name: 'x', data: enc.encode('same') }];
    expect(Array.from(buildStoreZip(e))).toEqual(Array.from(buildStoreZip(e)));
  });
});

describe('seedForFrame (per-frame tracer seed)', () => {
  it('is deterministic (same frame → same seed)', () => {
    expect(seedForFrame(7)).toBe(seedForFrame(7));
    expect(seedForFrame(7.9)).toBe(seedForFrame(7)); // floors the frame
  });
  it('differs between adjacent frames (static shots decorrelate)', () => {
    expect(seedForFrame(1)).not.toBe(seedForFrame(2));
    expect(seedForFrame(0)).not.toBe(seedForFrame(1));
    expect(seedForFrame(100)).not.toBe(seedForFrame(101));
  });
  it('returns an unsigned 32-bit integer', () => {
    for (const f of [0, 1, 42, 250, 9999]) {
      const s = seedForFrame(f);
      expect(s).toBe(s >>> 0);
      expect(Number.isInteger(s)).toBe(true);
    }
  });
  it('is anchored to the F12 base seed (frame 0 = base)', () => {
    // frame 0 → base ^ 0 = base, so the first frame matches the live F12 look.
    expect(seedForFrame(0)).toBe(ANIM_SEED_BASE >>> 0);
  });
});

describe('probeSupportedMp4 (format shortlist)', () => {
  it('returns the first supported candidate', () => {
    const supported = new Set([MP4_MIME_CANDIDATES[2], MP4_MIME_CANDIDATES[3]]);
    expect(probeSupportedMp4((t) => supported.has(t))).toBe(MP4_MIME_CANDIDATES[2]);
  });
  it('prefers the most-specific candidate when several are supported', () => {
    expect(probeSupportedMp4(() => true)).toBe(MP4_MIME_CANDIDATES[0]);
  });
  it('returns null when nothing is supported (option hidden)', () => {
    expect(probeSupportedMp4(() => false)).toBeNull();
  });
  it('probes the candidates in order, stopping at the first hit', () => {
    const seen: string[] = [];
    probeSupportedMp4((t) => { seen.push(t); return t === MP4_MIME_CANDIDATES[1]; });
    expect(seen).toEqual([MP4_MIME_CANDIDATES[0], MP4_MIME_CANDIDATES[1]]);
  });
});
