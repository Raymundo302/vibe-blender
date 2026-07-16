import type { Command } from './UndoStack';
import type { SceneObject } from '../scene/Scene';
import { cloneSurfaceData, type SurfaceData } from '../scene/objectData';
import type { EditableMesh } from '../mesh/EditableMesh';

/**
 * Whole-payload snapshot undo for surface edits (NB-CORE) — the surface
 * analogue of CurveCommand. A surface payload is plain data (a few hundred
 * control points at most), so snapshotting the entire SurfaceData covers every
 * mutation (point moves, weight edits, degree/span ops, trims) with one shape.
 *
 * The DERIVED tessellation mesh is NOT snapshotted: the surface driver
 * regenerates it from the payload after undo/redo (signature mismatch), the
 * same way text meshes rebuild from TextData.
 */
export class SurfaceCommand implements Command {
  constructor(
    readonly name: string,
    private readonly obj: SceneObject,
    private readonly before: SurfaceData,
    private readonly after: SurfaceData,
  ) {}

  undo(): void {
    this.obj.surface = cloneSurfaceData(this.before);
  }

  redo(): void {
    this.obj.surface = cloneSurfaceData(this.after);
  }

  /** Snapshot the object's surface, run `mutate`, snapshot again. */
  static capture(name: string, obj: SceneObject, mutate: () => void): SurfaceCommand {
    const before = cloneSurfaceData(obj.surface!);
    mutate();
    const after = cloneSurfaceData(obj.surface!);
    return new SurfaceCommand(name, obj, before, after);
  }

  /** Build from explicit before/after snapshots (modal move commit). */
  static fromSnapshots(name: string, obj: SceneObject, before: SurfaceData, after: SurfaceData): SurfaceCommand {
    return new SurfaceCommand(name, obj, cloneSurfaceData(before), cloneSurfaceData(after));
  }
}

/**
 * The payload fields whose change requires re-tessellation — the surface
 * driver's dirt check (textSignature's pattern). Trim/COS curves affect the
 * mesh; showNet does not (it's an overlay flag).
 */
export function surfaceSignature(s: SurfaceData): string {
  return JSON.stringify({
    du: s.degreeU, dv: s.degreeV, nu: s.pointsU, nv: s.pointsV,
    pts: s.points, ku: s.knotsU, kv: s.knotsV, tess: s.tess, trims: s.trims,
  });
}

/**
 * Assign a freshly tessellated mesh to a surface object — the assignTextMesh
 * contract: replace obj.mesh and bump the version PAST the old one so the
 * GPU/pick caches (keyed on obj.id + mesh.version) re-upload instead of
 * colliding with a stale entry.
 */
export function assignSurfaceMesh(obj: SceneObject, mesh: EditableMesh): void {
  const prev = obj.mesh ? obj.mesh.version : 0;
  mesh.version = prev + 1;
  obj.mesh = mesh;
}
