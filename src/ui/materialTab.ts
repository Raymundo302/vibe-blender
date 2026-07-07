import type { Scene, SceneObject } from '../core/scene/Scene';
import type { UndoStack, Command } from '../core/undo/UndoStack';
import type { Material } from '../core/scene/objectData';
import { registerPropertiesTab } from './propertiesEditor';
import './materialTab.css';

/**
 * Material properties tab (P8-3) — Blender's material sphere. Manages the scene
 * material library and the active mesh object's slot assignment. The rendered
 * viewport already draws mesh objects with scene.materialOf(obj); this tab is the
 * data UI on top of that.
 *
 * Empty unless the active object is a MESH. A slot select lists the library by
 * name plus "(None)"; "New" creates + assigns a material in one undo step. When a
 * material is assigned its fields (name / baseColor / metallic / roughness /
 * emissive / emissiveStrength) edit the shared library entry — edits reach every
 * object using that material, which is correct library semantics.
 *
 * Registered at module load, mirroring the Object / Modifier tabs — main.ts
 * imports this file once for the side effect.
 */

// ------------------------------------------------------------- undo commands --

/** RGB triple → fresh copy so before/after snapshots don't alias. */
function cloneRgb(c: readonly [number, number, number]): [number, number, number] {
  return [c[0], c[1], c[2]];
}

/** Assign (or clear) an object's material slot. Convention: caller already set
 * obj.materialId to `after` before pushing. */
export class AssignMaterialCommand implements Command {
  readonly name = 'Assign Material';

  constructor(
    private readonly obj: SceneObject,
    private readonly before: number | null,
    private readonly after: number | null,
  ) {}

  undo(): void { this.obj.materialId = this.before; }
  redo(): void { this.obj.materialId = this.after; }
}

/**
 * Create a new material AND assign it to an object in a single undo step. Undo
 * removes the material from the library and restores the prior assignment; redo
 * RE-INSERTS the very same Material object (preserving its id — see Result note)
 * and reassigns it. Use the static perform() to construct: it does the creation
 * so the command captures a real id.
 */
export class NewMaterialCommand implements Command {
  readonly name = 'New Material';

  private constructor(
    private readonly scene: Scene,
    private readonly obj: SceneObject,
    /** The created library entry — kept so redo re-inserts it with the SAME id. */
    readonly material: Material,
    private readonly beforeId: number | null,
  ) {}

  /** Create the material via scene.addMaterial(), assign it, return the command. */
  static perform(scene: Scene, obj: SceneObject): NewMaterialCommand {
    const beforeId = obj.materialId;
    const material = scene.addMaterial();
    obj.materialId = material.id;
    return new NewMaterialCommand(scene, obj, material, beforeId);
  }

  undo(): void {
    // removeMaterial unassigns it from every object (only `obj` at this point);
    // then restore whatever the object referenced before.
    this.scene.removeMaterial(this.material.id);
    this.obj.materialId = this.beforeId;
  }

  redo(): void {
    // Re-insert the captured entry directly to preserve its id (addMaterial's
    // counter would hand out a fresh one). Guard against a double-insert.
    if (!this.scene.materials.some((m) => m.id === this.material.id)) {
      this.scene.materials.push(this.material);
    }
    this.obj.materialId = this.material.id;
  }
}

/** Which scalar/vector field of a Material an edit command targets. */
export type MaterialFieldKey =
  | 'name' | 'baseColor' | 'metallic' | 'roughness' | 'emissive' | 'emissiveStrength'
  | 'subsurfaceWeight' | 'subsurfaceRadius';

type MaterialFieldValue = string | number | [number, number, number];

/** Edit one field of a library material. Convention: caller already wrote
 * `after` before pushing. Round-trips before/after under undo/redo. */
export class MaterialEditCommand implements Command {
  readonly name = 'Edit Material';

  constructor(
    private readonly material: Material,
    private readonly field: MaterialFieldKey,
    private readonly before: MaterialFieldValue,
    private readonly after: MaterialFieldValue,
  ) {}

  private write(v: MaterialFieldValue): void {
    if (this.field === 'baseColor' || this.field === 'emissive') {
      this.material[this.field] = cloneRgb(v as [number, number, number]);
    } else if (this.field === 'name') {
      this.material.name = v as string;
    } else {
      this.material[this.field] = v as number;
    }
  }

  undo(): void { this.write(this.before); }
  redo(): void { this.write(this.after); }
}

// ------------------------------------------------------------- color helpers --

/** 0..1 RGB floats → lowercase "#rrggbb". */
export function rgbToHex(c: readonly [number, number, number]): string {
  const h = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, '0');
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}

