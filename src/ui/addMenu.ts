import type { Scene, SceneObject } from '../core/scene/Scene';
import type { UndoStack } from '../core/undo/UndoStack';
import { PRIMITIVES, type PrimitiveDef } from '../core/mesh/primitives';
import { AddObjectsCommand } from '../core/undo/objectCommands';
import type { LightType } from '../core/scene/objectData';

const LIGHTS: { name: string; type: LightType }[] = [
  { name: 'Point', type: 'point' },
  { name: 'Sun', type: 'sun' },
  { name: 'Spot', type: 'spot' },
];

/** Everything the popup needs; kept free of InputManager internals. */
export interface AddMenuOptions {
  /** Positioned host — the pointer coords are relative to this element. */
  parent: HTMLElement;
  /** Pointer position (parent-local CSS px) where the menu should appear. */
  x: number;
  y: number;
  scene: Scene;
  undo: UndoStack;
  setStatus: (text: string) => void;
  /** Fired exactly once when the menu tears down (so the owner drops its ref). */
  onClose: () => void;
}

/**
 * Blender's Shift-A "Add Mesh" popup. A self-contained DOM widget: it owns its
 * element and all listeners, and removes every one of them on close so the
 * InputManager never has to. All styling lives in the shared theme.css (P1-7).
 */
export class AddMenu {
  private readonly root: HTMLDivElement;
  private closed = false;

  constructor(private readonly opts: AddMenuOptions) {
    this.root = document.createElement('div');
    this.root.className = 'add-menu';

    this.heading('Add Mesh');
    for (const def of PRIMITIVES) {
      this.item(def.name, () => this.addPrimitive(def));
    }

    this.heading('Add Light');
    for (const { name, type } of LIGHTS) {
      this.item(name, () =>
        this.commitAdd(name, this.opts.scene.addLight(name, type)));
    }

    this.heading('Add Camera');
    this.item('Camera', () =>
      this.commitAdd('Camera', this.opts.scene.addCamera('Camera')));

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
    heading.className = 'add-menu-heading';
    heading.textContent = text;
    this.root.appendChild(heading);
  }

  private item(label: string, onClick: () => void): void {
    const item = document.createElement('button');
    item.className = 'add-menu-item';
    item.type = 'button';
    item.textContent = label;
    item.addEventListener('click', onClick);
    this.root.appendChild(item);
  }

  private addPrimitive(def: PrimitiveDef): void {
    this.commitAdd(def.name, this.opts.scene.add(def.name, def.make()));
  }

  /** Select the freshly added object, push ONE undo entry, close. */
  private commitAdd(name: string, obj: SceneObject): void {
    const { scene, undo, setStatus } = this.opts;
    scene.selectOnly(obj.id);
    // Construct AFTER scene.add so the command captures the real list index.
    undo.push(new AddObjectsCommand('Add ' + name, scene, [obj]));
    setStatus(`Added ${name}`);
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
