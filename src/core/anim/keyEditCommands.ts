import type { Command } from '../undo/UndoStack';
import type { SceneObject } from '../scene/Scene';
import { deleteKey, insertKey, type Keyframe } from './fcurve';

/**
 * Timeline keyframe MOVE undo command (P15-3).
 *
 * A diamond in the timeline represents a FRAME on an object — every channel
 * keyed at that frame moves together. `MoveKeysCommand` therefore takes a list
 * of per-object frame moves ({ object, fromFrame, toFrame }) and shifts EVERY
 * fcurve of that object that has a key at `fromFrame` over to `toFrame`.
 *
 * Collisions: if a key already exists at `toFrame` on a channel, it is
 * REPLACED — its old value/interp is captured so undo restores it exactly
 * (built on insertKey's replace return, mirroring InsertKeysCommand). The moved
 * key's original value/interp is captured too, so undo puts it back at
 * `fromFrame`.
 *
 * Sources are lifted (deleted) in a first pass BEFORE any target insert, so a
 * chain of moves (e.g. 5→10 while another key sits at 10 that also moves) never
 * has a source masquerade as a collision. Cross-object moves are just entries
 * on different objects — no special casing.
 */

export interface KeyMove {
  object: SceneObject;
  fromFrame: number;
  toFrame: number;
}

interface MoveEntry {
  object: SceneObject;
  channelPath: string;
  fromFrame: number;
  toFrame: number;
  /** The key lifted off `fromFrame` (its value + interp). */
  moved: Keyframe;
  /** A pre-existing key at `toFrame` that this move overwrote (undo data). */
  replaced?: Keyframe;
}

export class MoveKeysCommand implements Command {
  private constructor(
    readonly name: string,
    private readonly entries: MoveEntry[],
  ) {}

  /**
   * Perform the moves immediately and return the command (already applied — the
   * caller only pushes it, per the A4 convention). Returns null when nothing
   * actually moved (all no-ops or no keys at the source frames).
   */
  static perform(name: string, moves: KeyMove[]): MoveKeysCommand | null {
    const active = moves.filter((m) => m.fromFrame !== m.toFrame && !!m.object.anim);
    if (active.length === 0) return null;

    const entries: MoveEntry[] = [];
    // Pass 1: lift every keyed channel off its source frame. Snapshot the
    // channel paths first — deleteKey may drop empty curves, so we must not
    // iterate anim.fcurves while mutating it.
    for (const m of active) {
      const anim = m.object.anim!;
      const paths = anim.fcurves
        .filter((c) => c.keys.some((k) => k.frame === m.fromFrame))
        .map((c) => c.channelPath);
      for (const channelPath of paths) {
        const moved = deleteKey(anim, channelPath, m.fromFrame);
        if (moved) {
          entries.push({ object: m.object, channelPath, fromFrame: m.fromFrame, toFrame: m.toFrame, moved });
        }
      }
    }
    if (entries.length === 0) return null;

    // Pass 2: drop each lifted key at its target, capturing any collided key.
    for (const e of entries) {
      e.replaced = insertKey(e.object.anim!, e.channelPath, e.toFrame, e.moved.value, e.moved.interp);
    }
    return new MoveKeysCommand(name, entries);
  }

  undo(): void {
    // Remove what we inserted at the targets + restore collided keys.
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (!e.object.anim) continue;
      deleteKey(e.object.anim, e.channelPath, e.toFrame);
      if (e.replaced) {
        insertKey(e.object.anim, e.channelPath, e.replaced.frame, e.replaced.value, e.replaced.interp);
      }
    }
    // Restore the moved keys at their original frames.
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (!e.object.anim) e.object.anim = { fcurves: [] };
      insertKey(e.object.anim, e.channelPath, e.moved.frame, e.moved.value, e.moved.interp);
    }
  }

  redo(): void {
    for (const e of this.entries) {
      if (e.object.anim) deleteKey(e.object.anim, e.channelPath, e.fromFrame);
    }
    for (const e of this.entries) {
      if (!e.object.anim) e.object.anim = { fcurves: [] };
      insertKey(e.object.anim, e.channelPath, e.toFrame, e.moved.value, e.moved.interp);
    }
  }
}
