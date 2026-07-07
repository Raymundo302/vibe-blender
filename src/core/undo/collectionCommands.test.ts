import { describe, expect, it } from 'vitest';
import { Scene } from '../scene/Scene';
import { makeCube } from '../mesh/primitives';
import { UndoStack } from './UndoStack';
import {
  CreateCollectionCommand,
  DeleteCollectionCommand,
  MoveToCollectionCommand,
  SetCollectionVisibilityCommand,
  RenameCollectionCommand,
} from './collectionCommands';

describe('collectionCommands (P10-1)', () => {
  it('CreateCollectionCommand round-trips under undo/redo', () => {
    const scene = new Scene();
    const undo = new UndoStack();
    const col = scene.addCollection('Props');
    undo.push(new CreateCollectionCommand(scene, col));
    expect(scene.collections.length).toBe(1);

    undo.undo();
    expect(scene.collections.length).toBe(0);

    undo.redo();
    expect(scene.collections.length).toBe(1);
    // Same object (id preserved), not a fresh one.
    expect(scene.collections[0]).toBe(col);
    expect(scene.getCollection(col.id)?.name).toBe('Props');
  });

  it('DeleteCollectionCommand restores every ex-member on undo', () => {
    const scene = new Scene();
    const undo = new UndoStack();
    const col = scene.addCollection('Props');
    const a = scene.add('A', makeCube());
    const b = scene.add('B', makeCube());
    const c = scene.add('C', makeCube());
    a.collectionId = col.id;
    b.collectionId = col.id;
    // c stays at the root.

    undo.push(DeleteCollectionCommand.perform(scene, col.id)!);
    expect(scene.collections.length).toBe(0);
    expect(a.collectionId).toBeNull();
    expect(b.collectionId).toBeNull();

    undo.undo();
    expect(scene.getCollection(col.id)?.name).toBe('Props');
    expect(a.collectionId).toBe(col.id);
    expect(b.collectionId).toBe(col.id);
    expect(c.collectionId).toBeNull();

    undo.redo();
    expect(scene.collections.length).toBe(0);
    expect(a.collectionId).toBeNull();
    expect(b.collectionId).toBeNull();
  });

  it('DeleteCollectionCommand preserves the list index across undo', () => {
    const scene = new Scene();
    const undo = new UndoStack();
    const first = scene.addCollection('First');
    const mid = scene.addCollection('Mid');
    const last = scene.addCollection('Last');

    undo.push(DeleteCollectionCommand.perform(scene, mid.id)!);
    undo.undo();
    expect(scene.collections.map((c) => c.name)).toEqual(['First', 'Mid', 'Last']);
    void first; void last;
  });

  it('MoveToCollectionCommand restores per-object previous assignment', () => {
    const scene = new Scene();
    const undo = new UndoStack();
    const src = scene.addCollection('Src');
    const dst = scene.addCollection('Dst');
    const a = scene.add('A', makeCube());
    const b = scene.add('B', makeCube());
    a.collectionId = src.id; // a starts in Src
    b.collectionId = null; // b starts at the root

    undo.push(MoveToCollectionCommand.perform(scene, [a.id, b.id], dst.id));
    expect(a.collectionId).toBe(dst.id);
    expect(b.collectionId).toBe(dst.id);

    undo.undo();
    expect(a.collectionId).toBe(src.id);
    expect(b.collectionId).toBeNull();

    undo.redo();
    expect(a.collectionId).toBe(dst.id);
    expect(b.collectionId).toBe(dst.id);
  });

  it('MoveToCollectionCommand to the scene root (null) round-trips', () => {
    const scene = new Scene();
    const undo = new UndoStack();
    const col = scene.addCollection();
    const a = scene.add('A', makeCube());
    a.collectionId = col.id;

    undo.push(MoveToCollectionCommand.perform(scene, [a.id], null));
    expect(a.collectionId).toBeNull();
    undo.undo();
    expect(a.collectionId).toBe(col.id);
  });

  it('SetCollectionVisibilityCommand toggles and round-trips', () => {
    const scene = new Scene();
    const undo = new UndoStack();
    const col = scene.addCollection();
    expect(col.visible).toBe(true);

    undo.push(SetCollectionVisibilityCommand.toggle(col));
    expect(col.visible).toBe(false);
    undo.undo();
    expect(col.visible).toBe(true);
    undo.redo();
    expect(col.visible).toBe(false);
  });

  it('RenameCollectionCommand round-trips', () => {
    const scene = new Scene();
    const undo = new UndoStack();
    const col = scene.addCollection('Old');
    col.name = 'New';
    undo.push(new RenameCollectionCommand(col, 'Old', 'New'));
    undo.undo();
    expect(col.name).toBe('Old');
    undo.redo();
    expect(col.name).toBe('New');
  });
});
