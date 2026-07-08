import type { Command } from './UndoStack';
import type { Scene, SceneCollection, SceneObject } from '../scene/Scene';

/**
 * Collection (outliner group) undo commands — Phase 10. Same convention as the
 * rest of the UndoStack: the mutation has ALREADY happened (or is performed by
 * a static perform()) when the command is pushed; undo()/redo() restore the
 * before/after states the command captured.
 *
 * Collections carry a stable id and objects reference them by collectionId, so
 * every undo path re-inserts the SAME SceneCollection object (preserving its
 * id) and re-attaches its ex-members by id — never recreates it through
 * addCollection() (which would mint a fresh id and orphan the members).
 */

/** Splice a collection back into the list at its old index, if not already present. */
function reinsert(scene: Scene, collection: SceneCollection, index: number): void {
  if (scene.collections.includes(collection)) return;
  scene.collections.splice(Math.min(index, scene.collections.length), 0, collection);
}

export class CreateCollectionCommand implements Command {
  readonly name = 'New Collection';
  private readonly index: number;

  /** Construct AFTER scene.addCollection() — it captures the list index. */
  constructor(private readonly scene: Scene, private readonly collection: SceneCollection) {
    this.index = scene.collections.indexOf(collection);
  }

  undo(): void {
    // Defensive: detach any members before removing (a Move pushed after this
    // create is undone first, so normally there are none).
    for (const obj of this.scene.objects) {
      if (obj.collectionId === this.collection.id) obj.collectionId = null;
    }
    const i = this.scene.collections.indexOf(this.collection);
    if (i >= 0) this.scene.collections.splice(i, 1);
  }

  redo(): void {
    reinsert(this.scene, this.collection, this.index);
  }
}

export class DeleteCollectionCommand implements Command {
  readonly name = 'Delete Collection';

  private constructor(
    private readonly scene: Scene,
    private readonly collection: SceneCollection,
    private readonly index: number,
    /** Every object that belonged to the collection when it was deleted. */
    private readonly members: SceneObject[],
  ) {}

  /** Capture the collection + its members, remove it, and return the command. */
  static perform(scene: Scene, id: number): DeleteCollectionCommand | null {
    const collection = scene.getCollection(id);
    if (!collection) return null;
    const index = scene.collections.indexOf(collection);
    const members = scene.objects.filter((o) => o.collectionId === id);
    scene.removeCollection(id); // splices the collection, drops members to root
    return new DeleteCollectionCommand(scene, collection, index, members);
  }

  undo(): void {
    reinsert(this.scene, this.collection, this.index);
    for (const obj of this.members) obj.collectionId = this.collection.id;
  }

  redo(): void {
    this.scene.removeCollection(this.collection.id);
  }
}

/**
 * "M → New Collection": create a fresh collection AND move the selection into
 * it as ONE undo step. Blender treats this as a single action — Ctrl+Z both
 * returns the objects to their previous collections AND removes the new
 * collection. Composing the two primitive commands (create + move) keeps their
 * individual invariants (stable collection id preserved across undo/redo, each
 * object's previous assignment captured) while presenting a single entry.
 *
 * Order matters: redo creates the collection BEFORE the move (the move targets
 * its id); undo reverses (move back first, then remove the now-empty collection).
 */
export class CreateCollectionAndMoveCommand implements Command {
  readonly name = 'Move to New Collection';

  private constructor(
    private readonly create: CreateCollectionCommand,
    private readonly move: MoveToCollectionCommand,
  ) {}

  /**
   * Create a collection, move `objectIds` into it, and return the composite.
   * The mutations have ALREADY happened when this returns (perform convention),
   * so the caller just pushes the result. Returns the new collection too so the
   * caller can report its name.
   */
  static perform(scene: Scene, objectIds: number[]): { command: CreateCollectionAndMoveCommand; collection: SceneCollection } {
    const collection = scene.addCollection();
    const create = new CreateCollectionCommand(scene, collection);
    const move = MoveToCollectionCommand.perform(scene, objectIds, collection.id);
    return { command: new CreateCollectionAndMoveCommand(create, move), collection };
  }

  undo(): void {
    this.move.undo();
    this.create.undo();
  }

  redo(): void {
    this.create.redo();
    this.move.redo();
  }
}

export class MoveToCollectionCommand implements Command {
  readonly name = 'Move to Collection';
  /** Per-object previous assignment, so undo restores each one individually. */
  private readonly before: Map<number, number | null>;

  private constructor(
    private readonly scene: Scene,
    /** Destination collection id, or null for the scene root. */
    private readonly targetId: number | null,
    before: Map<number, number | null>,
  ) {
    this.before = before;
  }

  /** Assign every object to targetId (capturing each previous id), return the command. */
  static perform(scene: Scene, objectIds: number[], targetId: number | null): MoveToCollectionCommand {
    const before = new Map<number, number | null>();
    for (const id of objectIds) {
      const obj = scene.get(id);
      if (!obj) continue;
      before.set(id, obj.collectionId);
      obj.collectionId = targetId;
    }
    return new MoveToCollectionCommand(scene, targetId, before);
  }

  undo(): void {
    for (const [id, prev] of this.before) {
      const obj = this.scene.get(id);
      if (obj) obj.collectionId = prev;
    }
  }

  redo(): void {
    for (const id of this.before.keys()) {
      const obj = this.scene.get(id);
      if (obj) obj.collectionId = this.targetId;
    }
  }
}

export class SetCollectionVisibilityCommand implements Command {
  readonly name = 'Collection Visibility';

  constructor(
    private readonly collection: SceneCollection,
    private readonly before: boolean,
    private readonly after: boolean,
  ) {}

  /** Flip the collection's visibility and return the ready-to-push command. */
  static toggle(collection: SceneCollection): SetCollectionVisibilityCommand {
    const before = collection.visible;
    collection.visible = !before;
    return new SetCollectionVisibilityCommand(collection, before, !before);
  }

  undo(): void { this.collection.visible = this.before; }
  redo(): void { this.collection.visible = this.after; }
}

export class RenameCollectionCommand implements Command {
  readonly name = 'Rename Collection';

  constructor(
    private readonly collection: SceneCollection,
    private readonly before: string,
    private readonly after: string,
  ) {}

  undo(): void { this.collection.name = this.before; }
  redo(): void { this.collection.name = this.after; }
}
