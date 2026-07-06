import type { Scene } from '../core/scene/Scene';
import type { UndoStack } from '../core/undo/UndoStack';
import { PRIMITIVES, type PrimitiveDef } from '../core/mesh/primitives';
import { AddObjectsCommand } from '../core/undo/objectCommands';

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

const STYLE_ID = 'add-menu-style';

/**
 * Blender's Shift-A "Add Mesh" popup. A self-contained DOM widget: it owns its
 * element and all listeners, and removes every one of them on close so the
 * InputManager never has to. P1-7 restyles it; the CSS here is deliberately
 * minimal, injected once.
 */
function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.add-menu {
  position: absolute; z-index: 100; min-width: 140px;
  background: #333; border: 1px solid #111; border-radius: 4px;
  padding: 4px 0; font: 12px/1.4 "Segoe UI", system-ui, sans-serif;
  color: #d0d0d0; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
  user-select: none;
}
.add-menu-heading {
  padding: 3px 12px; font-size: 11px; text-transform: uppercase;
  letter-spacing: 0.05em; color: #888;
}
.add-menu-item {
  display: block; width: 100%; text-align: left; border: none;
  background: none; color: inherit; font: inherit; cursor: pointer;
  padding: 4px 12px;
}
.add-menu-item:hover { background: #4a6a9a; color: #fff; }
`;
  document.head.appendChild(style);
}

export class AddMenu {
  private readonly root: HTMLDivElement;
  private closed = false;

  constructor(private readonly opts: AddMenuOptions) {
    ensureStyle();

    this.root = document.createElement('div');
    this.root.className = 'add-menu';

    const heading = document.createElement('div');
    heading.className = 'add-menu-heading';
    heading.textContent = 'Add Mesh';
    this.root.appendChild(heading);

    for (const def of PRIMITIVES) {
      const item = document.createElement('button');
      item.className = 'add-menu-item';
      item.type = 'button';
      item.textContent = def.name;
      item.addEventListener('click', () => this.addPrimitive(def));
      this.root.appendChild(item);
    }

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

  private addPrimitive(def: PrimitiveDef): void {
    const { scene, undo, setStatus } = this.opts;
    const obj = scene.add(def.name, def.make());
    scene.selectOnly(obj.id);
    // Construct AFTER scene.add so the command captures the real list index.
    undo.push(new AddObjectsCommand('Add ' + def.name, scene, [obj]));
    setStatus(`Added ${def.name}`);
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
