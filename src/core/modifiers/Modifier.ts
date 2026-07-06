import type { EditableMesh } from '../mesh/EditableMesh';

/**
 * Non-destructive modifier stack (Phase 4). Each modifier derives a NEW mesh
 * from its input — the object's base mesh is never touched. The stack is
 * evaluated top-to-bottom by SceneObject.evaluatedMesh(), which caches on
 * (mesh.version, modifiersVersion).
 *
 * Params are exposed through generic field descriptors so the Modifier-tab UI
 * renders every modifier type without knowing any of them.
 */

export type ModifierFieldKind = 'number' | 'int' | 'bool' | 'axis';

export interface ModifierField {
  key: string;
  label: string;
  kind: ModifierFieldKind;
  min?: number;
  max?: number;
  step?: number;
}

export type ModifierParams = Record<string, number | boolean | string>;

export interface Modifier {
  /** Registry key, e.g. 'mirror'. */
  readonly type: string;
  /** Display name, user-editable. */
  name: string;
  enabled: boolean;

  /** PURE: derive a new mesh. Must not mutate the input. */
  apply(mesh: EditableMesh): EditableMesh;

  /** Current param values (plain data — serialized into scene files). */
  params(): ModifierParams;
  /** Set one param (values come from the generic UI / deserialization). */
  setParam(key: string, value: number | boolean | string): void;
  /** UI schema for the params. */
  fields(): ModifierField[];
}

type ModifierCtor = (params?: ModifierParams) => Modifier;

const registry = new Map<string, { label: string; create: ModifierCtor }>();

export function registerModifier(type: string, label: string, create: ModifierCtor): void {
  registry.set(type, { label, create });
}

export function createModifier(type: string, params?: ModifierParams): Modifier {
  const entry = registry.get(type);
  if (!entry) throw new Error(`Unknown modifier type "${type}"`);
  return entry.create(params);
}

export function modifierTypes(): { type: string; label: string }[] {
  return [...registry.entries()].map(([type, e]) => ({ type, label: e.label }));
}

/** Deep-copy a modifier via its own registry factory + params. */
export function cloneModifier(m: Modifier): Modifier {
  const copy = createModifier(m.type, m.params());
  copy.name = m.name;
  copy.enabled = m.enabled;
  return copy;
}
