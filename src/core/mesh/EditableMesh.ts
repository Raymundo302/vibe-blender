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
  /**
   * Per-edge crease weights (0..1), keyed by edgeKey. 1 = fully sharp under
   * Subdivision Surface. Entries whose verts vanish are ignored by consumers
   * and pruned at serialization time.
   */
  readonly creases = new Map<string, number>();
  /**
   * Per-face display tints (linear RGB multiplier), e.g. Scatter's random
   * per-instance colors. Faces without an entry render untinted (white).
   */
  readonly faceTints = new Map<number, [number, number, number]>();
  /**
   * Per-face-corner UV coordinates (P11): faceId → [u,v] per corner, parallel
   * to face.verts. Corner storage (Blender's loops) lets seams give the same
   * vert different UVs per island. Faces without an entry sample (0,0).
   */
  readonly uvs = new Map<number, [number, number][]>();
  /** UV seam edges (P11), keyed by edgeKey — consumed by the unwrapper. */
  readonly seams = new Set<string>();
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

  /** Set the crease weight (clamped 0..1) of the edge between two verts. 0 clears it. */
  setCrease(a: number, b: number, weight: number): void {
    const key = EditableMesh.edgeKey(a, b);
    const w = Math.max(0, Math.min(1, weight));
    if (w === 0) this.creases.delete(key);
    else this.creases.set(key, w);
    this.version++;
  }

  /** Crease weight of the edge between two verts (0 when unset). */
  crease(a: number, b: number): number {
    return this.creases.get(EditableMesh.edgeKey(a, b)) ?? 0;
  }

  /**
   * Set a face's per-corner UVs. Length must match the face's corner count.
   * Pass null to clear. Bumps version (GPU re-upload) but keeps topology.
   */
  setFaceUVs(faceId: number, uvs: [number, number][] | null): void {
    const face = this.faces.get(faceId);
    if (!face) throw new Error(`No face ${faceId}`);
    if (uvs === null) {
      this.uvs.delete(faceId);
    } else {
      if (uvs.length !== face.verts.length) {
        throw new Error(`Face ${faceId} has ${face.verts.length} corners, got ${uvs.length} UVs`);
      }
      this.uvs.set(faceId, uvs.map(([u, v]) => [u, v] as [number, number]));
    }
    this.version++;
  }

  /** Mark or clear a UV seam on the edge between two verts. Bumps version. */
  setSeam(a: number, b: number, on: boolean): void {
    const key = EditableMesh.edgeKey(a, b);
    if (on) this.seams.add(key);
    else this.seams.delete(key);
    this.version++;
  }

  isSeam(a: number, b: number): boolean {
    return this.seams.has(EditableMesh.edgeKey(a, b));
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

  /** Ids of faces that use this vert. */
  facesOfVert(vertId: number): number[] {
    const out: number[] = [];
    for (const f of this.faces.values()) if (f.verts.includes(vertId)) out.push(f.id);
    return out;
  }

  /** Delete faces by id. Verts are kept (they become floating points). */
  deleteFaces(ids: Iterable<number>): void {
    let changed = false;
    for (const id of ids) changed = this.faces.delete(id) || changed;
    if (changed) this.touch();
  }

  /** Delete verts and cascade: any face using one of them goes too. */
  deleteVerts(ids: Iterable<number>): void {
    const doomed = new Set(ids);
    if (doomed.size === 0) return;
    for (const f of [...this.faces.values()]) {
      if (f.verts.some((v) => doomed.has(v))) this.faces.delete(f.id);
    }
    for (const v of doomed) this.verts.delete(v);
    this.touch();
  }

  /** Delete edges (by canonical key) and cascade: faces using them go too. Verts stay. */
  deleteEdges(keys: Iterable<string>): void {
    const doomed = new Set(keys);
    if (doomed.size === 0) return;
    for (const f of [...this.faces.values()]) {
      const n = f.verts.length;
      let hit = false;
      for (let i = 0; i < n && !hit; i++) {
        hit = doomed.has(EditableMesh.edgeKey(f.verts[i], f.verts[(i + 1) % n]));
      }
      if (hit) this.faces.delete(f.id);
    }
    this.touch();
  }

  /**
   * Merge verts into one at their centroid (Blender's Merge → At Center).
   * The lowest id survives; faces are remapped, consecutive duplicate corners
   * collapse, and faces left with < 3 distinct verts are removed.
   * Returns the surviving vert id (or null if fewer than 2 verts given).
   */
  mergeVertsAtCenter(ids: Iterable<number>): number | null {
    const group = [...new Set(ids)].filter((id) => this.verts.has(id)).sort((a, b) => a - b);
    if (group.length < 2) return null;
    const keep = group[0];

    let sum = new Vec3();
    for (const id of group) sum = sum.add(this.verts.get(id)!.co);
    this.verts.get(keep)!.co = sum.scale(1 / group.length);

    const doomed = new Set(group.slice(1));
    for (const f of [...this.faces.values()]) {
      const remapped = f.verts.map((v) => (doomed.has(v) ? keep : v));
      // collapse consecutive duplicates, cyclically
      const collapsed = remapped.filter((v, i) => v !== remapped[(i + 1) % remapped.length]);
      if (new Set(collapsed).size < 3) this.faces.delete(f.id);
      else f.verts = collapsed;
    }
    for (const v of doomed) this.verts.delete(v);
    this.touch();
    return keep;
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
    for (const [k, w] of this.creases) copy.creases.set(k, w);
    for (const [f, t] of this.faceTints) copy.faceTints.set(f, [t[0], t[1], t[2]]);
    for (const [f, us] of this.uvs) copy.uvs.set(f, us.map(([u, v]) => [u, v] as [number, number]));
    for (const s of this.seams) copy.seams.add(s);
    copy.nextVertId = this.nextVertId;
    copy.nextFaceId = this.nextFaceId;
    copy.version = this.version;
    return copy;
  }

  /** Replace contents with another mesh's (undo restore). */
  copyFrom(other: EditableMesh): void {
    if (other === this) return; // self-assignment would clear-then-copy-nothing
    this.verts.clear();
    this.faces.clear();
    this.creases.clear();
    this.faceTints.clear();
    this.uvs.clear();
    this.seams.clear();
    for (const v of other.verts.values()) this.verts.set(v.id, { id: v.id, co: v.co });
    for (const f of other.faces.values()) this.faces.set(f.id, { id: f.id, verts: [...f.verts] });
    for (const [k, w] of other.creases) this.creases.set(k, w);
    for (const [f, t] of other.faceTints) this.faceTints.set(f, [t[0], t[1], t[2]]);
    for (const [f, us] of other.uvs) this.uvs.set(f, us.map(([u, v]) => [u, v] as [number, number]));
    for (const s of other.seams) this.seams.add(s);
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
