import type { Scene } from '../scene/Scene';
import type { OrbitCamera } from '../../camera/OrbitCamera';
import type { UndoStack } from '../undo/UndoStack';

/**
 * Modal operator system (architecture decision A1) — Blender's core tool
 * abstraction. Pressing G doesn't move anything; it starts an operator that
 * owns all input until it confirms (LMB/Enter → push undo command) or
 * cancels (RMB/Esc → restore starting state).
 *
 * One dispatcher (InputManager) holds at most one active operator and routes
 * events to it before any global keymap handling.
 */

/** Everything an operator may touch, handed in at start. */
export interface OperatorContext {
  scene: Scene;
  camera: OrbitCamera;
  undo: UndoStack;
  /** Canvas CSS size, for pointer→NDC conversion. */
  viewportSize(): { width: number; height: number };
  /** Set the status-bar text ('' to clear). */
  setStatus(text: string): void;
}

export interface PointerState {
  /** CSS pixels relative to the canvas. */
  x: number;
  y: number;
}

export interface Operator {
  readonly name: string;

  /** Return false to abort immediately (e.g. nothing selected). */
  start(ctx: OperatorContext, pointer: PointerState): boolean;

  onPointerMove(ctx: OperatorContext, pointer: PointerState): void;

  /**
   * Modifier keys while modal (axis locks, numeric input, ...).
   * Return true if the key was consumed.
   */
  onKey(ctx: OperatorContext, key: string): boolean;

  /** LMB or Enter: apply final state and push the undo command. */
  confirm(ctx: OperatorContext): void;

  /** RMB or Esc: restore the pre-operator state. */
  cancel(ctx: OperatorContext): void;
}
