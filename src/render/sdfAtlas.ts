import { buildMeshSdf, SDF_RES } from './sdf';
import { Mat4 } from '../core/math/mat4';
import { Vec3 } from '../core/math/vec3';
import type { Scene, SceneObject } from '../core/scene/Scene';

/**
 * GPU home of the per-object voxel SDFs the Object AO mode marches against:
 * one 3D texture atlas of MAX_SDF_OBJECTS fixed SDF_RES³ slots (8×4×1 layout,
 * R8). Slots are cached by the same composite version key
 * the Renderer's GpuMesh cache uses, so transform changes are free and only
 * mesh / modifier edits re-voxelize. sync() returns the packed uniform arrays
 * the AO shader consumes each frame.
 */

export const MAX_SDF_OBJECTS = 32;
const SLOTS_X = 8;
const SLOTS_Y = 4;
export const SDF_ATLAS_W = SLOTS_X * SDF_RES;  // 256
export const SDF_ATLAS_H = SLOTS_Y * SDF_RES;  // 128
export const SDF_ATLAS_D = SDF_RES;            // 32

export interface SdfSceneData {
  texture: WebGLTexture;
  count: number;
  /** count× column-major mat4: world position → SDF grid uvw in [0,1]. */
  worldToUvw: Float32Array;
  /** count× vec4: (boxSize.xyz local units, localToWorld min-axis scale). */
  info: Float32Array;
  /** count× vec4: (slot origin in atlas voxels xyz, encode half-range R). */
  slot: Float32Array;
}

interface SlotEntry {
  slot: number;
  version: string;
  boxMin: [number, number, number];
  boxSize: [number, number, number];
  maxDist: number;
  /** Empty meshes build no SDF; keep the entry so we don't retry every frame. */
  empty: boolean;
  /** performance.now() of the last voxelization (rebuild throttling). */
  builtAt: number;
}

/** Min ms between re-voxelizations of one object: a modal edit bumps the mesh
 *  version every mouse move, and an 18k-face donut icing takes tens of ms to
 *  voxelize — without a throttle the drag would hitch every frame. A slightly
 *  stale field during the drag is invisible; the final state lands within a
 *  frame or two of the last change. */
const REBUILD_MIN_MS = 150;

export class SdfAtlas {
  readonly texture: WebGLTexture;
  private readonly entries = new Map<number, SlotEntry>(); // object id → slot
  private readonly worldToUvw = new Float32Array(MAX_SDF_OBJECTS * 16);
  private readonly info = new Float32Array(MAX_SDF_OBJECTS * 4);
  private readonly slot = new Float32Array(MAX_SDF_OBJECTS * 4);

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, this.texture);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, SDF_ATLAS_W, SDF_ATLAS_H, SDF_ATLAS_D, 0,
      gl.RED, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_3D, null);
  }

  private slotOrigin(slot: number): [number, number, number] {
    return [(slot % SLOTS_X) * SDF_RES, (Math.floor(slot / SLOTS_X) % SLOTS_Y) * SDF_RES, 0];
  }

  /**
   * Bring the atlas up to date for the given mesh objects (visible meshes, in
   * draw order) and pack the shader uniform arrays. Objects beyond
   * MAX_SDF_OBJECTS are dropped from the field (nearest-first would be nicer;
   * scenes that large are beyond this viewport feature's scope).
   */
  sync(scene: Scene, objs: SceneObject[]): SdfSceneData {
    const gl = this.gl;
    const current = objs.slice(0, MAX_SDF_OBJECTS);
    const currentIds = new Set(current.map((o) => o.id));

    // Free slots of departed objects only when we actually need room.
    const used = new Set([...this.entries.values()].map((e) => e.slot));
    const freeSlot = (): number => {
      for (let s = 0; s < MAX_SDF_OBJECTS; s++) if (!used.has(s)) return s;
      for (const [id, e] of this.entries) {
        if (!currentIds.has(id)) {
          this.entries.delete(id);
          return e.slot;
        }
      }
      return -1; // unreachable: current.length <= MAX_SDF_OBJECTS
    };

    let count = 0;
    let bound = false;
    for (const obj of current) {
      const editing = scene.editMode?.objectId === obj.id;
      const mesh = editing ? obj.mesh : obj.evaluatedMesh(scene.modifierContext(obj));
      const version = `${editing ? 'edit' : 'obj'}:${mesh.version}:${obj.modifiersVersion}`;

      let entry = this.entries.get(obj.id);
      const now = performance.now();
      if ((!entry || entry.version !== version)
          && !(entry && now - entry.builtAt < REBUILD_MIN_MS)) {
        const sdf = buildMeshSdf(mesh);
        const slot = entry ? entry.slot : freeSlot();
        if (!entry) used.add(slot);
        if (sdf) {
          const [ox, oy, oz] = this.slotOrigin(slot);
          if (!bound) { gl.bindTexture(gl.TEXTURE_3D, this.texture); bound = true; }
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
          gl.texSubImage3D(gl.TEXTURE_3D, 0, ox, oy, oz, SDF_RES, SDF_RES, SDF_RES,
            gl.RED, gl.UNSIGNED_BYTE, sdf.data);
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
          entry = { slot, version, boxMin: sdf.boxMin, boxSize: sdf.boxSize, maxDist: sdf.maxDist, empty: false, builtAt: now };
        } else {
          entry = { slot, version, boxMin: [0, 0, 0], boxSize: [1, 1, 1], maxDist: 1, empty: true, builtAt: now };
        }
        this.entries.set(obj.id, entry);
      }
      if (entry.empty) continue;

      // world → local → grid uvw, folded into one matrix:
      //   uvw = scale(1/boxSize) · translate(-boxMin) · inverse(world)
      const world = scene.worldMatrix(obj);
      const w2uvw = Mat4.scaling(new Vec3(1 / entry.boxSize[0], 1 / entry.boxSize[1], 1 / entry.boxSize[2]))
        .mul(Mat4.translation(new Vec3(-entry.boxMin[0], -entry.boxMin[1], -entry.boxMin[2])))
        .mul(world.invert());
      this.worldToUvw.set(w2uvw.m, count * 16);

      // Conservative local→world distance scale: the smallest axis scale of
      // the world matrix (columns of the upper 3×3). Underestimating distance
      // is safe for the march; non-uniform scale over-occludes slightly.
      const m = world.m;
      const s = Math.min(
        Math.hypot(m[0], m[1], m[2]),
        Math.hypot(m[4], m[5], m[6]),
        Math.hypot(m[8], m[9], m[10]),
      );
      const i4 = count * 4;
      this.info[i4] = entry.boxSize[0];
      this.info[i4 + 1] = entry.boxSize[1];
      this.info[i4 + 2] = entry.boxSize[2];
      this.info[i4 + 3] = s;
      const [ox, oy, oz] = this.slotOrigin(entry.slot);
      this.slot[i4] = ox;
      this.slot[i4 + 1] = oy;
      this.slot[i4 + 2] = oz;
      this.slot[i4 + 3] = entry.maxDist;
      count++;
    }
    if (bound) gl.bindTexture(gl.TEXTURE_3D, null);

    return { texture: this.texture, count, worldToUvw: this.worldToUvw, info: this.info, slot: this.slot };
  }
}
