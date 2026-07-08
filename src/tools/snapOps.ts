import { Vec3 } from '../core/math/vec3';
import { snapVec, SNAP_STEP } from '../core/snap';
import { captureWorldTargets, writeWorldPosition } from './worldTargets';
import { TransformCommand, type TransformEntry } from '../core/undo/commands';
import type { Scene } from '../core/scene/Scene';
import type { UndoStack } from '../core/undo/UndoStack';

/**
 * Blender's Shift+S "Snap" pie operators (P12). Pure state mutations on the
 * scene — the InputManager binding wires them to pie wedges and setStatus's the
 * returned label. Cursor-only moves are NOT undoable (Blender semantics); the
 * two Selection ops push ONE TransformCommand covering every moved object.
 *
 * Object moves always go through captureWorldTargets + writeWorldPosition so a
 * parented child lands at the right WORLD position (never writes local
 * transform.position directly).
 */

/** Cursor → world origin. */
export function cursorToOrigin(scene: Scene): string {
  scene.cursor = Vec3.ZERO;
  return 'Cursor to World Origin';
}

/**
 * Cursor → median of the selection in WORLD space. Object mode: median of
 * selected objects' world positions. Edit mode: median of selected verts mapped
 * through the edited object's world matrix.
 */
export function cursorToSelected(scene: Scene): string {
  if (scene.editMode) {
    const obj = scene.editObject;
    if (!obj) return 'No selection';
    const mesh = obj.mesh;
    const ids = scene.editMode.selectedVertIds(mesh);
    const world = scene.worldMatrix(obj);
    let sum = Vec3.ZERO;
    let n = 0;
    for (const id of ids) {
      const v = mesh.verts.get(id);
      if (v) { sum = sum.add(world.transformPoint(v.co)); n++; }
    }
    if (n === 0) return 'No selection';
    scene.cursor = sum.scale(1 / n);
    return 'Cursor to Selected';
  }
  const sel = scene.selectedObjects;
  if (sel.length === 0) return 'No selection';
  let sum = Vec3.ZERO;
  for (const o of sel) sum = sum.add(scene.worldTransformOf(o).position);
  scene.cursor = sum.scale(1 / sel.length);
  return 'Cursor to Selected';
}

/** Cursor → nearest grid increment (SNAP_STEP). */
export function cursorToGrid(scene: Scene): string {
  scene.cursor = snapVec(scene.cursor, SNAP_STEP);
  return 'Cursor to Grid';
}

/**
 * Every selected object's WORLD position := the 3D cursor (each object
 * individually — Blender's default). Object mode only; one undo step.
 */
export function selectionToCursor(scene: Scene, undo: UndoStack): string {
  if (scene.editMode) return 'Object mode only';
  const sel = scene.selectedObjects;
  if (sel.length === 0) return 'No selection';
  const targets = captureWorldTargets(scene, sel);
  const entries: TransformEntry[] = [];
  for (const t of targets) {
    writeWorldPosition(t, scene.cursor);
    entries.push({ object: t.object, before: t.before, after: t.object.transform });
  }
  undo.push(new TransformCommand('Selection to Cursor', entries));
  return 'Selection to Cursor';
}

/**
 * Every selected object's WORLD position := snapped to the grid (SNAP_STEP).
 * Object mode only; one undo step.
 */
export function selectionToGrid(scene: Scene, undo: UndoStack): string {
  if (scene.editMode) return 'Object mode only';
  const sel = scene.selectedObjects;
  if (sel.length === 0) return 'No selection';
  const targets = captureWorldTargets(scene, sel);
  const entries: TransformEntry[] = [];
  for (const t of targets) {
    writeWorldPosition(t, snapVec(t.beforeWorld.position, SNAP_STEP));
    entries.push({ object: t.object, before: t.before, after: t.object.transform });
  }
  undo.push(new TransformCommand('Selection to Grid', entries));
  return `Snapped ${sel.length} object(s)`;
}
