import type { EditableMesh } from '../mesh/EditableMesh';
import { EditableMesh as EM } from '../mesh/EditableMesh';

export type ElementMode = 'vert' | 'edge' | 'face';

/**
 * Selection state while editing one object's mesh (Blender's Edit Mode).
 * Verts are selected by id, edges by canonical key ("a,b"), faces by id.
 *
 * `version` bumps on every selection/mode change — the edit overlay and
 * element-picking passes use (mesh.version, sel.version) as their cache key.
 */
export class EditModeState {
  elementMode: ElementMode = 'vert';
  readonly verts = new Set<number>();
  readonly edges = new Set<string>();
  readonly faces = new Set<number>();
  version = 0;

  constructor(readonly objectId: number) {}

  touch(): void {
    this.version++;
  }

  clearSelection(): void {
    this.verts.clear();
    this.edges.clear();
    this.faces.clear();
    this.touch();
  }

  /**
   * The verts implied by the current selection — what G/R/S actually move.
   * Vert mode: the verts themselves; edge mode: endpoints; face mode: corners.
   */
  selectedVertIds(mesh: EditableMesh): Set<number> {
    const out = new Set<number>();
    if (this.elementMode === 'vert') {
      for (const v of this.verts) if (mesh.verts.has(v)) out.add(v);
    } else if (this.elementMode === 'edge') {
      const edges = mesh.edges();
      for (const key of this.edges) {
        const e = edges.get(key);
        if (e) { out.add(e.v0); out.add(e.v1); }
      }
    } else {
      for (const fid of this.faces) {
        const f = mesh.faces.get(fid);
        if (f) for (const v of f.verts) out.add(v);
      }
    }
    return out;
  }

  /**
   * Switch element mode, deriving the new selection Blender-style: the set of
   * selected verts carries over; edges/faces are selected when ALL their verts
   * were selected.
   */
  setElementMode(mode: ElementMode, mesh: EditableMesh): void {
    if (mode === this.elementMode) return;
    const vertIds = this.selectedVertIds(mesh);
    this.elementMode = mode;
    this.verts.clear();
    this.edges.clear();
    this.faces.clear();

    if (mode === 'vert') {
      for (const v of vertIds) this.verts.add(v);
    } else if (mode === 'edge') {
      for (const e of mesh.edges().values()) {
        if (vertIds.has(e.v0) && vertIds.has(e.v1)) this.edges.add(e.key);
      }
    } else {
      for (const f of mesh.faces.values()) {
        if (f.verts.every((v) => vertIds.has(v))) this.faces.add(f.id);
      }
    }
    this.touch();
  }

  /** Drop selected elements that no longer exist (after topology edits/undo). */
  prune(mesh: EditableMesh): void {
    let changed = false;
    for (const v of this.verts) if (!mesh.verts.has(v)) { this.verts.delete(v); changed = true; }
    const edges = mesh.edges();
    for (const k of this.edges) if (!edges.has(k)) { this.edges.delete(k); changed = true; }
    for (const f of this.faces) if (!mesh.faces.has(f)) { this.faces.delete(f); changed = true; }
    if (changed) this.touch();
  }

  selectAll(mesh: EditableMesh): void {
    this.clearSelection();
    if (this.elementMode === 'vert') for (const v of mesh.verts.keys()) this.verts.add(v);
    else if (this.elementMode === 'edge') for (const k of mesh.edges().keys()) this.edges.add(k);
    else for (const f of mesh.faces.keys()) this.faces.add(f);
    this.touch();
  }

  /** Is this element selected? (for the current mode's element kind) */
  isVertSelected(id: number): boolean { return this.verts.has(id); }
  isEdgeSelected(a: number, b: number): boolean { return this.edges.has(EM.edgeKey(a, b)); }
  isFaceSelected(id: number): boolean { return this.faces.has(id); }
}
