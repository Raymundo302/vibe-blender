import type { Command } from './UndoStack';
import type { Scene, SceneObject } from '../scene/Scene';

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

export class DeleteObjectsCommand implements Command {
  private constructor(
    readonly name: string,
    private readonly scene: Scene,
    private readonly entries: Entry[],
  ) {}

  /** Capture + delete in one step; push the returned command. */
  static perform(name: string, scene: Scene, ids: number[]): DeleteObjectsCommand {
    const entries: Entry[] = [];
    for (const id of ids) {
      const object = scene.get(id);
      if (!object) continue;
      entries.push({ object, index: scene.objects.indexOf(object) });
    }
    for (const e of entries) scene.remove(e.object.id);
    return new DeleteObjectsCommand(name, scene, entries);
  }

  undo(): void {
    for (const e of this.entries) this.scene.insertAt(e.object, e.index);
    this.scene.selection.clear();
    for (const e of this.entries) this.scene.selection.add(e.object.id);
    this.scene.activeId = this.entries.at(-1)?.object.id ?? null;
  }

  redo(): void {
    for (const e of [...this.entries].reverse()) this.scene.remove(e.object.id);
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