/** "#rrggbb" → 0..1 RGB float triple. */
export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// ----------------------------------------------------------------- the tab UI --

class MaterialTab {
  private readonly empty: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly slotSelect: HTMLSelectElement;
  private readonly fields: HTMLDivElement;

  private nameInput!: HTMLInputElement;
  private baseColorInput!: HTMLInputElement;
  private metallicInput!: HTMLInputElement;
  private metallicNum!: HTMLSpanElement;
  private roughnessInput!: HTMLInputElement;
  private roughnessNum!: HTMLSpanElement;
  private emissiveInput!: HTMLInputElement;
  private emissiveStrengthInput!: HTMLInputElement;
  private subsurfaceInput!: HTMLInputElement;
  private subsurfaceNum!: HTMLSpanElement;
  private subsurfaceRadiusInput!: HTMLInputElement;

  /** Value captured when an input gained focus — the undo `before`. */
  private editBefore: MaterialFieldValue | null = null;

  /** Last rendered signature; null forces a rebuild. */
  private lastSig: string | null = null;

  constructor(
    container: HTMLElement,
    private readonly scene: Scene,
    private readonly undo: UndoStack,
  ) {
    this.empty = document.createElement('div');
    this.empty.className = 'properties-empty';
    this.empty.textContent = 'Select a mesh object';

    this.body = document.createElement('div');
    this.body.className = 'properties-body';

    // Slot row: [ select | New ]
    const slotRow = document.createElement('div');
    slotRow.className = 'material-tab-slot-row';
    this.slotSelect = document.createElement('select');
    this.slotSelect.className = 'material-tab-slot-select';
    this.slotSelect.addEventListener('change', () => this.onSlotChange());
    const newBtn = document.createElement('button');
    newBtn.type = 'button';
    newBtn.className = 'material-tab-new-btn';
    newBtn.textContent = 'New';
    newBtn.title = 'Create and assign a new material';
    newBtn.addEventListener('click', () => this.onNew());
    slotRow.append(this.slotSelect, newBtn);
    this.body.append(slotRow);

    this.fields = document.createElement('div');
    this.fields.className = 'material-tab-fields';
    this.buildFields();
    this.body.append(this.fields);

    container.append(this.empty, this.body);
    this.update();
  }

  private buildFields(): void {
    // Name (text)
    this.nameInput = document.createElement('input');
    this.nameInput.type = 'text';
    this.nameInput.className = 'material-tab-name properties-name-input';
    this.wireField(this.nameInput, 'name',
      () => this.nameInput.value,
      () => this.material()?.name ?? '');
    this.fields.append(this.fieldRow('Name', this.nameInput));

    // Base color
    this.baseColorInput = document.createElement('input');
    this.baseColorInput.type = 'color';
    this.baseColorInput.className = 'material-tab-basecolor';
    this.wireField(this.baseColorInput, 'baseColor',
      () => hexToRgb(this.baseColorInput.value),
      () => this.material()?.baseColor ?? [0, 0, 0]);
    this.fields.append(this.fieldRow('Base Color', this.baseColorInput));

    // Metallic (slider 0..1) + numeric readout
    this.metallicNum = document.createElement('span');
    this.metallicNum.className = 'material-tab-num';
    this.metallicInput = this.slider('material-tab-metallic');
    this.wireField(this.metallicInput, 'metallic',
      () => parseFloat(this.metallicInput.value),
      () => this.material()?.metallic ?? 0,
      () => { this.metallicNum.textContent = Number(this.metallicInput.value).toFixed(2); });
    this.fields.append(this.fieldRow('Metallic', this.metallicInput, this.metallicNum));

    // Roughness (slider 0..1) + numeric readout
    this.roughnessNum = document.createElement('span');
    this.roughnessNum.className = 'material-tab-num';
    this.roughnessInput = this.slider('material-tab-roughness');
    this.wireField(this.roughnessInput, 'roughness',
      () => parseFloat(this.roughnessInput.value),
      () => this.material()?.roughness ?? 0,
      () => { this.roughnessNum.textContent = Number(this.roughnessInput.value).toFixed(2); });
    this.fields.append(this.fieldRow('Roughness', this.roughnessInput, this.roughnessNum));

    // Emissive color
    this.emissiveInput = document.createElement('input');
    this.emissiveInput.type = 'color';
    this.emissiveInput.className = 'material-tab-emissive';
    this.wireField(this.emissiveInput, 'emissive',
      () => hexToRgb(this.emissiveInput.value),
      () => this.material()?.emissive ?? [0, 0, 0]);
    this.fields.append(this.fieldRow('Emissive', this.emissiveInput));

    // Emissive strength (number ≥ 0)
    this.emissiveStrengthInput = document.createElement('input');
    this.emissiveStrengthInput.type = 'number';
    this.emissiveStrengthInput.className = 'material-tab-emissive-strength properties-input';
    this.emissiveStrengthInput.min = '0';
    this.emissiveStrengthInput.step = '0.1';
    this.wireField(this.emissiveStrengthInput, 'emissiveStrength',
      () => Math.max(0, parseFloat(this.emissiveStrengthInput.value)),
      () => this.material()?.emissiveStrength ?? 0);
    this.fields.append(this.fieldRow('Emit Strength', this.emissiveStrengthInput));

    // Subsurface weight (slider 0..1) + numeric readout — the SSS glow amount.
    this.subsurfaceNum = document.createElement('span');
    this.subsurfaceNum.className = 'material-tab-num';
    this.subsurfaceInput = this.slider('material-tab-subsurface');
    this.wireField(this.subsurfaceInput, 'subsurfaceWeight',
      () => parseFloat(this.subsurfaceInput.value),
      () => this.material()?.subsurfaceWeight ?? 0,
      () => { this.subsurfaceNum.textContent = Number(this.subsurfaceInput.value).toFixed(2); });
    this.fields.append(this.fieldRow('Subsurface', this.subsurfaceInput, this.subsurfaceNum));

    // Subsurface radius (number ≥ 0) — mean scatter distance in world units.
    this.subsurfaceRadiusInput = document.createElement('input');
    this.subsurfaceRadiusInput.type = 'number';
    this.subsurfaceRadiusInput.className = 'material-tab-subsurface-radius properties-input';
    this.subsurfaceRadiusInput.min = '0';
    this.subsurfaceRadiusInput.step = '0.01';
    this.wireField(this.subsurfaceRadiusInput, 'subsurfaceRadius',
      () => Math.max(0, parseFloat(this.subsurfaceRadiusInput.value)),
      () => this.material()?.subsurfaceRadius ?? 0.05);
    this.fields.append(this.fieldRow('SSS Radius', this.subsurfaceRadiusInput));
  }

