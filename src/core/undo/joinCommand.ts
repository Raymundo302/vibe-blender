import type { Command } from './UndoStack';
import type { Scene, SceneObject } from '../scene/Scene';
import { EditableMesh } from '../mesh/EditableMesh';
import { appendBaked } from '../mesh/ops/join';

/**
 * Join objects (Blender's Ctrl+J). Every selected mesh is baked into the ACTIVE
 * object's local space (`inv(activeModel) * srcModel`) and the source objects
 * are removed. Only the active object's modifier stack survives — the sources'
 * stacks are dropped with the objects (the undo snapshot restores whole
 * SceneObjects, so Ctrl+Z brings them back intact).
 *
 * Perform-style like DeleteObjectsCommand: `perform()` captures state, mutates,
 * and returns the command ready to push. Returns null (no-op, nothing pushed)
 * when there is no active object, fewer than 2 selected, or the active object is
 * not part of the selection.
 */

interface SourceEntry {
  object: SceneObject;
  /** Original index in scene.objects, for undo re-insert. */
  index: number;
}

export class JoinObjectsCommand implements Command {
  private constructor(
    readonly name: string,
    private readonly scene: Scene,
    private readonly active: SceneObject,
    private readonly meshBefore: EditableMesh,
    private readonly meshAfter: EditableMesh,
    private readonly sources: SourceEntry[],
    private readonly prevSelection: number[],
  ) {}

  static perform(name: string, scene: Scene): JoinObjectsCommand | null {
    const active = scene.activeObject;
    if (!active) return null;
    if (!scene.selection.has(active.id)) return null;
    const selected = scene.selectedObjects;
    if (selected.length < 2) return null;

    const prevSelection = [...scene.selection];
    // selectedObjects follows scene.objects order → indices already ascending.
    // Non-mesh objects (lights/cameras) are skipped — they have no geometry to
    // contribute and must survive the join. Selection is left untouched.
    const sources: SourceEntry[] = selected
      .filter((o) => o.id !== active.id && o.kind === 'mesh')
      .map((o) => ({ object: o, index: scene.objects.indexOf(o) }));
    if (sources.length === 0) return null;

    const meshBefore = active.mesh.clone();

    const activeInv = active.transform.matrix().invert();
    for (const s of sources) {
      appendBaked(active.mesh, s.object.mesh, activeInv.mul(s.object.transform.matrix()));
    }
    const meshAfter = active.mesh.clone();

    for (const s of sources) scene.remove(s.object.id);
    scene.selectOnly(active.id);

    return new JoinObjectsCommand(name, scene, active, meshBefore, meshAfter, sources, prevSelection);
  }

  undo(): void {
    this.active.mesh.copyFrom(this.meshBefore);
    for (const s of this.sources) this.scene.insertAt(s.object, s.index);
    this.scene.selection.clear();
    for (const id of this.prevSelection) this.scene.selection.add(id);
    this.scene.activeId = this.active.id;
  }

  redo(): void {
    this.active.mesh.copyFrom(this.meshAfter);
    for (const s of this.sources) this.scene.remove(s.object.id);
    this.scene.selectOnly(this.active.id);
  }
}
