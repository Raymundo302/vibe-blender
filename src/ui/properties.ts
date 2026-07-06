import type { Panel } from './shell';
import type { Scene, SceneObject } from '../core/scene/Scene';
import type { UndoStack } from '../core/undo/UndoStack';
import { Vec3 } from '../core/math/vec3';
import { Quat } from '../core/math/quat';
import { TransformCommand } from '../core/undo/commands';

const STYLE_ID = 'properties-style';

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

/**
 * Object properties: live, editable Location / Rotation / Scale for the active
 * object. Like the Outliner, this owns its DOM and a single injected <style>.
 *
 * The input DOM is built once and persists; update() only rewrites the numeric
 * *values* each frame (never rebuilding structure), and skips the rewrite while
 * any field in the panel is focused so it never fights the user's caret. Values
 * are only assigned when the formatted string actually changed, to avoid caret
 * churn in the rare case a non-focused field is being read by assistive tools.
 *
 * Rotation is shown as intrinsic XYZ Euler degrees (Blender's default), derived
 * from the object's quaternion via Quat.toEulerXYZ and rebuilt on edit via
 * Quat.fromEulerXYZ.
 */
function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.properties-body {
  font: 12px/1.4 "Segoe UI", system-ui, sans-serif;
  color: #c8c8c8; user-select: none; padding: 2px 8px 8px;
}
.properties-name {
  color: #fff; font-weight: 600; padding: 2px 0 6px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.properties-group { margin-bottom: 8px; }
.properties-group-title { color: #9aa7b4; margin-bottom: 3px; }
.properties-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; }
.properties-field { display: flex; align-items: center; gap: 3px; min-width: 0; }
.properties-axis { flex: none; color: #9aa7b4; width: 10px; }
.properties-input {
  flex: 1; min-width: 0; font: inherit; color: #eee;
  background: #222; border: 1px solid #3a3a3a; border-radius: 2px;
  padding: 1px 3px; outline: none;
}
.properties-input:focus { border-color: #6a8; }
.properties-empty { padding: 6px 0; color: #777; font-style: italic; }
`;
  document.head.appendChild(style);
}

/** One X/Y/Z triple of number inputs, plus the group heading. */
interface FieldGroup {
  readonly inputs: [HTMLInputElement, HTMLInputElement, HTMLInputElement];
}

export class PropertiesPanel implements Panel {
  readonly id = 'properties';
  readonly title = 'Object';
  readonly element: HTMLDivElement;

  private readonly body: HTMLDivElement;
  private readonly empty: HTMLDivElement;
  private readonly nameEl: HTMLDivElement;
  private readonly location: FieldGroup;
  private readonly rotation: FieldGroup;
  private readonly scale: FieldGroup;

  /** Active object id shown last frame; -1 sentinel means "nothing shown". */
  private lastActiveId: number | null = -1 as unknown as number;

  constructor(
    private readonly scene: Scene,
    private readonly undo: UndoStack,
  ) {
    ensureStyle();
    this.element = document.createElement('div');

    this.empty = document.createElement('div');
    this.empty.className = 'properties-empty';
    this.empty.textContent = 'No active object';

    this.body = document.createElement('div');
    this.body.className = 'properties-body';

    this.nameEl = document.createElement('div');
    this.nameEl.className = 'properties-name';
    this.body.appendChild(this.nameEl);

    this.location = this.makeGroup('Location', 0.1, 'location');
    this.rotation = this.makeGroup('Rotation', 1, 'rotation');
    this.scale = this.makeGroup('Scale', 0.1, 'scale');

    this.element.append(this.empty, this.body);
    this.update();
  }

  private makeGroup(
    title: string,
    step: number,
    kind: 'location' | 'rotation' | 'scale',
  ): FieldGroup {
    const group = document.createElement('div');
    group.className = 'properties-group';

    const heading = document.createElement('div');
    heading.className = 'properties-group-title';
    heading.textContent = title;
    group.appendChild(heading);

    const row = document.createElement('div');
    row.className = 'properties-row';

    const inputs = (['X', 'Y', 'Z'] as const).map((axis) => {
      const field = document.createElement('div');
      field.className = 'properties-field';

      const label = document.createElement('span');
      label.className = 'properties-axis';
      label.textContent = axis;

      const input = document.createElement('input');
      input.className = 'properties-input';
      input.type = 'number';
      input.step = String(step);
      input.addEventListener('change', () => this.commit(kind));

      field.append(label, input);
      row.appendChild(field);
      return input;
    }) as [HTMLInputElement, HTMLInputElement, HTMLInputElement];

    group.appendChild(row);
    this.body.appendChild(group);
    return { inputs };
  }

  update(): void {
    const obj = this.scene.activeObject;
    if (!obj) {
      this.empty.style.display = '';
      this.body.style.display = 'none';
      this.lastActiveId = null;
      return;
    }

    this.empty.style.display = 'none';
    this.body.style.display = '';

    const switched = obj.id !== this.lastActiveId;
    this.lastActiveId = obj.id;

    // Skip value rewrites while the user is editing a field (unless we just
    // switched objects, in which case the fields must repopulate immediately —
    // switching also blurs any prior input).
    if (!switched && this.isPanelFocused()) return;

    this.nameEl.textContent = obj.name;
    this.writeGroup(this.location, obj.transform.position, 3);

    const e = obj.transform.rotation.toEulerXYZ();
    this.writeInput(this.rotation.inputs[0], e.x * DEG, 1);
    this.writeInput(this.rotation.inputs[1], e.y * DEG, 1);
    this.writeInput(this.rotation.inputs[2], e.z * DEG, 1);

    this.writeGroup(this.scale, obj.transform.scale, 3);
  }

  private isPanelFocused(): boolean {
    const active = document.activeElement;
    return active instanceof HTMLInputElement && this.body.contains(active);
  }

  private writeGroup(group: FieldGroup, v: Vec3, decimals: number): void {
    this.writeInput(group.inputs[0], v.x, decimals);
    this.writeInput(group.inputs[1], v.y, decimals);
    this.writeInput(group.inputs[2], v.z, decimals);
  }

  /** Assign only when the formatted string changed (avoids caret churn). */
  private writeInput(input: HTMLInputElement, value: number, decimals: number): void {
    const s = value.toFixed(decimals);
    if (input.value !== s) input.value = s;
  }

  /** Read a group's three inputs; returns null if any value is not finite. */
  private readGroup(group: FieldGroup): Vec3 | null {
    const x = parseFloat(group.inputs[0].value);
    const y = parseFloat(group.inputs[1].value);
    const z = parseFloat(group.inputs[2].value);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    return new Vec3(x, y, z);
  }

  private commit(kind: 'location' | 'rotation' | 'scale'): void {
    const obj = this.scene.activeObject;
    if (!obj) return;
    const before = obj.transform;

    let after;
    if (kind === 'location') {
      const p = this.readGroup(this.location);
      if (!p) return this.restore(obj);
      after = before.withPosition(p);
    } else if (kind === 'scale') {
      const s = this.readGroup(this.scale);
      if (!s) return this.restore(obj);
      after = before.withScale(s);
    } else {
      const deg = this.readGroup(this.rotation);
      if (!deg) return this.restore(obj);
      after = before.withRotation(Quat.fromEulerXYZ(deg.x * RAD, deg.y * RAD, deg.z * RAD));
    }

    // Undo convention: apply the final state first, then push the command.
    obj.transform = after;
    this.undo.push(new TransformCommand('Set Transform', [{ object: obj, before, after }]));
  }

  /** Discard bad input by re-displaying the object's current values. */
  private restore(obj: SceneObject): void {
    // Force the next refresh to run even though a field just blurred/changed.
    void obj;
    this.lastActiveId = -1 as unknown as number;
    this.update();
  }
}
