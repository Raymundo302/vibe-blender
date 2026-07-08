import type { Command } from '../undo/UndoStack';
import type { Scene, SceneObject } from '../scene/Scene';
import { deleteKey, insertKey, type Interp, type Keyframe } from './fcurve';
import { readChannel } from './channels';

/**
 * Keyframe undo commands (F15-1). Insert captures per-channel what was
 * replaced (or nothing) so undo restores exactly; delete captures the
 * removed key. Both operate on many (object, channel) pairs as ONE stack
 * entry — the I-key keys loc/rot/scale of every selected object at once.
 */

interface InsertEntry {
  object: SceneObject;
  channelPath: string;
  frame: number;
  value: number;
  interp: Interp;
  /** Key replaced by this insert (same frame), or undefined = fresh key. */
  replaced?: Keyframe;
  /** True when the object had no AnimData at all before this command. */
  createdAnim: boolean;
}

export class InsertKeysCommand implements Command {
  private constructor(
    readonly name: string,
    private readonly entries: InsertEntry[],
  ) {}

  /**
   * Key `channelPaths` on every object at `frame`, reading CURRENT values.
   * Unresolvable channels (e.g. light.power on a mesh) are skipped. Returns
   * null if nothing was keyable.
   */
  static perform(
    name: string,
    scene: Scene,
    objects: SceneObject[],
    channelPaths: string[],
    frame: number,
    interp: Interp = 'bezier',
  ): InsertKeysCommand | null {
    const entries: InsertEntry[] = [];
    for (const object of objects) {
      for (const channelPath of channelPaths) {
        const value = readChannel(scene, object, channelPath);
        if (value === null) continue;
        const createdAnim = !object.anim;
        if (!object.anim) object.anim = { fcurves: [] };
        const replaced = insertKey(object.anim, channelPath, frame, value, interp);
        entries.push({ object, channelPath, frame, value, interp, replaced, createdAnim });
      }
    }
    return entries.length ? new InsertKeysCommand(name, entries) : null;
  }

  undo(): void {
    for (const e of [...this.entries].reverse()) {
      if (!e.object.anim) continue;
      deleteKey(e.object.anim, e.channelPath, e.frame);
      if (e.replaced) insertKey(e.object.anim, e.channelPath, e.replaced.frame, e.replaced.value, e.replaced.interp);
      if (e.createdAnim && e.object.anim.fcurves.length === 0) delete e.object.anim;
    }
  }

  redo(): void {
    for (const e of this.entries) {
      if (!e.object.anim) e.object.anim = { fcurves: [] };
      insertKey(e.object.anim, e.channelPath, e.frame, e.value, e.interp);
    }
  }
}

export class DeleteKeysCommand implements Command {
  private constructor(
    readonly name: string,
    private readonly entries: { object: SceneObject; channelPath: string; key: Keyframe }[],
  ) {}

  /** Delete the key at (channelPath, frame) on each object where it exists. */
  static perform(
    name: string,
    scene: Scene,
    targets: { object: SceneObject; channelPath: string; frame: number }[],
  ): DeleteKeysCommand | null {
    void scene;
    const entries = [];
    for (const t of targets) {
      if (!t.object.anim) continue;
      const key = deleteKey(t.object.anim, t.channelPath, t.frame);
      if (key) entries.push({ object: t.object, channelPath: t.channelPath, key });
    }
    return entries.length ? new DeleteKeysCommand(name, entries) : null;
  }

  undo(): void {
    for (const e of this.entries) {
      if (!e.object.anim) e.object.anim = { fcurves: [] };
      insertKey(e.object.anim, e.channelPath, e.key.frame, e.key.value, e.key.interp);
    }
  }

  redo(): void {
    for (const e of this.entries) {
      if (e.object.anim) deleteKey(e.object.anim, e.channelPath, e.key.frame);
    }
  }
}

/** The nine transform channels the I-key captures (Blender's LocRotScale). */
export const LOC_ROT_SCALE: string[] = [
  'location.x', 'location.y', 'location.z',
  'rotation.x', 'rotation.y', 'rotation.z',
  'scale.x', 'scale.y', 'scale.z',
];
