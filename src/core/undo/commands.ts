import type { Command } from './UndoStack';
import type { SceneObject } from '../scene/Scene';
import type { Transform } from '../math/transform';

export interface TransformEntry {
  object: SceneObject;
  before: Transform;
  after: Transform;
}

/** Object-mode transform change (move/rotate/scale) on one or more objects. */
export class TransformCommand implements Command {
  constructor(
    readonly name: string,
    private readonly entries: TransformEntry[],
  ) {}

  undo(): void {
    for (const e of this.entries) e.object.transform = e.before;
  }

  redo(): void {
    for (const e of this.entries) e.object.transform = e.after;
  }
}
