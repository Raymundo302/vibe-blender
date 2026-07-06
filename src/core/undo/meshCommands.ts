import type { Command } from './UndoStack';
import type { EditableMesh } from '../mesh/EditableMesh';

/**
 * Snapshot-based mesh undo (architecture decision A4): topology operators
 * wrap their mutation in capture(), which deep-copies the mesh before and
 * after. Boring and always correct — no inverse-operation code to get wrong.
 *
 * Usage (the ONLY way edit-mode tools should touch topology):
 *   const cmd = MeshEditCommand.capture('Extrude', mesh, () => {
 *     ...mutate mesh via its public API...
 *   });
 *   undo.push(cmd);
 */
export class MeshEditCommand implements Command {
  private constructor(
    readonly name: string,
    private readonly mesh: EditableMesh,
    private readonly before: EditableMesh,
    private readonly after: EditableMesh,
  ) {}

  static capture(name: string, mesh: EditableMesh, mutate: () => void): MeshEditCommand {
    const before = mesh.clone();
    mutate();
    return new MeshEditCommand(name, mesh, before, mesh.clone());
  }

  undo(): void {
    this.mesh.copyFrom(this.before);
  }

  redo(): void {
    this.mesh.copyFrom(this.after);
  }
}
