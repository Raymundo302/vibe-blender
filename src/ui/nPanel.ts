import type { Scene, SceneObject } from '../core/scene/Scene';
import type { UndoStack } from '../core/undo/UndoStack';
import { Vec3 } from '../core/math/vec3';
import { TransformFields } from './propertiesEditor';

/**
 * The N-panel (P6-2) — Blender's viewport sidebar. Pressing N toggles a slim
 * overlay pinned to the right edge of #viewport-wrap (NOT a workspace area), an
 * "Item" panel showing the active object.
 *
 * Object mode: object name (read-only), editable Location / Rotation / Scale
 * (the SAME TransformFields the properties Object tab uses — one commit path,
 * one undo command, no duplicate logic), and read-only Dimensions = the
 * evaluated mesh's world-space bounding-box size.
 *
 * Edit mode: read-only Median of the selected element verts (object-local) plus
 * a counts line "Verts N · Edges N · Faces N" of the edit mesh.
 *
 * The DOM is created up front but only attached to the parent on first open, so
 * it never appears in the document (and never intercepts viewport pointers)
 * until the user asks for it.
 */
export class NPanel {
  private readonly element: HTMLDivElement;
  private readonly nameEl: HTMLDivElement;
  private readonly objectBody: HTMLDivElement;
  private readonly editBody: HTMLDivElement;
  private readonly emptyEl: HTMLDivElement;
  private readonly transformFields: TransformFields;
  private readonly dimEls: [HTMLSpanElement, HTMLSpanElement, HTMLSpanElement];
  private readonly medianEls: [HTMLSpanElement, HTMLSpanElement, HTMLSpanElement];
  private readonly countsEl: HTMLDivElement;

  private open = false;
  private attached = false;

  constructor(
    private readonly parent: HTMLElement,
    private readonly scene: Scene,
    private readonly undo: UndoStack,
  ) {
    this.element = document.createElement('div');
    this.element.className = 'n-panel';
    this.element.style.display = 'none';

    const heading = document.createElement('div');
    heading.className = 'n-panel-heading';
    heading.textContent = 'Item';
    this.element.appendChild(heading);

    this.emptyEl = document.createElement('div');
    this.emptyEl.className = 'n-panel-empty';
    this.emptyEl.textContent = 'No active object';
    this.element.appendChild(this.emptyEl);

    // Object name — read-only in the N-panel (rename lives in the Object tab).
    this.nameEl = document.createElement('div');
    this.nameEl.className = 'n-panel-name';
    this.element.appendChild(this.nameEl);

    // --- Object-mode body: shared transform fields + read-only dimensions. ---
    this.objectBody = document.createElement('div');
    this.transformFields = new TransformFields(this.scene, this.undo);
    this.objectBody.appendChild(this.transformFields.element);
    const dim = this.makeReadonlyGroup('Dimensions');
    this.dimEls = dim.values;
    this.objectBody.appendChild(dim.group);
    this.element.appendChild(this.objectBody);

    // --- Edit-mode body: read-only median + element counts. ---
    this.editBody = document.createElement('div');
    const med = this.makeReadonlyGroup('Median');
    this.medianEls = med.values;
    this.editBody.appendChild(med.group);
    this.countsEl = document.createElement('div');
    this.countsEl.className = 'n-panel-counts';
    this.editBody.appendChild(this.countsEl);
    this.element.appendChild(this.editBody);
  }

  /** A labelled X/Y/Z row of read-only value spans (Dimensions / Median). */
  private makeReadonlyGroup(title: string): {
    group: HTMLDivElement;
    values: [HTMLSpanElement, HTMLSpanElement, HTMLSpanElement];
  } {
    const group = document.createElement('div');
    group.className = 'properties-group';

    const heading = document.createElement('div');
    heading.className = 'properties-group-title';
    heading.textContent = title;
    group.appendChild(heading);

    const row = document.createElement('div');
    row.className = 'properties-row';

    const values = (['X', 'Y', 'Z'] as const).map((axis) => {
      const field = document.createElement('div');
      field.className = 'properties-field';
      const label = document.createElement('span');
      label.className = 'properties-axis';
      label.textContent = axis;
      const value = document.createElement('span');
      value.className = 'n-panel-value';
      field.append(label, value);
      row.appendChild(field);
      return value;
    }) as [HTMLSpanElement, HTMLSpanElement, HTMLSpanElement];

    group.appendChild(row);
    return { group, values };
  }

