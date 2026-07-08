import type { Scene, SceneObject } from '../core/scene/Scene';
import type { UndoStack } from '../core/undo/UndoStack';
import { InsertKeysCommand, LOC_ROT_SCALE } from '../core/anim/animCommands';
import './keyingMenu.css';

/** The keying sets Blender's I menu offers, in listed order. */
interface KeyingSet {
  label: string;
  channels: string[];
}

const LOCATION = ['location.x', 'location.y', 'location.z'];
const ROTATION = ['rotation.x', 'rotation.y', 'rotation.z'];
const SCALE = ['scale.x', 'scale.y', 'scale.z'];

const KEYING_SETS: KeyingSet[] = [
  { label: 'Location', channels: LOCATION },
  { label: 'Rotation', channels: ROTATION },
  { label: 'Scale', channels: SCALE },
  { label: 'LocRotScale', channels: LOC_ROT_SCALE },
];

/** The default (highlighted) entry — a second I confirms it (I,I = LocRotScale). */
const DEFAULT_INDEX = KEYING_SETS.length - 1;

/** Everything the popup needs; kept free of InputManager internals. */
export interface KeyingMenuOptions {
  /** Positioned host — the pointer coords are relative to this element. */
  parent: HTMLElement;
  /** Pointer position (parent-local CSS px) where the menu should appear. */
  x: number;
  y: number;
  scene: Scene;
  undo: UndoStack;
  /** Selection snapshot (object mode) to key. */
  objects: SceneObject[];
  setStatus: (text: string) => void;
  /** Fired exactly once when the menu tears down (so the owner drops its ref). */
  onClose: () => void;
}

/**
 * Blender's "I — Insert Keyframe" popup for object mode. Lists Location /
 * Rotation / Scale / LocRotScale; the last is the highlighted default so a
 * second I press keys LocRotScale (I,I) exactly like the old plain-I did.
 * Each entry runs InsertKeysCommand with its channel subset at
 * scene.frameCurrent through the undo stack. Self-contained DOM widget: owns
 * its element + listeners and removes all of them on close (mirrors AddMenu).
 */
export class KeyingMenu {
  private readonly root: HTMLDivElement;
  private closed = false;

  constructor(private readonly opts: KeyingMenuOptions) {
    this.root = document.createElement('div');
    this.root.className = 'key-menu';

    this.heading('Insert Keyframe');
    KEYING_SETS.forEach((set, i) => {
      this.item(set.label, i === DEFAULT_INDEX, () => this.key(set));
    });

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
    heading.className = 'key-menu-heading';
    heading.textContent = text;
    this.root.appendChild(heading);
  }

  private item(label: string, isDefault: boolean, onClick: () => void): void {
    const item = document.createElement('button');
    item.className = isDefault ? 'key-menu-item default' : 'key-menu-item';
    item.type = 'button';
    item.textContent = label;
    item.addEventListener('click', onClick);
    this.root.appendChild(item);
  }

  /** Confirm the highlighted default entry (used by a second I press). */
  confirmDefault(): void {
    this.key(KEYING_SETS[DEFAULT_INDEX]);
  }

  private key(set: KeyingSet): void {
    const { scene, undo, objects, setStatus } = this.opts;
    const cmd = InsertKeysCommand.perform(
      `Insert ${set.label}`,
      scene,
      objects,
      set.channels,
      scene.frameCurrent,
    );
    if (cmd) {
      undo.push(cmd);
      setStatus(`Keyed ${set.label} @ frame ${scene.frameCurrent} (${objects.length} object(s))`);
    }
    this.close();
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
      return;
    }
    // A second I confirms the highlighted default (I,I = LocRotScale).
    if ((e.key === 'i' || e.key === 'I') && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      this.confirmDefault();
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
