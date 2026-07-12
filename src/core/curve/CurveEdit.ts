/**
 * Curve Edit Mode selection state (UR11-1) — the curve analogue of the mesh
 * EditModeState. Tab on a curve enters this: control points are selectable
 * (like verts), and bezier points additionally expose their two handles.
 *
 * Selection is by point INDEX (into curve.points) plus a set of handle keys
 * `"<index>:hl"` / `"<index>:hr"`. `version` bumps on every change so the
 * overlay/pick caches can key off it.
 */
export type HandleSide = 'hl' | 'hr';

export function handleKey(index: number, side: HandleSide): string {
  return `${index}:${side}`;
}

export function parseHandleKey(key: string): { index: number; side: HandleSide } {
  const [i, s] = key.split(':');
  return { index: Number(i), side: s as HandleSide };
}

export class CurveEditState {
  /** Selected control-point indices (the anchors). */
  readonly points = new Set<number>();
  /** Selected handle keys ("i:hl" / "i:hr"). */
  readonly handles = new Set<string>();
  version = 0;

  constructor(readonly objectId: number) {}

  touch(): void {
    this.version++;
  }

  clearSelection(): void {
    this.points.clear();
    this.handles.clear();
    this.touch();
  }

  hasAnySelection(): boolean {
    return this.points.size > 0 || this.handles.size > 0;
  }

  /** Drop selection entries that no longer address a live point (post edit/undo). */
  prune(pointCount: number): void {
    let changed = false;
    for (const i of this.points) if (i >= pointCount) { this.points.delete(i); changed = true; }
    for (const k of this.handles) {
      if (parseHandleKey(k).index >= pointCount) { this.handles.delete(k); changed = true; }
    }
    if (changed) this.touch();
  }
}
