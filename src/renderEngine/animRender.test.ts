import { describe, expect, it } from 'vitest';
import { crc32, frameCount, buildStoreZip } from './animRender';

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
