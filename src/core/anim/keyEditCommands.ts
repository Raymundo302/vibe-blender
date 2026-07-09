import type { Command } from '../undo/UndoStack';
import type { SceneObject } from '../scene/Scene';
import { deleteKey, insertKey, findCurve, type Easing, type Interp, type Keyframe } from './fcurve';

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
  /**
   * Dope-sheet sub-row move (P16-3): restrict the move to these channel paths.
   * Omitted → the object-row semantics of moving EVERY channel keyed at
   * `fromFrame` (unchanged from P15-3).
   */
  channelPaths?: string[];
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
        .filter((c) => !m.channelPaths || m.channelPaths.includes(c.channelPath))
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
      e.replaced = insertKey(e.object.anim!, e.channelPath, e.toFrame, e.moved.value, e.moved.interp, e.moved);
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
        insertKey(e.object.anim, e.channelPath, e.replaced.frame, e.replaced.value, e.replaced.interp, e.replaced);
      }
    }
    // Restore the moved keys at their original frames.
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (!e.object.anim) e.object.anim = { fcurves: [] };
      insertKey(e.object.anim, e.channelPath, e.moved.frame, e.moved.value, e.moved.interp, e.moved);
    }
  }

  redo(): void {
    for (const e of this.entries) {
      if (e.object.anim) deleteKey(e.object.anim, e.channelPath, e.fromFrame);
    }
    for (const e of this.entries) {
      if (!e.object.anim) e.object.anim = { fcurves: [] };
      insertKey(e.object.anim, e.channelPath, e.toFrame, e.moved.value, e.moved.interp, e.moved);
    }
  }
}

/**
 * Per-key interpolation change (P16-3, dope-sheet interp picker).
 *
 * The pane's Constant/Linear/Bezier dropdown targets a set of exact
 * (object, channelPath, frame) keys — a sub-row selection targets ONE channel,
 * an object-row selection targets every channel keyed at that frame. Applying
 * pushes ONE command; each entry captures the key's OLD interp so undo restores
 * it exactly even when the selection had mixed before-values.
 *
 * Keys already at the requested interp are skipped (no-op entries), so a
 * selection that changes nothing yields null.
 */
export interface KeyInterpTarget {
  object: SceneObject;
  channelPath: string;
  frame: number;
}

interface InterpEntry {
  object: SceneObject;
  channelPath: string;
  frame: number;
  before: Interp;
  after: Interp;
}

export class SetKeyInterpCommand implements Command {
  private constructor(
    readonly name: string,
    private readonly entries: InterpEntry[],
  ) {}

  /**
   * Set `interp` on every target key that currently differs. Applies
   * immediately (A4 convention — caller only pushes). Returns null when no key
   * actually changed (missing keys / all already at `interp`).
   */
  static perform(name: string, targets: KeyInterpTarget[], interp: Interp): SetKeyInterpCommand | null {
    const entries: InterpEntry[] = [];
    for (const t of targets) {
      const key = SetKeyInterpCommand.findKey(t.object, t.channelPath, t.frame);
      if (!key || key.interp === interp) continue;
      entries.push({ object: t.object, channelPath: t.channelPath, frame: t.frame, before: key.interp, after: interp });
      key.interp = interp;
    }
    return entries.length ? new SetKeyInterpCommand(name, entries) : null;
  }

  private static findKey(object: SceneObject, channelPath: string, frame: number): Keyframe | undefined {
    if (!object.anim) return undefined;
    const curve = findCurve(object.anim, channelPath);
    return curve?.keys.find((k) => k.frame === frame);
  }

  undo(): void {
    for (const e of this.entries) {
      const key = SetKeyInterpCommand.findKey(e.object, e.channelPath, e.frame);
      if (key) key.interp = e.before;
    }
  }

  redo(): void {
    for (const e of this.entries) {
      const key = SetKeyInterpCommand.findKey(e.object, e.channelPath, e.frame);
      if (key) key.interp = e.after;
    }
  }
}

/**
 * Per-key easing-direction change (the eased interps' In / Out / In-Out /
 * Automatic picker) — the exact shape of SetKeyInterpCommand, over `easing`.
 */
interface EasingEntry {
  object: SceneObject;
  channelPath: string;
  frame: number;
  before: Easing | undefined;
  after: Easing;
}

