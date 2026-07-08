import type { Command } from './UndoStack';
import type { Scene, SceneObject } from '../scene/Scene';
import type { Transform } from '../math/transform';

/**
 * Object lifecycle commands. Same convention as everything on the UndoStack:
 * the state change has ALREADY happened when the command is pushed.
 *
 * - AddObjectsCommand: construct AFTER scene.add() (it captures list indices).
 * - DeleteObjectsCommand: use the static perform() — it captures the objects'
 *   indices, removes them, and returns the command ready to push.
 */

interface Entry {
  object: SceneObject;
  index: number;
}

export class AddObjectsCommand implements Command {
  private readonly entries: Entry[];

  constructor(
    readonly name: string,
    private readonly scene: Scene,
    objects: SceneObject[],
  ) {
    this.entries = objects.map((object) => ({ object, index: scene.objects.indexOf(object) }));
  }

  undo(): void {
    for (const e of [...this.entries].reverse()) this.scene.remove(e.object.id);
  }

  redo(): void {
    for (const e of this.entries) this.scene.insertAt(e.object, e.index);
    this.scene.selection.clear();
    for (const e of this.entries) this.scene.selection.add(e.object.id);
    this.scene.activeId = this.entries.at(-1)?.object.id ?? null;
  }
}

/** A child's parenting state before its parent was deleted (P12). */
interface ChildRestore {
  child: SceneObject;
  parentId: number | null;
  transform: Transform;
}

export class DeleteObjectsCommand implements Command {
  private constructor(
    readonly name: string,
    private readonly scene: Scene,
    private readonly entries: Entry[],
    private readonly childRestores: ChildRestore[],
  ) {}

  /** Capture + delete in one step; push the returned command. */
  static perform(name: string, scene: Scene, ids: number[]): DeleteObjectsCommand {
    const entries: Entry[] = [];
    for (const id of ids) {
      const object = scene.get(id);
      if (!object) continue;
      entries.push({ object, index: scene.objects.indexOf(object) });
    }
    // Scene.remove() reparents each victim's children (keeping their world
    // transform); snapshot every potentially-affected child so undo restores
    // the exact hierarchy + locals. Descendants of victims are affected too,
    // so capture the whole scene's parent/transform pairs cheaply? No — only
    // objects whose ancestor chain reaches a victim can change.
    const victimIds = new Set(entries.map((e) => e.object.id));
    const childRestores: ChildRestore[] = scene.objects
      .filter((o) => !victimIds.has(o.id) && chainHitsVictim(scene, o, victimIds))
      .map((child) => ({ child, parentId: child.parentId, transform: child.transform }));
    for (const e of entries) scene.remove(e.object.id);
    return new DeleteObjectsCommand(name, scene, entries, childRestores);
  }

  undo(): void {
    for (const e of this.entries) this.scene.insertAt(e.object, e.index);
    for (const r of this.childRestores) {
      r.child.parentId = r.parentId;
      r.child.transform = r.transform;
    }
    this.scene.selection.clear();
    for (const e of this.entries) this.scene.selection.add(e.object.id);
    this.scene.activeId = this.entries.at(-1)?.object.id ?? null;
  }

  redo(): void {
    for (const e of [...this.entries].reverse()) this.scene.remove(e.object.id);
  }
}

/** True if any ancestor of `obj` is in `victimIds` (its local WILL change). */
function chainHitsVictim(scene: Scene, obj: SceneObject, victimIds: Set<number>): boolean {
  const seen = new Set<number>([obj.id]);
  for (let p = scene.parentOf(obj); p; p = scene.parentOf(p)) {
    if (victimIds.has(p.id)) return true;
    if (seen.has(p.id)) return false;
    seen.add(p.id);
  }
  return false;
}

/**
 * Ctrl+P / Alt+P (P12): (re)parent objects with Keep Transform. Construct via
 * perform() AFTER deciding targets; skips entries Scene refuses (cycles).
 */
export class SetParentCommand implements Command {
  private constructor(
    readonly name: string,
    private readonly entries: {
      object: SceneObject;
      beforeParent: number | null;
      beforeTransform: Transform;
      afterParent: number | null;
      afterTransform: Transform;
    }[],
  ) {}

  /** Returns null if no object actually changed parent (all refused/no-ops). */
  static perform(
    name: string,
    scene: Scene,
    objects: SceneObject[],
    parent: SceneObject | null,
  ): SetParentCommand | null {
    const entries = [];
    for (const object of objects) {
      if (parent && object.id === parent.id) continue;
      if ((parent?.id ?? null) === object.parentId) continue;
      const beforeParent = object.parentId;
      const beforeTransform = object.transform;
      if (!scene.setParentKeepTransform(object, parent)) continue;
      entries.push({
        object, beforeParent, beforeTransform,
        afterParent: object.parentId, afterTransform: object.transform,
      });
    }
    return entries.length ? new SetParentCommand(name, entries) : null;
  }

  undo(): void {
    for (const e of this.entries) {
      e.object.parentId = e.beforeParent;
      e.object.transform = e.beforeTransform;
    }
  }

  redo(): void {
    for (const e of this.entries) {
      e.object.parentId = e.afterParent;
      e.object.transform = e.afterTransform;
    }
  }
}

export class RenameObjectCommand implements Command {
  readonly name = 'Rename';

  constructor(
    private readonly object: SceneObject,
    private readonly before: string,
    private readonly after: string,
  ) {}

  undo(): void { this.object.name = this.before; }
  redo(): void { this.object.name = this.after; }
}
