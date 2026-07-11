import type { SceneObject } from '../core/scene/Scene';

/**
 * Page / browse mode (UR7-2 A) — "treat the HTML plane like a website".
 *
 * Pressing Tab with an HTML plane active enters this mode instead of mesh Edit
 * Mode (plain meshes keep Edit Mode as-is). While it is active the viewport
 * wheel SCROLLS the page (adjusts `html.scrollY`) rather than zooming the
 * camera; orbit (MMB) and pan stay live. Tab or Esc exits.
 *
 * State is module-level and viewport-ish, exactly like snapState / xrayState:
 * entering/leaving page mode creates NO undo entry (scrollY serializes with the
 * scene but is not undo-tracked — Blender-precedent: a pane's view). `object` is
 * the plane being browsed (null = not in page mode).
 */
export const pageModeState: { object: SceneObject | null } = { object: null };

/** True while the viewport is browsing an HTML plane. */
export function inPageMode(): boolean {
  return pageModeState.object !== null;
}

/** Enter page mode on `obj` (an HTML plane). */
export function enterPageMode(obj: SceneObject): void {
  pageModeState.object = obj;
}

/** Leave page mode (idempotent). */
export function exitPageMode(): void {
  pageModeState.object = null;
}
