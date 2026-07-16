import type { Scene, SceneObject } from '../core/scene/Scene';
import { tessellateSurface } from '../core/nurbs/tessellate';
import { assignSurfaceMesh, surfaceSignature } from '../core/undo/surfaceCommands';

/**
 * Surface-object runtime (NB-CORE): turns a SurfaceData payload into the
 * object's mesh via the NURBS tessellator, and a frame-loop driver that
 * regenerates that mesh whenever the payload changes — the TextDriver pattern
 * exactly (payload = source of truth, mesh = derived). Pure math underneath
 * (unlike text there is no canvas dependency), but the driver keeps ONE
 * regeneration path so undo, edit tools, and the properties tab never each
 * roll their own.
 */

/** Rebuild `obj`'s mesh from its surface payload NOW (no-op for non-surface). */
export function regenerateSurfaceMesh(obj: SceneObject): void {
  if (obj.kind !== 'surface' || !obj.surface) return;
  assignSurfaceMesh(obj, tessellateSurface(obj.surface).mesh);
}

/**
 * Regenerates each surface object's mesh from its payload when the payload's
 * mesh-affecting signature changes (control points, knots, degrees, tess
 * options, trims — NOT showNet). Ticked in the main frame loop next to the
 * text driver.
 */
export class SurfaceDriver {
  private readonly sigs = new WeakMap<SceneObject, string>();

  constructor(private readonly scene: Scene) {}

  tick(): void {
    for (const obj of this.scene.objects) {
      if (obj.kind !== 'surface' || !obj.surface) continue;
      const sig = surfaceSignature(obj.surface);
      if (this.sigs.get(obj) === sig) continue;
      regenerateSurfaceMesh(obj);
      this.sigs.set(obj, sig);
    }
  }

  /** Force-rebuild a specific object next tick. */
  invalidate(obj: SceneObject): void {
    this.sigs.delete(obj);
  }

  /** Synchronous rebuild of every dirty surface mesh (e2e/tests). */
  syncAll(): void {
    this.tick();
  }
}
