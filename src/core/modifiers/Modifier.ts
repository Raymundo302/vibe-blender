import type { EditableMesh } from '../mesh/EditableMesh';
import type { Mat4 } from '../math/mat4';

/**
 * Non-destructive modifier stack (Phase 4). Each modifier derives a NEW mesh
 * from its input — the object's base mesh is never touched. The stack is
 * evaluated top-to-bottom by SceneObject.evaluatedMesh(), which caches on
 * (mesh.version, modifiersVersion).
 *
 * Params are exposed through generic field descriptors so the Modifier-tab UI
 * renders every modifier type without knowing any of them.
 */

export type ModifierFieldKind = 'number' | 'int' | 'bool' | 'axis' | 'object' | 'select';

export interface ModifierField {
  key: string;
  label: string;
  kind: ModifierFieldKind;
  min?: number;
  max?: number;
  step?: number;
  /** For kind 'select': the enumerated string options to offer. */
  options?: { value: string; label: string }[];
}

export type ModifierParams = Record<string, number | boolean | string>;

/** Another scene object, as seen by a modifier (Shrinkwrap target, Scatter source). */
export interface ModifierTarget {
  /** The target's EVALUATED mesh (its own modifier stack applied). */
  mesh: EditableMesh;
  /** The target's world matrix. */
  matrix: Mat4;
  /** Cache-key contribution: bumps when the target's evaluated mesh changes. */
  version: string;
}

/**
 * Scene access for modifiers that reference other objects ('object' params).
 * Provided by Scene.modifierContext(host); absent (undefined) in contexts with
 * no scene (unit tests on bare meshes) — such modifiers must then no-op by
 * returning the input mesh unchanged.
 */
export interface ModifierContext {
  /** World matrix of the object that owns the modifier stack. */
  hostMatrix: Mat4;
  /** Resolve an object id, or null (missing / cycle / non-mesh). */
  target(objectId: number): ModifierTarget | null;
  /**
   * The host object's curve payload, iff it is a curve object (UR11-2). The Pipe
   * modifier reads this to materialize its tube — a curve object carries an EMPTY
   * base mesh, so the geometry source is the curve, not the mesh passed to
   * apply(). Absent on mesh hosts (and in scene-less unit contexts) → Pipe no-ops.
   */
  hostCurve?: import('../scene/objectData').CurveData;
}

export interface Modifier {
  /** Registry key, e.g. 'mirror'. */
  readonly type: string;
  /** Display name, user-editable. */
  name: string;
  enabled: boolean;

  /** PURE: derive a new mesh. Must not mutate the input. */
  apply(mesh: EditableMesh, ctx?: ModifierContext): EditableMesh;

  /** Current param values (plain data — serialized into scene files). */
  params(): ModifierParams;
  /** Set one param (values come from the generic UI / deserialization). */
  setParam(key: string, value: number | boolean | string): void;
  /** UI schema for the params. */
  fields(): ModifierField[];

  /**
   * Extra cache-key material for modifiers whose output depends on things
   * OUTSIDE the host mesh + params (target meshes, host/target transforms).
   * Omit (or return '') for self-contained modifiers.
   */
  depVersion?(ctx?: ModifierContext): string;
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
