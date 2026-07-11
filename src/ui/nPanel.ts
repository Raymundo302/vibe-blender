import type { Scene, SceneObject } from '../core/scene/Scene';
import type { UndoStack } from '../core/undo/UndoStack';
import type { OrbitCamera } from '../camera/OrbitCamera';
import type { Renderer } from '../render/Renderer';
import { Vec3 } from '../core/math/vec3';
import { TransformFields } from './propertiesEditor';
import { TransformCommand } from '../core/undo/commands';
import { CameraCommand } from './cameraTab';
import { focalLengthToFovY, fovYToFocalLength } from '../core/scene/objectData';
import { viewPrefs, loadViewPrefs, saveViewPrefs } from '../render/viewPrefs';

/**
 * The N-panel (P6-2, tabs UR5-6) — Blender's viewport sidebar. Pressing N toggles
 * a slim overlay pinned to the right edge of #viewport-wrap (NOT a workspace
 * area) with Blender-style vertical tabs on its right edge:
 *
 *  - **Item** — the active object (unchanged from P6-2):
 *    Object mode: object name (read-only), editable Location / Rotation / Scale
 *    (the SAME TransformFields the properties Object tab uses — one commit path,
 *    one undo command), and read-only Dimensions = evaluated-mesh world bbox.
 *    Edit mode: read-only Median of selected verts + a "Verts·Edges·Faces" line.
 *
 *  - **View** — viewport + through-camera view options (UR5-6):
 *    Focal Length (mm) editing the ORBIT camera's fovY (viewport lens, live, no
 *    undo — viewport state, matches Blender); a Passepartout checkbox backed by
 *    `viewPrefs`; and, only while looking through a camera, that camera's Focal
 *    Length (mm, undoable via the Camera tab's CameraCommand) + Location X/Y/Z.
 *
 * The DOM is created up front but only attached to the parent on first open, so
 * it never appears in the document (and never intercepts viewport pointers)
 * until the user asks for it.
 */
export class NPanel {
  private readonly element: HTMLDivElement;
  private readonly heading: HTMLDivElement;
  private readonly itemBtn: HTMLButtonElement;
  private readonly viewBtn: HTMLButtonElement;

  // --- Item tab -----------------------------------------------------------
  private readonly itemContent: HTMLDivElement;
  private readonly nameEl: HTMLDivElement;
  private readonly objectBody: HTMLDivElement;
  private readonly editBody: HTMLDivElement;
  private readonly emptyEl: HTMLDivElement;
  private readonly transformFields: TransformFields;
  private readonly dimEls: [HTMLSpanElement, HTMLSpanElement, HTMLSpanElement];
  private readonly medianEls: [HTMLSpanElement, HTMLSpanElement, HTMLSpanElement];
  private readonly countsEl: HTMLDivElement;

  // --- View tab -----------------------------------------------------------
  private readonly viewBody: HTMLDivElement;
  private readonly lensInput: HTMLInputElement;
  private readonly ppInput: HTMLInputElement;
  private readonly camSection: HTMLDivElement;
  private readonly camFocalInput: HTMLInputElement;
  private readonly camLocInputs: [HTMLInputElement, HTMLInputElement, HTMLInputElement];

  private activeTab: 'item' | 'view' = 'item';
  private open = false;
  private attached = false;

