import type { Command } from './UndoStack';
import type { SceneObject } from '../scene/Scene';
import { cloneCurveData, type CurveData } from '../scene/objectData';

/**
 * Whole-payload snapshot undo for curve edits (UR11-1) — the curve analogue of
 * MeshEditCommand. A curve payload is small plain data, so snapshotting the
 * entire CurveData before/after (point moves, append, delete, cyclic toggle) is
 * cheap and covers every mutation with one command shape.
 */
export class CurveCommand implements Command {
  constructor(
    readonly name: string,
    private readonly obj: SceneObject,
    private readonly before: CurveData,
    private readonly after: CurveData,
  ) {}

  undo(): void {
    this.obj.curve = cloneCurveData(this.before);
  }

  redo(): void {
    this.obj.curve = cloneCurveData(this.after);
  }

  /** Snapshot the object's curve, run `mutate`, snapshot again. */
  static capture(name: string, obj: SceneObject, mutate: () => void): CurveCommand {
    const before = cloneCurveData(obj.curve!);
    mutate();
    const after = cloneCurveData(obj.curve!);
    return new CurveCommand(name, obj, before, after);
  }

  /** Build from explicit before/after snapshots (modal move commit). */
  static fromSnapshots(name: string, obj: SceneObject, before: CurveData, after: CurveData): CurveCommand {
    return new CurveCommand(name, obj, cloneCurveData(before), cloneCurveData(after));
  }
}