export class SetKeyEasingCommand implements Command {
  private constructor(
    readonly name: string,
    private readonly entries: EasingEntry[],
  ) {}

  static perform(name: string, targets: KeyInterpTarget[], easing: Easing): SetKeyEasingCommand | null {
    const entries: EasingEntry[] = [];
    for (const t of targets) {
      const key = SetKeyEasingCommand.findKey(t.object, t.channelPath, t.frame);
      if (!key || (key.easing ?? 'auto') === easing) continue;
      entries.push({ object: t.object, channelPath: t.channelPath, frame: t.frame, before: key.easing, after: easing });
      if (easing === 'auto') delete key.easing;
      else key.easing = easing;
    }
    return entries.length ? new SetKeyEasingCommand(name, entries) : null;
  }

  private static findKey(object: SceneObject, channelPath: string, frame: number): Keyframe | undefined {
    if (!object.anim) return undefined;
    return findCurve(object.anim, channelPath)?.keys.find((k) => k.frame === frame);
  }

  undo(): void {
    for (const e of this.entries) {
      const key = SetKeyEasingCommand.findKey(e.object, e.channelPath, e.frame);
      if (!key) continue;
      if (e.before === undefined) delete key.easing;
      else key.easing = e.before;
    }
  }

  redo(): void {
    for (const e of this.entries) {
      const key = SetKeyEasingCommand.findKey(e.object, e.channelPath, e.frame);
      if (!key) continue;
      if (e.after === 'auto') delete key.easing;
      else key.easing = e.after;
    }
  }
}

/**
 * Whole-curve snapshot command for the Graph Editor's free-form edits (key
 * value/frame drags, bezier handle drags): capture() deep-copies the target
 * curves, runs the caller's mutation, deep-copies the result, and returns null
 * when nothing changed. The A4 snapshot philosophy at fcurve granularity — the
 * mutation can be anything (live drag already applied), undo/redo just swap
 * key arrays wholesale.
 */
interface CurveSnap {
  object: SceneObject;
  channelPath: string;
  before: Keyframe[];
  after: Keyframe[];
}

export class EditCurveKeysCommand implements Command {
  private constructor(
    readonly name: string,
    private readonly snaps: CurveSnap[],
  ) {}

  /** Deep-copy a curve's keys (handles included). */
  private static copyKeys(object: SceneObject, channelPath: string): Keyframe[] {
    const curve = object.anim && findCurve(object.anim, channelPath);
    return curve ? curve.keys.map((k) => ({
      ...k,
      hl: k.hl ? [k.hl[0], k.hl[1]] as [number, number] : undefined,
      hr: k.hr ? [k.hr[0], k.hr[1]] as [number, number] : undefined,
    })) : [];
  }

  private static writeKeys(object: SceneObject, channelPath: string, keys: Keyframe[]): void {
    if (!object.anim) object.anim = { fcurves: [] };
    let curve = findCurve(object.anim, channelPath);
    if (keys.length === 0) {
      if (curve) object.anim.fcurves = object.anim.fcurves.filter((c) => c !== curve);
      return;
    }
    if (!curve) {
      curve = { channelPath, keys: [] };
      object.anim.fcurves.push(curve);
    }
    curve.keys = keys.map((k) => ({ ...k }));
  }

  /**
   * Snapshot `targets`, run `mutate`, snapshot again. Returns the applied
   * command, or null if the mutation changed nothing.
   */
  static capture(
    name: string,
    targets: { object: SceneObject; channelPath: string }[],
    mutate: () => void,
  ): EditCurveKeysCommand | null {
    const before = targets.map((t) => EditCurveKeysCommand.copyKeys(t.object, t.channelPath));
    mutate();
    const snaps: CurveSnap[] = [];
    targets.forEach((t, idx) => {
      const after = EditCurveKeysCommand.copyKeys(t.object, t.channelPath);
      if (JSON.stringify(after) !== JSON.stringify(before[idx])) {
        snaps.push({ object: t.object, channelPath: t.channelPath, before: before[idx], after });
      }
    });
    return snaps.length ? new EditCurveKeysCommand(name, snaps) : null;
  }

  undo(): void {
    for (const s of this.snaps) EditCurveKeysCommand.writeKeys(s.object, s.channelPath, s.before);
  }

  redo(): void {
    for (const s of this.snaps) EditCurveKeysCommand.writeKeys(s.object, s.channelPath, s.after);
  }
}
