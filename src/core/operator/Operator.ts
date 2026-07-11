import type { Scene } from '../scene/Scene';
import type { OrbitCamera } from '../../camera/OrbitCamera';
import type { UndoStack } from '../undo/UndoStack';
import type { Vec3 } from '../math/vec3';

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

  /**
   * Optional key-RELEASE hook (InputManager forwards keyups to the active op).
   * Only the ops that need it implement this — used so MOVE operators can react
   * to Ctrl being released (grid-snap invert is held, not toggled).
   */
  onKeyUp?(ctx: OperatorContext, key: string): void;

  /**
   * Optional: the operator's current world-axis constraint, so the viewport
   * can keep that axis's gizmo arrow visible while the modal runs. Return the
   * locked axis + the world pivot to anchor the indicator at, or null when
   * moving freely. InputManager polls this after every routed event.
   */
  axisIndicator?(): { axis: 'x' | 'y' | 'z'; pivot: Vec3 } | null;

  /**
   * Optional: WORLD-space guide line segments to draw while the modal runs —
   * Blender's slide/tangent visualization (e.g. edge-slide rails). Generic hook;
   * only the ops that need it implement it. InputManager polls it and mirrors the
   * result onto the renderer, clearing it when the operator ends. Return null for
   * no guides.
   */
  guideSegments?(): { a: Vec3; b: Vec3 }[] | null;

  /** LMB or Enter: apply final state and push the undo command. */
  confirm(ctx: OperatorContext): void;

  /** RMB or Esc: restore the pre-operator state. */
  cancel(ctx: OperatorContext): void;
}
