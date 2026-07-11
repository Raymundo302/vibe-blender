import type { Command } from './UndoStack';
import type { EditableMesh } from '../mesh/EditableMesh';

/**
 * One undo entry for the whole Intersect run (see `tools/intersectTool.ts`).
 * Composes per-mesh clone() snapshots for every mesh the run touched — the same
 * whole-mesh snapshot approach as JoinObjectsCommand / SeparateCommand (A4). The
 * three arrays are parallel: `meshes[i]` is restored from `before[i]` on undo and
 * `after[i]` on redo, so Ctrl+Z restores every edited mesh exactly (vert counts
 * AND positions).
 */
export class EmbedIntersectionsCommand implements Command {
  readonly name = 'Intersect';

  constructor(
    private readonly meshes: EditableMesh[],
    private readonly before: EditableMesh[],
    private readonly after: EditableMesh[],
  ) {}

  undo(): void {
    for (let i = 0; i < this.meshes.length; i++) this.meshes[i].copyFrom(this.before[i]);
  }

  redo(): void {
    for (let i = 0; i < this.meshes.length; i++) this.meshes[i].copyFrom(this.after[i]);
  }
}
