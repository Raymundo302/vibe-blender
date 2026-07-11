import type { Command } from './UndoStack';
import type { Scene } from '../scene/Scene';
import { SceneObject } from '../scene/Scene';
import { EditableMesh } from '../mesh/EditableMesh';
import { cloneTextData, type TextData } from '../scene/objectData';

/**
 * Text-object undo commands + the pure "does the mesh need regenerating?"
 * signature (UR8-2). Canvas-free so it unit-tests without a browser — the actual
 * glyph build lives in tools/textObject.ts.
 */

/**
 * A stable signature of everything that changes the GENERATED mesh. The text
 * driver rebuilds a text object's mesh only when this string changes, so a
 * per-frame tick that touches nothing is free. Colors are excluded on purpose:
 * face/outline colors are written as per-face tints inside the same geometry, so
 * they DO change the mesh — include them so a color edit re-tints. (Cheap: a
 * short string.)
 */
export function textSignature(t: TextData): string {
  return JSON.stringify([
    t.content, t.font, t.size, t.wrap, t.wrapWidth, t.align, t.style,
    t.thickness, t.faceColor, t.outlineColor,
  ]);
}

/**
 * One undoable edit to a text object's payload (UR8-2). Snapshots the full
 * TextData before/after so undo/redo restore the exact prior state regardless of
 * which field changed — the LightCommand pattern applied to text. Used by the
 * properties Text tab AND (as ONE entry per session) by the typing mode.
 */
export class TextCommand implements Command {
  private constructor(
    readonly name: string,
    private readonly obj: SceneObject,
    private readonly before: TextData,
    private readonly after: TextData,
  ) {}

  /** Snapshot obj.text, run mutate() against the live payload, snapshot again. */
  static capture(name: string, obj: SceneObject, mutate: (t: TextData) => void): TextCommand {
    const text = obj.text;
    if (!text) throw new Error('TextCommand.capture: object has no text payload');
    const before = cloneTextData(text);
    mutate(text);
    const after = cloneTextData(text);
    return new TextCommand(name, obj, before, after);
  }

  /** Build a command from explicit before/after snapshots (typing session). */
  static fromSnapshots(name: string, obj: SceneObject, before: TextData, after: TextData): TextCommand {
    return new TextCommand(name, obj, cloneTextData(before), cloneTextData(after));
  }

  undo(): void {
    this.obj.text = cloneTextData(this.before);
  }

  redo(): void {
    this.obj.text = cloneTextData(this.after);
  }
}

/**
 * Convert a text object to a plain mesh in place (UR8-2, Ray follow-up). The
 * text object is replaced at its list index by a NEW SceneObject that shares its
 * id / name / transform / parent / material / collection / color / anim, whose
 * mesh is a DEEP COPY of the current generated text mesh and which carries NO
 * text payload — so it is now editable in mesh edit mode, takes modifiers, etc.
 * ONE undo restores the original text object exactly (same instance).
 *
 * Because the id is preserved, selection/active (kept by id) survive the swap.
 */
export class ConvertTextToMeshCommand implements Command {
  readonly name = 'Convert to Mesh';
  private readonly index: number;

  private constructor(
    private readonly scene: Scene,
    private readonly textObj: SceneObject,
    private readonly meshObj: SceneObject,
  ) {
    this.index = scene.objects.indexOf(textObj);
  }

  /** Build the command (does NOT apply — push it so redo() applies). Returns
   *  null if `obj` is not a text object still in the scene. */
  static create(scene: Scene, obj: SceneObject): ConvertTextToMeshCommand | null {
    if (obj.kind !== 'text' || scene.objects.indexOf(obj) < 0) return null;
    const meshObj = new SceneObject(obj.id, obj.name, obj.mesh.clone(), 'mesh');
    meshObj.transform = obj.transform;
    meshObj.visible = obj.visible;
    meshObj.shadeSmooth = obj.shadeSmooth;
    meshObj.color = [...obj.color];
    meshObj.materialId = obj.materialId;
    meshObj.collectionId = obj.collectionId;
    meshObj.parentId = obj.parentId;
    if (obj.anim) meshObj.anim = JSON.parse(JSON.stringify(obj.anim)) as typeof obj.anim;
    return new ConvertTextToMeshCommand(scene, obj, meshObj);
  }

  private swap(to: SceneObject): void {
    const i = this.scene.objects.indexOf(to === this.meshObj ? this.textObj : this.meshObj);
    const at = i >= 0 ? i : this.index;
    this.scene.objects.splice(at, 1, to);
  }

  redo(): void {
    this.swap(this.meshObj);
  }

  undo(): void {
    this.swap(this.textObj);
  }
}

/** Bump a freshly-built text mesh's version so the GPU/pick caches re-upload
 *  (they key off obj.id + mesh.version; a rebuilt mesh must not reuse the old
 *  version number, which could collide). Kept here so both the driver and the
 *  add path share one convention. */
export function assignTextMesh(obj: SceneObject, mesh: EditableMesh): void {
  const prev = obj.mesh ? obj.mesh.version : 0;
  mesh.version = prev + 1;
  obj.mesh = mesh;
}
