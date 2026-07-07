import type { Scene } from '../core/scene/Scene';

/**
 * Wavefront .obj import / export (task P3-1).
 *
 * Export is world-space (each object's transform is baked into its `v` lines)
 * with one `o` block per VISIBLE object. Face indices are GLOBAL 1-based and
 * accumulate across objects, matching the .obj spec. Numbers use the same
 * deterministic `toFixed(6)`-trimmed formatting as the scene JSON, so our own
 * export round-trips through parseObj structurally.
 *
 * Import parses only `v` and `f`; every other record (vt/vn/vp/s/usemtl/…) is
 * skipped silently. Faces support `f a b c`, `f a/b/c`, and NEGATIVE (relative)
 * indices per the spec. Objects split on `o`/`g`; a file with neither becomes a
 * single object named "imported".
 */

/** Round to 6 decimals, drop trailing zeros, collapse -0 → 0 (stable output). */
function fmt(n: number): string {
  const r = Number(n.toFixed(6));
  return String(r === 0 ? 0 : r);
}

/** Serialize all VISIBLE objects to a Wavefront .obj string. */
export function exportObj(scene: Scene): string {
  const lines: string[] = ['# Vibe Blender'];
  let base = 0; // running count of verts emitted (for global 1-based indices)

  for (const obj of scene.objects) {
    if (!scene.effectiveVisible(obj)) continue;
    if (obj.kind !== 'mesh') continue; // lights/cameras carry no geometry (P8-5)
    lines.push(`o ${obj.name}`);

    const mat = obj.transform.matrix();
    const local = new Map<number, number>(); // vertId → 0-based within this object
    let k = 0;
    for (const v of obj.mesh.verts.values()) {
      const w = mat.transformPoint(v.co); // local → world space
      lines.push(`v ${fmt(w.x)} ${fmt(w.y)} ${fmt(w.z)}`);
      local.set(v.id, k++);
    }

    for (const f of obj.mesh.faces.values()) {
      // Polygons stay as-is (no triangulation); indices are global + 1-based.
      const idx = f.verts.map((id) => base + local.get(id)! + 1);
      lines.push(`f ${idx.join(' ')}`);
    }

    base += obj.mesh.verts.size;
  }

  return lines.join('\n') + '\n';
}

export interface ParsedObj {
  name: string;
  positions: [number, number, number][];
  /** Face vertex indices, 0-based into this object's `positions`. */
  faces: number[][];
}

interface PendingObj {
  name: string;
  faces: number[][]; // global 0-based indices while parsing
}

/**
 * Parse a .obj into per-object geometry. Vertex indices in the file are global
 * (1-based, or negative = relative to verts seen so far); each returned object
 * remaps the verts its faces reference into a compact local `positions` array.
 * Throws a readable Error on garbage (no vertices, bad numbers, bad indices).
 */
export function parseObj(text: string): ParsedObj[] {
  const positions: [number, number, number][] = []; // global vertex table
  const objects: PendingObj[] = [];
  let current: PendingObj | null = null;
  let faceCount = 0;

  const startObject = (name: string): PendingObj => {
    const obj: PendingObj = { name, faces: [] };
    objects.push(obj);
    current = obj;
    return obj;
  };

  const resolveIndex = (token: string, lineNo: number): number => {
    // Take the vertex index only: `a`, `a/b`, `a/b/c`, `a//c`.
    const raw = token.split('/')[0];
    const n = Number.parseInt(raw, 10);
    if (!Number.isInteger(n) || n === 0) {
      throw new Error(`OBJ line ${lineNo}: invalid face index "${token}"`);
    }
    const i0 = n > 0 ? n - 1 : positions.length + n; // negative = relative
    if (i0 < 0 || i0 >= positions.length) {
      throw new Error(`OBJ line ${lineNo}: face index ${n} out of range`);
    }
    return i0;
  };

  const rawLines = text.split(/\r?\n/);
  for (let li = 0; li < rawLines.length; li++) {
    const line = rawLines[li].trim();
    if (line === '' || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const key = parts[0];

    if (key === 'v') {
      const x = Number(parts[1]), y = Number(parts[2]), z = Number(parts[3]);
      if (parts.length < 4 || ![x, y, z].every(Number.isFinite)) {
        throw new Error(`OBJ line ${li + 1}: malformed vertex "${line}"`);
      }
      positions.push([x, y, z]);
    } else if (key === 'o' || key === 'g') {
      startObject(parts.slice(1).join(' ') || 'object');
    } else if (key === 'f') {
      if (!current) current = startObject('imported');
      const idx = parts.slice(1).map((tok) => resolveIndex(tok, li + 1));
      if (idx.length < 3) throw new Error(`OBJ line ${li + 1}: face needs at least 3 verts`);
      current.faces.push(idx);
      faceCount++;
    }
    // Everything else (vt/vn/vp/s/usemtl/mtllib/…) is skipped silently.
  }

  if (positions.length === 0) throw new Error('OBJ has no vertices');
  if (faceCount === 0) throw new Error('OBJ has no faces');

  // Remap each object's faces onto a compact local vertex list.
  const result: ParsedObj[] = [];
  for (const obj of objects) {
    if (obj.faces.length === 0) continue; // skip empty groups (verts-only)
    const remap = new Map<number, number>(); // global 0-based → local
    const localPos: [number, number, number][] = [];
    const faces = obj.faces.map((f) =>
      f.map((g) => {
        let l = remap.get(g);
        if (l === undefined) {
          l = localPos.length;
          remap.set(g, l);
          localPos.push(positions[g]);
        }
        return l;
      }),
    );
    result.push({ name: obj.name, positions: localPos, faces });
  }

  return result;
}
