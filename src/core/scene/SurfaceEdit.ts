/**
 * Surface Edit Mode selection state (NB-CORE) — the surface analogue of
 * CurveEditState. Tab on a surface object enters this: control-net points are
 * selectable by FLAT index (iu*pointsV + iv, the SurfaceData grid convention).
 * `version` bumps on every change so overlay/pick caches can key off it.
 */
export class SurfaceEditState {
  /** Selected control-point flat indices (into surface.points). */
  readonly points = new Set<number>();
  version = 0;

  constructor(readonly objectId: number) {}

  touch(): void {
    this.version++;
  }

  clearSelection(): void {
    this.points.clear();
    this.touch();
  }

  hasAnySelection(): boolean {
    return this.points.size > 0;
  }

  /** Drop selection entries that no longer address a live point (post edit/undo). */
  prune(pointCount: number): void {
    let changed = false;
    for (const i of this.points) if (i >= pointCount) { this.points.delete(i); changed = true; }
    if (changed) this.touch();
  }
}
