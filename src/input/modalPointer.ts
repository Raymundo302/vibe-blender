/**
 * Continuous-grab virtual pointer (UR4-1).
 *
 * Blender-style modal transforms must survive the pointer leaving the canvas or
 * window edge. Instead of feeding operators the raw (bounded) cursor position,
 * we accumulate raw movement DELTAS into a virtual, unbounded pointer position
 * and feed THAT to the operator.
 *
 * Holding Shift enters "precision" mode: each accumulated delta is scaled by
 * 0.1. Because we scale the INCREMENT (not the absolute position), pressing or
 * releasing Shift mid-gesture never produces a positional jump — the virtual
 * position stays exactly where it was and only the RATE of subsequent movement
 * changes.
 *
 * Pure: no DOM, no globals — trivially unit-testable.
 */
export class ModalPointer {
  private _x = 0;
  private _y = 0;

  /** Precision scale applied to each delta while `precise` is true. */
  static readonly PRECISION = 0.1;

  /** Seed the virtual position (typically the real cursor position at the start
   *  of the gesture). Resets the accumulator to (x, y). */
  begin(x: number, y: number): void {
    this._x = x;
    this._y = y;
  }

  /**
   * Integrate one raw movement delta and return the new virtual position.
   * `precise` (Shift held) scales THIS delta by 0.1 — applied to the increment,
   * so toggling it never moves the accumulated position.
   */
  move(dx: number, dy: number, precise: boolean): { x: number; y: number } {
    const s = precise ? ModalPointer.PRECISION : 1;
    this._x += dx * s;
    this._y += dy * s;
    return { x: this._x, y: this._y };
  }

  /** Current virtual position (unbounded). */
  get pos(): { x: number; y: number } {
    return { x: this._x, y: this._y };
  }
}