  isOpen(): boolean {
    return this.open;
  }

  /** Toggle visibility (N key). Attaches to the parent on first open. */
  toggle(): void {
    this.open = !this.open;
    if (this.open) {
      if (!this.attached) {
        this.parent.appendChild(this.element);
        this.attached = true;
      }
      this.element.style.display = '';
      this.update();
    } else {
      this.element.style.display = 'none';
    }
  }

  /** Re-render the panel from the current scene state. Cheap no-op while closed. */
  update(): void {
    if (!this.open) return;
    const obj = this.scene.activeObject;

    if (!obj) {
      this.emptyEl.style.display = '';
      this.nameEl.style.display = 'none';
      this.objectBody.style.display = 'none';
      this.editBody.style.display = 'none';
      return;
    }

    this.emptyEl.style.display = 'none';
    this.nameEl.style.display = '';
    if (this.nameEl.textContent !== obj.name) this.nameEl.textContent = obj.name;

    const editing = this.scene.editMode !== null && this.scene.editObject === obj;
    if (editing) {
      this.objectBody.style.display = 'none';
      this.editBody.style.display = '';
      this.updateEdit(obj);
    } else {
      this.editBody.style.display = 'none';
      this.objectBody.style.display = '';
      this.transformFields.update();
      this.writeVec(this.dimEls, worldDimensions(obj));
    }
  }

  private updateEdit(obj: SceneObject): void {
    const sel = this.scene.editMode!;
    const mesh = obj.mesh;
    const vertIds = sel.selectedVertIds(mesh);
    this.writeVec(this.medianEls, median(mesh, vertIds));

    const counts = `Verts ${mesh.verts.size} · Edges ${mesh.edges().size} · Faces ${mesh.faces.size}`;
    if (this.countsEl.textContent !== counts) this.countsEl.textContent = counts;
  }

  private writeVec(
    els: [HTMLSpanElement, HTMLSpanElement, HTMLSpanElement],
    v: Vec3,
  ): void {
    const parts = [v.x, v.y, v.z];
    for (let i = 0; i < 3; i++) {
      const s = parts[i].toFixed(3);
      if (els[i].textContent !== s) els[i].textContent = s;
    }
  }
}

/** World-space bounding-box size of an object's evaluated (modified) mesh. */
function worldDimensions(obj: SceneObject): Vec3 {
  const mesh = obj.evaluatedMesh();
  const mat = obj.transform.matrix();
  let min: Vec3 | null = null;
  let max: Vec3 | null = null;
  for (const vert of mesh.verts.values()) {
    const p = mat.transformPoint(vert.co);
    if (!min || !max) { min = p; max = p; continue; }
    min = new Vec3(Math.min(min.x, p.x), Math.min(min.y, p.y), Math.min(min.z, p.z));
    max = new Vec3(Math.max(max.x, p.x), Math.max(max.y, p.y), Math.max(max.z, p.z));
  }
  if (!min || !max) return new Vec3();
  return max.sub(min);
}

/** Average (Blender "median") of the given verts' local coords; ZERO if empty. */
function median(mesh: { verts: Map<number, { co: Vec3 }> }, ids: Set<number>): Vec3 {
  let sum = new Vec3();
  let n = 0;
  for (const id of ids) {
    const v = mesh.verts.get(id);
    if (v) { sum = sum.add(v.co); n++; }
  }
  return n === 0 ? new Vec3() : sum.scale(1 / n);
}