  constructor(
    private readonly parent: HTMLElement,
    private readonly scene: Scene,
    private readonly undo: UndoStack,
    private readonly camera: OrbitCamera,
    private readonly renderer: Renderer,
  ) {
    // View is a persisted APP preference (like shadePrefs): restore it before
    // the first frame so the passepartout gate + checkbox reflect storage.
    loadViewPrefs();

    this.element = document.createElement('div');
    this.element.className = 'n-panel';
    this.element.style.display = 'none';

    // Content column (left) + vertical tab strip (right, Blender's outer edge).
    const content = document.createElement('div');
    content.className = 'n-panel-content';

    this.heading = document.createElement('div');
    this.heading.className = 'n-panel-heading';
    this.heading.textContent = 'Item';
    content.appendChild(this.heading);

    // ---- Item content (unchanged from P6-2, wrapped so the tab can hide it) ----
    this.itemContent = document.createElement('div');
    this.itemContent.className = 'n-panel-item';

    this.emptyEl = document.createElement('div');
    this.emptyEl.className = 'n-panel-empty';
    this.emptyEl.textContent = 'No active object';
    this.itemContent.appendChild(this.emptyEl);

    // Object name — read-only in the N-panel (rename lives in the Object tab).
    this.nameEl = document.createElement('div');
    this.nameEl.className = 'n-panel-name';
    this.itemContent.appendChild(this.nameEl);

    // Object-mode body: shared transform fields + read-only dimensions.
    this.objectBody = document.createElement('div');
    this.transformFields = new TransformFields(this.scene, this.undo);
    this.objectBody.appendChild(this.transformFields.element);
    const dim = this.makeReadonlyGroup('Dimensions');
    this.dimEls = dim.values;
    this.objectBody.appendChild(dim.group);
    this.itemContent.appendChild(this.objectBody);

    // Edit-mode body: read-only median + element counts.
    this.editBody = document.createElement('div');
    const med = this.makeReadonlyGroup('Median');
    this.medianEls = med.values;
    this.editBody.appendChild(med.group);
    this.countsEl = document.createElement('div');
    this.countsEl.className = 'n-panel-counts';
    this.editBody.appendChild(this.countsEl);
    this.itemContent.appendChild(this.editBody);

    content.appendChild(this.itemContent);

    // ---- View content (UR5-6) ----
    this.viewBody = document.createElement('div');
    this.viewBody.className = 'n-panel-view';
    this.viewBody.style.display = 'none';

    // Viewport lens (edits the orbit camera's fovY — live, no undo).
    this.lensInput = this.numberInput('view-focal', 1, 300, 1);
    this.lensInput.addEventListener('change', () => {
      const raw = parseFloat(this.lensInput.value);
      if (!Number.isFinite(raw)) return this.updateView();
      const mm = Math.max(1, Math.min(300, raw));
      this.camera.fovY = focalLengthToFovY(mm); // viewport state → no undo entry
      this.updateView();
    });
    this.viewBody.appendChild(this.labelledRow('Focal Length', this.lensInput));

    // Passepartout — backed by viewPrefs (persisted, not undoable).
    this.ppInput = document.createElement('input');
    this.ppInput.type = 'checkbox';
    this.ppInput.className = 'n-panel-check';
    this.ppInput.dataset.action = 'passepartout';
    this.ppInput.addEventListener('change', () => {
      viewPrefs.passepartout = this.ppInput.checked;
      saveViewPrefs();
    });
    const ppRow = document.createElement('label');
    ppRow.className = 'n-panel-check-row';
    const ppLabel = document.createElement('span');
    ppLabel.textContent = 'Passepartout';
    ppRow.append(this.ppInput, ppLabel);
    this.viewBody.appendChild(ppRow);

    // In-camera-view section: the through-camera's own focal length + location.
    this.camSection = document.createElement('div');
    this.camSection.className = 'n-panel-cam-section';

    const camHeading = document.createElement('div');
    camHeading.className = 'properties-group-title';
    camHeading.textContent = 'Camera';
    this.camSection.appendChild(camHeading);

    this.camFocalInput = this.numberInput('cam-focal', 1, 300, 1);
    this.camFocalInput.addEventListener('change', () => {
      const obj = this.cameraViewObject();
      const raw = parseFloat(this.camFocalInput.value);
      if (!obj || !Number.isFinite(raw)) return this.updateView();
      const focal = Math.max(1, Math.min(300, raw));
      // SAME undo command the Camera tab uses — one shared commit path.
      this.undo.push(CameraCommand.capture('Set Focal Length', obj, (c) => { c.focalLength = focal; }));
      this.updateView();
    });
    this.camSection.appendChild(this.labelledRow('Focal Length', this.camFocalInput));

    // Location X/Y/Z of the through-camera object, committed via the SAME
    // TransformCommand the Item transform fields use (bound to the camera object
    // rather than the active object — TransformFields is hardcoded to
    // scene.activeObject, so an inline group reusing its undo command is the fit).
    const loc = this.makeLocationGroup();
    this.camLocInputs = loc.inputs;
    this.camSection.appendChild(loc.group);

    this.viewBody.appendChild(this.camSection);
    content.appendChild(this.viewBody);

    // ---- Vertical tab strip on the right edge (Blender) ----
    const tabs = document.createElement('div');
    tabs.className = 'n-panel-tabs';
    this.itemBtn = this.makeTabButton('Item', 'item');
    this.viewBtn = this.makeTabButton('View', 'view');
    tabs.append(this.itemBtn, this.viewBtn);

    this.element.append(content, tabs);
  }