  private slider(cls: string): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'range';
    input.className = cls;
    input.min = '0';
    input.max = '1';
    input.step = '0.01';
    return input;
  }

  private fieldRow(label: string, ...controls: HTMLElement[]): HTMLElement {
    const row = document.createElement('label');
    row.className = 'material-tab-field';
    const span = document.createElement('span');
    span.className = 'material-tab-label properties-group-title';
    span.style.marginBottom = '0';
    span.textContent = label;
    row.append(span, ...controls);
    return row;
  }

  /**
   * Common wiring: capture `before` on focus, live-preview on input (so rendered
   * mode updates while dragging), commit one MaterialEditCommand on change. The
   * optional `onInput` updates any adjacent readout.
   */
  private wireField(
    input: HTMLInputElement,
    field: MaterialFieldKey,
    read: () => MaterialFieldValue,
    current: () => MaterialFieldValue,
    onInput?: () => void,
  ): void {
    input.addEventListener('focus', () => { this.editBefore = this.snapshot(current()); });
    input.addEventListener('input', () => {
      const mat = this.material();
      if (!mat) return;
      if (this.editBefore === null) this.editBefore = this.snapshot(current());
      this.applyLive(mat, field, read());
      onInput?.();
    });
    input.addEventListener('change', () => this.commit(field, read()));
    if (field === 'name') {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        else if (e.key === 'Escape') {
          e.preventDefault();
          const mat = this.material();
          if (mat && this.editBefore !== null) this.applyLive(mat, field, this.editBefore);
          this.editBefore = null;
          this.lastSig = null;
          input.blur();
        }
      });
    }
  }

  private snapshot(v: MaterialFieldValue): MaterialFieldValue {
    return Array.isArray(v) ? cloneRgb(v) : v;
  }

  /** Write a field on the material without touching the undo stack. */
  private applyLive(mat: Material, field: MaterialFieldKey, v: MaterialFieldValue): void {
    if (field === 'baseColor' || field === 'emissive') {
      mat[field] = cloneRgb(v as [number, number, number]);
    } else if (field === 'name') {
      mat.name = v as string;
    } else {
      mat[field] = v as number;
    }
  }

  private valuesEqual(a: MaterialFieldValue, b: MaterialFieldValue): boolean {
    if (Array.isArray(a) && Array.isArray(b)) return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
    return a === b;
  }

  private commit(field: MaterialFieldKey, rawAfter: MaterialFieldValue): void {
    const mat = this.material();
    if (!mat) { this.editBefore = null; return; }

    // Reject bad input (empty name / non-finite number): snap back and bail.
    let after = rawAfter;
    if (field === 'name') {
      const trimmed = (rawAfter as string).trim();
      if (!trimmed) { this.editBefore = null; this.lastSig = null; return; }
      after = trimmed;
    } else if (!Array.isArray(after) && !Number.isFinite(after as number)) {
      this.editBefore = null; this.lastSig = null; return;
    }

    const before = this.editBefore ?? this.snapshot(after);
    this.editBefore = null;

    // Make sure the final value is on the material (live preview may have used a
    // pre-clamp/trim value), then record the command against it.
    this.applyLive(mat, field, after);

    if (this.valuesEqual(before, after)) { this.lastSig = null; return; }
    this.undo.push(new MaterialEditCommand(mat, field, before, after));
    this.lastSig = null; // reflect e.g. a rename in the slot select on next update
  }

  /** The active object's assigned material, or null. */
  private material(): Material | null {
    const obj = this.scene.activeObject;
    if (!obj || obj.kind !== 'mesh' || obj.materialId === null) return null;
    return this.scene.getMaterial(obj.materialId) ?? null;
  }

  private onSlotChange(): void {
    const obj = this.scene.activeObject;
    if (!obj || obj.kind !== 'mesh') return;
    const raw = this.slotSelect.value;
    const after = raw === '' ? null : Number(raw);
    const before = obj.materialId;
    if (before === after) return;
    obj.materialId = after;
    this.undo.push(new AssignMaterialCommand(obj, before, after));
    this.lastSig = null;
  }

  private onNew(): void {
    const obj = this.scene.activeObject;
    if (!obj || obj.kind !== 'mesh') return;
    this.undo.push(NewMaterialCommand.perform(this.scene, obj));
    this.lastSig = null;
  }

  update(): void {
    const obj = this.scene.activeObject;
    const isMesh = !!obj && obj.kind === 'mesh';
    if (!isMesh) {
      this.empty.style.display = '';
      this.body.style.display = 'none';
      this.lastSig = null;
      return;
    }
    this.empty.style.display = 'none';
    this.body.style.display = '';

    // Never yank focus out from under an in-progress edit.
    if (this.isPanelFocused()) return;

    const mat = this.material();
    const sig = [
      obj!.id,
      obj!.materialId,
      this.scene.materials.map((m) => `${m.id}:${m.name}`).join('|'),
      mat ? `${rgbToHex(mat.baseColor)}:${mat.metallic}:${mat.roughness}:${rgbToHex(mat.emissive)}:${mat.emissiveStrength}:${mat.subsurfaceWeight}:${mat.subsurfaceRadius}` : '-',
    ].join('#');
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    this.rebuild(obj!, mat);
  }

  private isPanelFocused(): boolean {
    const active = document.activeElement;
    return (
      (active instanceof HTMLInputElement || active instanceof HTMLSelectElement) &&
      this.body.contains(active)
    );
  }

  private rebuild(obj: SceneObject, mat: Material | null): void {
    // Slot select: "(None)" + one option per library material.
    this.slotSelect.replaceChildren();
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '(None)';
    this.slotSelect.append(none);
    for (const m of this.scene.materials) {
      const opt = document.createElement('option');
      opt.value = String(m.id);
      opt.textContent = m.name;
      this.slotSelect.append(opt);
    }
    this.slotSelect.value = obj.materialId === null ? '' : String(obj.materialId);

    // Fields visible only when a material is assigned.
    this.fields.style.display = mat ? '' : 'none';
    if (!mat) return;

    this.nameInput.value = mat.name;
    this.baseColorInput.value = rgbToHex(mat.baseColor);
    this.metallicInput.value = String(mat.metallic);
    this.metallicNum.textContent = mat.metallic.toFixed(2);
    this.roughnessInput.value = String(mat.roughness);
    this.roughnessNum.textContent = mat.roughness.toFixed(2);
    this.emissiveInput.value = rgbToHex(mat.emissive);
    this.emissiveStrengthInput.value = String(mat.emissiveStrength);
    this.subsurfaceInput.value = String(mat.subsurfaceWeight);
    this.subsurfaceNum.textContent = mat.subsurfaceWeight.toFixed(2);
    this.subsurfaceRadiusInput.value = String(mat.subsurfaceRadius);
  }
}

// Registered at module load so any PropertiesEditor built afterward includes it.
registerPropertiesTab({
  id: 'material',
  icon: '🎨',
  title: 'Material',
  build: (container, ctx) => new MaterialTab(container, ctx.scene, ctx.undo),
});
