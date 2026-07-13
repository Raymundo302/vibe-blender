/**
 * Object-type visibility & selectability (Blender's "Object Types Visibility"
 * viewport-header popover). A per-kind pair of toggles — `show` draws the type
 * in the viewport, `select` lets it be picked — that the Renderer reads every
 * frame. Like overlay prefs these are an APP PREFERENCE: not undoable, survive
 * scene load / new file, persisted in localStorage under `vibe-object-types`.
 *
 * Scope is the VIEWPORT (display + picking), matching Blender — the F12 path
 * tracer renders every object regardless.
 */

import type { ObjectKind } from '../core/scene/objectData';

/** Per-type toggles. `show` off hides the type (and makes it unpickable too);
 *  `select` off keeps it visible but not clickable. */
export interface TypeToggle {
  show: boolean;
  select: boolean;
}

/** The kinds exposed in the dropdown, in display order. */
export const TYPE_KINDS: readonly ObjectKind[] = ['mesh', 'curve', 'text', 'light', 'camera', 'empty'];

export type ObjectTypePrefs = Record<ObjectKind, TypeToggle>;

const STORAGE_KEY = 'vibe-object-types';

/** Everything shown and selectable by default (app looks unchanged). */
export function defaultObjectTypePrefs(): ObjectTypePrefs {
  const out = {} as ObjectTypePrefs;
  for (const k of TYPE_KINDS) out[k] = { show: true, select: true };
  return out;
}

/** The live singleton the Renderer reads; mutated in place. */
export const objectTypes: ObjectTypePrefs = defaultObjectTypePrefs();

/** True when the type is drawn in the viewport. */
export function typeShown(kind: ObjectKind): boolean {
  return objectTypes[kind]?.show !== false;
}

/** True when the type can be picked (must be shown AND selectable). */
export function typePickable(kind: ObjectKind): boolean {
  const t = objectTypes[kind];
  return t ? t.show && t.select : true;
}

/** Read prefs from localStorage into the singleton (missing/bad keys default). */
export function loadObjectTypePrefs(): ObjectTypePrefs {
  const d = defaultObjectTypePrefs();
  let stored: unknown = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) stored = JSON.parse(raw);
  } catch {
    stored = null;
  }
  const src = (stored && typeof stored === 'object') ? stored as Record<string, unknown> : {};
  for (const k of TYPE_KINDS) {
    const s = src[k];
    const show = s && typeof s === 'object' && typeof (s as TypeToggle).show === 'boolean' ? (s as TypeToggle).show : d[k].show;
    const select = s && typeof s === 'object' && typeof (s as TypeToggle).select === 'boolean' ? (s as TypeToggle).select : d[k].select;
    objectTypes[k] = { show, select };
  }
  return objectTypes;
}

/** Persist the current singleton to localStorage (no-op if storage throws). */
export function saveObjectTypePrefs(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(objectTypes));
  } catch {
    /* storage unavailable — prefs stay in-memory only */
  }
}
