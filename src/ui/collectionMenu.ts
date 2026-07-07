import type { Scene } from '../core/scene/Scene';
import type { UndoStack } from '../core/undo/UndoStack';
import {
  CreateCollectionCommand,
  MoveToCollectionCommand,
} from '../core/undo/collectionCommands';
import './collectionMenu.css';

/** Everything the popup needs; kept free of InputManager internals. */
export interface CollectionMenuOptions {
  /** Positioned host — the pointer coords are relative to this element. */
  parent: HTMLElement;
  /** Pointer position (parent-local CSS px) where the menu should appear. */
  x: number;
  y: number;
  scene: Scene;
  undo: UndoStack;
  /** Object ids to move (snapshot of the selection at open time). */
  objectIds: number[];
  setStatus: (text: string) => void;
  /** Fired exactly once when the menu tears down (so the owner drops its ref). */
  onClose: () => void;
}

/**
 * Blender's "M — Move to Collection" popup for object mode. Lists every existing
 * collection plus "New Collection" and "Scene Root", and assigns every selected
 * object's collectionId through the undo stack. Self-contained DOM widget: owns
 * its element and listeners and removes all of them on close (mirrors AddMenu).
 */
export class CollectionMenu {
  private readonly root: HTMLDivElement;
  private closed = false;

  constructor(private readonly opts: CollectionMenuOptions) {
    this.root = document.createElement('div');
    this.root.className = 'col-menu';

    this.heading('Move to Collection');
    for (const col of opts.scene.collections) {
      this.item(col.name, () => this.moveTo(col.id, col.name));
    }
    this.item('+ New Collection', () => this.moveToNew());
    this.item('Scene Root', () => this.moveTo(null, 'Scene Root'));

    // Position at the pointer, then clamp so the menu stays inside the host.
    this.root.style.left = `${opts.x}px`;
    this.root.style.top = `${opts.y}px`;
    opts.parent.appendChild(this.root);
    const maxX = Math.max(0, opts.parent.clientWidth - this.root.offsetWidth);
    const maxY = Math.max(0, opts.parent.clientHeight - this.root.offsetHeight);
    this.root.style.left = `${Math.min(opts.x, maxX)}px`;
    this.root.style.top = `${Math.min(opts.y, maxY)}px`;

    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('pointerdown', this.onOutsidePointer, true);
  }

  private heading(text: string): void {
    const heading = document.createElement('div');
    heading.className = 'col-menu-heading';
    heading.textContent = text;
    this.root.appendChild(heading);
  }

  private item(label: string, onClick: () => void): void {
    const item = document.createElement('button');
    item.className = 'col-menu-item';
    item.type = 'button';
    item.textContent = label;
    item.addEventListener('click', onClick);
    this.root.appendChild(item);
  }

  /** Assign every selected object to an existing collection (or the root). */
  private moveTo(collectionId: number | null, label: string): void {
    const { scene, undo, objectIds, setStatus } = this.opts;
    undo.push(MoveToCollectionCommand.perform(scene, objectIds, collectionId));
    setStatus(`Moved ${objectIds.length} object(s) to ${label}`);
    this.close();
  }

  /** Create a fresh collection then move the selection into it (two undo steps). */
  private moveToNew(): void {
    const { scene, undo, objectIds, setStatus } = this.opts;
    const col = scene.addCollection();
    undo.push(new CreateCollectionCommand(scene, col));
    undo.push(MoveToCollectionCommand.perform(scene, objectIds, col.id));
    setStatus(`Moved ${objectIds.length} object(s) to ${col.name}`);
    this.close();
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
    }
  };

  private readonly onOutsidePointer = (e: PointerEvent): void => {
    if (!this.root.contains(e.target as Node)) this.close();
  };

  /** Idempotent teardown: removes the element and every listener exactly once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('pointerdown', this.onOutsidePointer, true);
    this.root.remove();
    this.opts.onClose();
  }
}
