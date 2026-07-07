import type { Command } from './UndoStack';
import type { SceneObject } from '../scene/Scene';
import { cloneModifier, type Modifier, type ModifierContext } from '../modifiers/Modifier';

function snapshotStack(obj: SceneObject): Modifier[] {
  return obj.modifiers.map(cloneModifier);
}

function restoreStack(obj: SceneObject, stack: Modifier[]): void {
  obj.modifiers.length = 0;
  obj.modifiers.push(...stack.map(cloneModifier));
  obj.modifiersVersion++;
}

/**
 * Undo for ANY modifier-stack mutation (add/remove/reorder/rename/toggle/param
 * edit). Same shape as MeshEditCommand: capture(before → mutate → after).
 */
export class ModifierStackCommand implements Command {
  private constructor(
    readonly name: string,
    private readonly obj: SceneObject,
    private readonly before: Modifier[],
    private readonly after: Modifier[],
  ) {}

  static capture(name: string, obj: SceneObject, mutate: () => void): ModifierStackCommand {
    const before = snapshotStack(obj);
    mutate();
    obj.modifiersVersion++;
    return new ModifierStackCommand(name, obj, before, snapshotStack(obj));
  }

  undo(): void { restoreStack(this.obj, this.before); }
  redo(): void { restoreStack(this.obj, this.after); }
}

/**
 * "Apply" collapses ONE modifier (topmost occurrence in the stack order the
 * UI shows) into the base mesh: base = modifier.apply(base), modifier removed.
 * Blender only lets you apply the first modifier; same rule here — the caller
 * passes index 0's modifier or we throw.
 */
export class ApplyModifierCommand implements Command {
  readonly name: string;
  private readonly beforeMesh;
  private readonly beforeStack: Modifier[];
  private afterMesh;
  private afterStack: Modifier[];

  /**
   * ctx (Scene.modifierContext(obj)) is REQUIRED for object-referencing
   * modifiers (Shrinkwrap/Scatter): without it their apply() is an identity
   * pass-through and there is nothing to bake.
   */
  constructor(private readonly obj: SceneObject, modifier: Modifier, ctx?: ModifierContext) {
    const index = obj.modifiers.indexOf(modifier);
    if (index !== 0) throw new Error('Only the first modifier in the stack can be applied');
    this.name = `Apply ${modifier.name}`;
    this.beforeMesh = obj.mesh.clone();
    this.beforeStack = snapshotStack(obj);

    obj.mesh.copyFrom(modifier.apply(obj.mesh, ctx));
    obj.modifiers.splice(index, 1);
    obj.modifiersVersion++;

    this.afterMesh = obj.mesh.clone();
    this.afterStack = snapshotStack(obj);
  }

  undo(): void {
    this.obj.mesh.copyFrom(this.beforeMesh);
    restoreStack(this.obj, this.beforeStack);
  }

  redo(): void {
    this.obj.mesh.copyFrom(this.afterMesh);
    restoreStack(this.obj, this.afterStack);
  }
}