  private makeTabButton(label: string, tab: 'item' | 'view'): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'n-panel-tab';
    btn.dataset.tab = tab;
    btn.textContent = label;
    btn.addEventListener('click', () => this.selectTab(tab));
    return btn;
  }

  private selectTab(tab: 'item' | 'view'): void {
    if (this.activeTab === tab) return;
    this.activeTab = tab;
    this.update();
  }

  private numberInput(field: string, min: number, max: number, step: number): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'properties-input n-panel-num';
    input.dataset.field = field;
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    return input;
  }

  private labelledRow(text: string, control: HTMLElement): HTMLElement {
    const row = document.createElement('label');
    row.className = 'n-panel-field-row';
    const label = document.createElement('span');
    label.className = 'n-panel-field-label';
    label.textContent = text;
    row.append(label, control);
    return row;
  }

  /** An X/Y/Z triple of number inputs committing via TransformCommand on the
   *  through-camera object (mirrors TransformFields' Location semantics). */
  private makeLocationGroup(): {
    group: HTMLDivElement;
    inputs: [HTMLInputElement, HTMLInputElement, HTMLInputElement];
  } {
    const group = document.createElement('div');
    group.className = 'properties-group';

    const heading = document.createElement('div');
    heading.className = 'properties-group-title';
    heading.textContent = 'Location';
    group.appendChild(heading);

    const row = document.createElement('div');
    row.className = 'properties-row';

    const inputs = (['X', 'Y', 'Z'] as const).map((axis, i) => {
      const field = document.createElement('div');
      field.className = 'properties-field';
      const label = document.createElement('span');
      label.className = 'properties-axis';
      label.textContent = axis;
      const input = document.createElement('input');
      input.className = 'properties-input';
      input.type = 'number';
      input.step = '0.1';
      input.dataset.field = `cam-loc-${axis.toLowerCase()}`;
      input.addEventListener('change', () => this.commitCamLocation(i));
      field.append(label, input);
      row.appendChild(field);
      return input;
    }) as [HTMLInputElement, HTMLInputElement, HTMLInputElement];

    group.appendChild(row);
    return { group, inputs };
  }

  private commitCamLocation(_changed: number): void {
    const obj = this.cameraViewObject();
    if (!obj) return;
    const x = parseFloat(this.camLocInputs[0].value);
    const y = parseFloat(this.camLocInputs[1].value);
    const z = parseFloat(this.camLocInputs[2].value);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return this.updateView();
    const before = obj.transform;
    const after = before.withPosition(new Vec3(x, y, z));
    obj.transform = after;
    this.undo.push(new TransformCommand('Set Transform', [{ object: obj, before, after }]));
    this.updateView();
  }

  /** The object the viewport is looking through, iff it is still a camera. */
  private cameraViewObject(): SceneObject | null {
    const id = this.renderer.cameraViewId;
    if (id === null) return null;
    const obj = this.scene.get(id);
    return obj && obj.kind === 'camera' && obj.camera ? obj : null;
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
    this.itemBtn.classList.toggle('n-panel-tab-active', this.activeTab === 'item');
    this.viewBtn.classList.toggle('n-panel-tab-active', this.activeTab === 'view');
    this.heading.textContent = this.activeTab === 'item' ? 'Item' : 'View';

    if (this.activeTab === 'view') {
      this.itemContent.style.display = 'none';
      this.viewBody.style.display = '';
      this.updateView();
    } else {
      this.viewBody.style.display = 'none';
      this.itemContent.style.display = '';
      this.updateItem();
    }
  }

  private updateItem(): void {
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
      this.writeVec(this.dimEls, worldDimensions(this.scene, obj));
    }
  }

  private updateView(): void {
    // Viewport lens ← orbit camera fovY (skip rewrites while the user edits it).
    if (document.activeElement !== this.lensInput) {
      const mm = round(fovYToFocalLength(this.camera.fovY), 1);
      const s = String(mm);
      if (this.lensInput.value !== s) this.lensInput.value = s;
    }
    if (this.ppInput.checked !== viewPrefs.passepartout) this.ppInput.checked = viewPrefs.passepartout;

    // Camera section only while looking through a camera.
    const obj = this.cameraViewObject();
    if (!obj || !obj.camera) {
      this.camSection.style.display = 'none';
      return;
    }
    this.camSection.style.display = '';
    const focused = document.activeElement instanceof HTMLInputElement
      && this.camSection.contains(document.activeElement);
    if (focused) return; // don't clobber a field mid-edit
    const focal = String(round(obj.camera.focalLength, 3));
    if (this.camFocalInput.value !== focal) this.camFocalInput.value = focal;
    const p = obj.transform.position;
    this.writeInput(this.camLocInputs[0], p.x);
    this.writeInput(this.camLocInputs[1], p.y);
    this.writeInput(this.camLocInputs[2], p.z);
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

  private writeInput(input: HTMLInputElement, value: number): void {
    const s = value.toFixed(3);
    if (input.value !== s) input.value = s;
  }
}

/** Round to `decimals` places, trimming float noise for display. */
function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

/** World-space bounding-box size of an object's evaluated (modified) mesh. */
function worldDimensions(scene: Scene, obj: SceneObject): Vec3 {
  const mesh = obj.evaluatedMesh();
  const mat = scene.worldMatrix(obj);
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
