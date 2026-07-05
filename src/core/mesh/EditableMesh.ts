import { Vec3 } from '../math/vec3';

/**
 * BMesh-lite editable mesh (architecture decision A2).
 *
 * Storage is verts + polygon faces; edges and adjacency are derived on demand
 * and cached until the next topology change. Mutating methods bump `version`
 * so GPU caches know to re-upload.
 *
 * Undo does NOT diff this structure — commands snapshot with clone() (A4).
 */

export interface Vert {
  readonly id: number;
  co: Vec3;
}

export interface Face {
  readonly id: number;
  /** Ordered vert ids, CCW seen from outside. */
  verts: number[];
}

export interface Edge {
  /** Canonical key: `${min},${max}` of the two vert ids. */
  readonly key: string;
  readonly v0: number;
  readonly v1: number;
  /** Faces using this edge (1 = boundary, 2 = manifold interior). */
  readonly faces: number[];
}

export class EditableMesh {
  readonly verts = new Map<number, Vert>();
  readonly faces = new Map<number, Face>();
  version = 0;

  private nextVertId = 0;
  private nextFaceId = 0;
  private edgeCache: Map<string, Edge> | null = null;

  addVert(co: Vec3): number {
    const id = this.nextVertId++;
    this.verts.set(id, { id, co });
    this.touch();
    return id;
  }

  addFace(vertIds: number[]): number {
    if (vertIds.length < 3) throw new Error('Face needs at least 3 verts');
    for (const v of vertIds) {
      if (!this.verts.has(v)) throw new Error(`Face references missing vert ${v}`);
    }
    const id = this.nextFaceId++;
    this.faces.set(id, { id, verts: [...vertIds] });
    this.touch();
    return id;
  }

  /** Move a vert. Geometry-only change — bumps version but keeps edge cache. */
  setVertCo(id: number, co: Vec3): void {
    const v = this.verts.get(id);
    if (!v) throw new Error(`No vert ${id}`);
    v.co = co;
    this.version++;
  }

  /** Call after any topology change (add/remove verts/faces). */
  private touch(): void {
    this.version++;
    this.edgeCache = null;
  }

  static edgeKey(a: number, b: number): string {
    return a < b ? `${a},${b}` : `${b},${a}`;
  }

  edges(): Map<string, Edge> {
    if (this.edgeCache) return this.edgeCache;
    const edges = new Map<string, { key: string; v0: number; v1: number; faces: number[] }>();
    for (const face of this.faces.values()) {
      const n = face.verts.length;
      for (let i = 0; i < n; i++) {
        const a = face.verts[i], b = face.verts[(i + 1) % n];
        const key = EditableMesh.edgeKey(a, b);
        let e = edges.get(key);
        if (!e) {
          e = { key, v0: Math.min(a, b), v1: Math.max(a, b), faces: [] };
          edges.set(key, e);
        }
        e.faces.push(face.id);
      }
    }
    this.edgeCache = edges;
    return edges;
  }

  /** Face normal via Newell's method (robust for any polygon). */
  faceNormal(faceId: number): Vec3 {
    const face = this.faces.get(faceId);
    if (!face) throw new Error(`No face ${faceId}`);
    let nx = 0, ny = 0, nz = 0;
    const n = face.verts.length;
    for (let i = 0; i < n; i++) {
      const a = this.verts.get(face.verts[i])!.co;
      const b = this.verts.get(face.verts[(i + 1) % n])!.co;
      nx += (a.y - b.y) * (a.z + b.z);
      ny += (a.z - b.z) * (a.x + b.x);
      nz += (a.x - b.x) * (a.y + b.y);
    }
    return new Vec3(nx, ny, nz).normalize();
  }

  /** Deep copy — the undo system's snapshot primitive. */
  clone(): EditableMesh {
    const copy = new EditableMesh();
    for (const v of this.verts.values()) copy.verts.set(v.id, { id: v.id, co: v.co });
    for (const f of this.faces.values()) copy.faces.set(f.id, { id: f.id, verts: [...f.verts] });
    copy.nextVertId = this.nextVertId;
    copy.nextFaceId = this.nextFaceId;
    copy.version = this.version;
    return copy;
  }

  /** Replace contents with another mesh's (undo restore). */
  copyFrom(other: EditableMesh): void {
    this.verts.clear();
    this.faces.clear();
    for (const v of other.verts.values()) this.verts.set(v.id, { id: v.id, co: v.co });
    for (const f of other.faces.values()) this.faces.set(f.id, { id: f.id, verts: [...f.verts] });
    this.nextVertId = (other as EditableMesh)['nextVertId'];
    this.nextFaceId = (other as EditableMesh)['nextFaceId'];
    this.touch();
  }

  static fromData(positions: [number, number, number][], faces: number[][]): EditableMesh {
    const mesh = new EditableMesh();
    const ids = positions.map((p) => mesh.addVert(new Vec3(p[0], p[1], p[2])));
    for (const f of faces) mesh.addFace(f.map((i) => ids[i]));
    return mesh;
  }
}
