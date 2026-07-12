import type { Command } from './UndoStack';
import type { Scene } from '../scene/Scene';
import { SceneObject } from '../scene/Scene';
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

/**
 * Apply a Pipe on a CURVE object (UR11-2). A curve carries an empty base mesh
 * and its `kind` is readonly, so the generic ApplyModifierCommand (which bakes
 * into the base mesh in place) cannot turn it into a mesh object. Following the
 * UR8-2 convert-to-mesh precedent, this REPLACES the curve object at its list
 * index with a NEW SceneObject that shares its id / name / transform / parent /
 * material / collection / color / anim, whose base mesh is the baked Pipe tube,
 * whose kind is 'mesh', and which carries NO curve payload — so the result is a
 * real, editable mesh. Any modifiers ABOVE the Pipe (index > 0) carry over onto
 * the new mesh object. Because the id is preserved, selection/active survive.
 * ONE undo restores the original curve object (with its Pipe) exactly.
 */
export class ApplyCurvePipeCommand implements Command {
  readonly name = 'Apply Pipe';
  private readonly index: number;

  private constructor(
    private readonly scene: Scene,
    private readonly curveObj: SceneObject,
    private readonly meshObj: SceneObject,
  ) {
    this.index = scene.objects.indexOf(curveObj);
  }

  /**
   * Build the command (does NOT apply — call redo() then push, per the
   * caller-applies-then-pushes convention). Returns null if `obj` is not a curve
   * whose FIRST modifier is `modifier` and of type 'pipe'. `ctx`
   * (Scene.modifierContext(obj)) is REQUIRED — the tube is baked from the host
   * curve it carries.
   */
  static create(
    scene: Scene,
    obj: SceneObject,
    modifier: Modifier,
    ctx: ModifierContext,
  ): ApplyCurvePipeCommand | null {
    if (obj.kind !== 'curve' || !obj.curve) return null;
    if (modifier.type !== 'pipe') return null;
    if (obj.modifiers.indexOf(modifier) !== 0) return null; // Pipe must be first
    const tube = modifier.apply(obj.mesh, ctx); // reads ctx.hostCurve
    const meshObj = new SceneObject(obj.id, obj.name, tube.clone(), 'mesh');
    meshObj.transform = obj.transform;
    meshObj.visible = obj.visible;
    meshObj.shadeSmooth = obj.shadeSmooth;
    meshObj.color = [...obj.color];
    meshObj.materialId = obj.materialId;
    meshObj.collectionId = obj.collectionId;
    meshObj.parentId = obj.parentId;
    if (obj.anim) meshObj.anim = JSON.parse(JSON.stringify(obj.anim)) as typeof obj.anim;
    // Modifiers above the Pipe survive onto the baked mesh.
    for (let i = 1; i < obj.modifiers.length; i++) meshObj.modifiers.push(cloneModifier(obj.modifiers[i]));
    if (meshObj.modifiers.length > 0) meshObj.modifiersVersion++;
    return new ApplyCurvePipeCommand(scene, obj, meshObj);
  }

  private swap(to: SceneObject): void {
    const from = to === this.meshObj ? this.curveObj : this.meshObj;
    const i = this.scene.objects.indexOf(from);
    const at = i >= 0 ? i : this.index;
    this.scene.objects.splice(at, 1, to);
  }

  redo(): void { this.swap(this.meshObj); }
  undo(): void { this.swap(this.curveObj); }
}
