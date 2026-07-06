import { Vec3 } from './math/vec3';

/**
 * Grid ("increment") snapping. Blender lets you snap transforms to a grid; ours
 * is fixed at a 0.5-unit increment. State is module-level so it persists across
 * operator invocations and is shared by the InputManager (Shift+Tab toggle), the
 * topbar magnet chip, and the modal MOVE operators.
 */
export const SNAP_STEP = 0.5;

export interface SnapState {
  enabled: boolean;
}

export const snapState: SnapState = { enabled: false };

/**
 * Whether snapping should apply for the current modal frame. Holding Ctrl during
 * a modal INVERTS the persistent state (snap-off → Ctrl snaps; snap-on → Ctrl
 * disables), so the effective flag is the XOR of the two.
 */
export function snapActive(ctrlHeld: boolean): boolean {
  return snapState.enabled !== ctrlHeld;
}

/**
 * Round each component of `v` to the nearest multiple of `step`. Pure; used to
 * snap a moved point's WORLD position onto the grid. `step <= 0` is a no-op
 * (returns the input unchanged) so callers never divide by zero.
 */
export function snapVec(v: Vec3, step: number): Vec3 {
  if (step <= 0) return v;
  return new Vec3(
    Math.round(v.x / step) * step,
    Math.round(v.y / step) * step,
    Math.round(v.z / step) * step,
  );
}
