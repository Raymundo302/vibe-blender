import type { Command } from './UndoStack';
import type { Scene, SceneObject } from '../scene/Scene';
import type { EditModeState } from '../scene/EditMode';
import { EditableMesh } from '../mesh/EditableMesh';
import { extractFaces } from '../mesh/ops/separate';

/**
 * Separate selected faces into a new object (Blender's Separate → Selection,
 * `P`). The selected faces — and the verts used ONLY by them — leave the source;
 * seam verts (shared with unselected faces) duplicate into the new mesh. The new
 * object inherits the source's transform/color/shadeSmooth (NOT its modifier
 * stack, matching Blender). We stay in edit mode on the source.
 *
 * Perform-style like JoinObjectsCommand/DeleteObjectsCommand: `perform()`
 * captures state, mutates, and returns the command ready to push. Returns null
 * (nothing pushed) when there is no valid face selection to separate: not in
 * edit mode, not face mode, an empty selection, or the whole mesh selected
 * (which would leave an empty source). The InputManager reports those cases with
 * a specific status message before calling perform.
 */

/** Blender-style unique name: try `desired`, else append the lowest free `.NNN`. */
function uniqueName(scene: Scene, desired: string): string {
  const used = new Set(scene.objects.map((o) => o.name));
  if (!used.has(desired)) return desired;
  for (let n = 1; n < 1000; n++) {
    const candidate = `${desired}.${String(n).padStart(3, '0')}`;
    if (!used.has(candidate)) return candidate;
  }
  return desired;
}

interface SelSnapshot {
  mode: EditModeState['elementMode'];
  verts: number[];
  edges: string[];
  faces: number[];
}

export class SeparateCommand implements Command {
  private constructor(
    readonly name: string,
    private readonly scene: Scene,
    private readonly source: SceneObject,
    private readonly meshBefore: EditableMesh,
    private readonly meshAfter: EditableMesh,
    private readonly created: SceneObject,
    private readonly createdIndex: number,
    /** The edit state to restore selection into (matched by identity on undo/redo). */
    private readonly edit: EditModeState,
    private readonly selBefore: SelSnapshot,
    private readonly selAfter: SelSnapshot,
  ) {}

  static perform(name: string, scene: Scene): SeparateCommand | null {
    const edit = scene.editMode;
    const source = scene.editObject;
    if (!edit || !source) return null;
    if (edit.elementMode !== 'face') return null;

    const faceIds = [...edit.faces].filter((id) => source.mesh.faces.has(id));
    if (faceIds.length === 0) return null;
    if (faceIds.length === source.mesh.faces.size) return null; // whole mesh — refuse

    const meshBefore = source.mesh.clone();
    const selBefore = snapshotSelection(edit);

    // Build the new object from the extracted shell.
    const { removed, orphanVertIds } = extractFaces(source.mesh, faceIds);
    const created = scene.add(uniqueName(scene, `${source.name}.sep`), removed);
    created.transform = source.transform; // Transform is immutable — sharing is safe.
    created.color = [...source.color];
    created.shadeSmooth = source.shadeSmooth;
    const createdIndex = scene.objects.indexOf(created);

    // Drop the separated faces and their now-floating verts from the source.
    source.mesh.deleteFaces(faceIds);
    source.mesh.deleteVerts(orphanVertIds);
    const meshAfter = source.mesh.clone();

    edit.prune(source.mesh);
    edit.touch();
    const selAfter = snapshotSelection(edit);

    return new SeparateCommand(
      name, scene, source, meshBefore, meshAfter, created, createdIndex,
      edit, selBefore, selAfter,
    );
  }

  undo(): void {
    this.scene.remove(this.created.id);
    this.source.mesh.copyFrom(this.meshBefore);
    this.restoreSelection(this.selBefore);
  }

  redo(): void {
    this.source.mesh.copyFrom(this.meshAfter);
    this.scene.insertAt(this.created, this.createdIndex);
    this.restoreSelection(this.selAfter);
  }

  private restoreSelection(snap: SelSnapshot): void {
    // Only touch the selection if we're still editing the same object (the user
    // may have left edit mode). The mesh restore above is what undo really needs.
    if (this.scene.editMode !== this.edit) return;
    this.edit.elementMode = snap.mode;
    this.edit.verts.clear();
    this.edit.edges.clear();
    this.edit.faces.clear();
    for (const v of snap.verts) this.edit.verts.add(v);
    for (const k of snap.edges) this.edit.edges.add(k);
    for (const f of snap.faces) this.edit.faces.add(f);
    this.edit.touch();
  }
}

function snapshotSelection(edit: EditModeState): SelSnapshot {
  return {
    mode: edit.elementMode,
    verts: [...edit.verts],
    edges: [...edit.edges],
    faces: [...edit.faces],
  };
}
