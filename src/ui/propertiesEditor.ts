import type { Scene } from '../core/scene/Scene';
import type { UndoStack } from '../core/undo/UndoStack';
import { Vec3 } from '../core/math/vec3';
import { Quat } from '../core/math/quat';
import { TransformCommand } from '../core/undo/commands';
import { RenameObjectCommand } from '../core/undo/objectCommands';

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

/**
 * Properties editor (Phase 4) — Blender's tabbed properties panel. A slim
 * VERTICAL strip of icon buttons on the left edge switches which tab's content
 * shows on the right. Tabs register themselves at module load via
 * registerPropertiesTab, mirroring the modifier-registration pattern, so new
 * tabs (Modifier in P4-4) plug in without touching this shell.
 *
 * Ships with one tab — Object — carrying the transform / rename / visibility UI
 * that used to live in properties.ts.
 *
 * Every editor instance owns its own DOM and its own tab instances: two areas
 * can both show Properties at once, so there is NO module-level DOM state (the
 * registry holds only tab *descriptors*, never live elements).
 */

/** Context handed to every tab's build(): the shared scene + undo stack. */
export interface PropertiesTabContext {
  scene: Scene;
  undo: UndoStack;
}

/** A registered properties tab. build() constructs its content into `container`. */
export interface PropertiesTab {
  id: string;
  /** Text/emoji glyph for the strip button (e.g. '⬛'). */
  icon: string;
  /** Tooltip + accessible label (e.g. 'Object'). */
  title: string;
  build(container: HTMLElement, ctx: PropertiesTabContext): { update(): void };
}

const registry: PropertiesTab[] = [];

/** Register a tab type. Ignores duplicate ids (same pattern as modifiers). */
export function registerPropertiesTab(tab: PropertiesTab): void {
  if (!registry.some((t) => t.id === tab.id)) registry.push(tab);
}

/** All registered tabs, in registration order. */
export function propertiesTabs(): readonly PropertiesTab[] {
  return registry;
}

/**
 * The tabbed shell. Renders one strip button per registered tab and one content
 * pane per tab (built eagerly, shown/hidden by the active-tab field). Only the
 * active tab is update()d each frame. The active tab is a plain per-instance
 * field — no localStorage — so it persists for the session, per Blender.
 */
export class PropertiesEditor {
  readonly element: HTMLDivElement;

  private readonly strip: HTMLDivElement;
  private readonly content: HTMLDivElement;
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private readonly panes = new Map<string, { pane: HTMLElement; tab: { update(): void } }>();
  private activeTab = '';

  constructor(ctx: PropertiesTabContext) {
    this.element = document.createElement('div');
    this.element.className = 'properties-editor';

    this.strip = document.createElement('div');
    this.strip.className = 'properties-tabstrip';

    this.content = document.createElement('div');
    this.content.className = 'properties-content';

    for (const tab of registry) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'properties-tab-btn';
      btn.dataset.tab = tab.id;
      btn.title = tab.title;
      btn.textContent = tab.icon;
      btn.addEventListener('click', () => this.select(tab.id));
      this.strip.append(btn);
      this.buttons.set(tab.id, btn);

      const pane = document.createElement('div');
      pane.className = 'properties-pane';
      pane.dataset.tab = tab.id;
      const instance = tab.build(pane, ctx);
      this.content.append(pane);
      this.panes.set(tab.id, { pane, tab: instance });
    }

    this.element.append(this.strip, this.content);

    if (registry.length > 0) this.select(registry[0].id);
  }

  /** Switch the visible tab (no-op if already active or unknown). */
  select(id: string): void {
    if (!this.panes.has(id) || id === this.activeTab) return;
    this.activeTab = id;
    for (const [tabId, { pane }] of this.panes) {
      pane.style.display = tabId === id ? '' : 'none';
    }
    for (const [tabId, btn] of this.buttons) {
      btn.classList.toggle('properties-tab-active', tabId === id);
    }
  }

  update(): void {
    this.panes.get(this.activeTab)?.tab.update();
  }
}

// --------------------------------------------------------------- Object tab --

/** One X/Y/Z triple of number inputs. */
interface FieldGroup {
  readonly inputs: [HTMLInputElement, HTMLInputElement, HTMLInputElement];
}

/**
 * The editable Location / Rotation / Scale block of the Object tab, extracted so
 * the viewport N-panel (P6-2) can reuse the exact same undo semantics (one
 * TransformCommand per commit, euler↔quat rotation, skip-rewrites-while-editing)
 * instead of duplicating them. Owns a self-contained `element` holding the three
 * groups; always reads/writes `scene.activeObject`. update() must be called each
 * frame by the host (the Object tab guards it behind its own focus check; the
 * N-panel calls it directly — hence the internal skip-while-focused).
 */
export class TransformFields {
  readonly element: HTMLDivElement;
  private readonly location: FieldGroup;
  private readonly rotation: FieldGroup;
  private readonly scale: FieldGroup;
  /** Object id shown last frame; -1 sentinel means "force a rewrite". */
  private lastActiveId: number | null = -1 as unknown as number;

  constructor(
    private readonly scene: Scene,
    private readonly undo: UndoStack,
  ) {
    this.element = document.createElement('div');
    this.element.className = 'transform-fields';
    this.location = this.makeGroup('Location', 0.1, 'location');
    this.rotation = this.makeGroup('Rotation', 1, 'rotation');
    this.scale = this.makeGroup('Scale', 0.1, 'scale');
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
    this.element.appendChild(group);
    return { inputs };
  }

  /** Refresh the fields from the active object (no-op while the user is editing). */
  update(): void {
    const obj = this.scene.activeObject;
    if (!obj) { this.lastActiveId = null; return; }
    const switched = obj.id !== this.lastActiveId;
    this.lastActiveId = obj.id;
    if (!switched && this.isFocused()) return;

    this.writeGroup(this.location, obj.transform.position, 3);
    const e = obj.transform.rotation.toEulerXYZ();
    this.writeInput(this.rotation.inputs[0], e.x * DEG, 1);
    this.writeInput(this.rotation.inputs[1], e.y * DEG, 1);
    this.writeInput(this.rotation.inputs[2], e.z * DEG, 1);
    this.writeGroup(this.scale, obj.transform.scale, 3);
  }

  private isFocused(): boolean {
    const active = document.activeElement;
    return active instanceof HTMLInputElement && this.element.contains(active);
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
      if (!p) return this.restore();
      after = before.withPosition(p);
    } else if (kind === 'scale') {
      const s = this.readGroup(this.scale);
      if (!s) return this.restore();
      after = before.withScale(s);
    } else {
      const deg = this.readGroup(this.rotation);
      if (!deg) return this.restore();
      after = before.withRotation(Quat.fromEulerXYZ(deg.x * RAD, deg.y * RAD, deg.z * RAD));
    }

    // Undo convention: apply the final state first, then push the command.
    obj.transform = after;
    this.undo.push(new TransformCommand('Set Transform', [{ object: obj, before, after }]));
  }

  /** Discard bad input by forcing the next refresh to re-display current values. */
  private restore(): void {
    this.lastActiveId = -1 as unknown as number;
    this.update();
  }
}

/**
 * Object tab: name (rename → RenameObjectCommand), visibility checkbox, and the
 * live-editable Location / Rotation / Scale transform fields. Behavior is a
 * straight move of the old PropertiesPanel — same undo semantics, same
 * skip-while-focused refresh discipline — but scoped to one instance so multiple
 * Properties editors coexist without fighting over shared DOM.
 */
class ObjectTab {
  private readonly body: HTMLDivElement;
  private readonly empty: HTMLDivElement;
  private readonly nameInput: HTMLInputElement;
  private readonly visibleInput: HTMLInputElement;
  private smoothInput!: HTMLInputElement;
  private readonly transformFields: TransformFields;

  /** Active object id shown last frame; -1 sentinel means "nothing shown". */
  private lastActiveId: number | null = -1 as unknown as number;
  /** Object name at the moment the name input last (re)populated. */
  private nameBefore = '';

  constructor(
    container: HTMLElement,
    private readonly scene: Scene,
    private readonly undo: UndoStack,
  ) {
    this.empty = document.createElement('div');
    this.empty.className = 'properties-empty';
    this.empty.textContent = 'No active object';

    this.body = document.createElement('div');
    this.body.className = 'properties-body';

    // Name (editable). Commit on change/blur; Enter commits + blurs, Escape reverts.
    const nameRow = document.createElement('div');
    nameRow.className = 'properties-name-row';
    this.nameInput = document.createElement('input');
    this.nameInput.className = 'properties-name-input';
    this.nameInput.type = 'text';
    this.nameInput.addEventListener('change', () => this.commitName());
    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.nameInput.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); this.nameInput.value = this.nameBefore; this.nameInput.blur(); }
    });
    nameRow.append(this.nameInput);
    this.body.append(nameRow);

    // Visibility toggle. Like the outliner eye, this carries no undo (in scope).
    const visRow = document.createElement('label');
    visRow.className = 'properties-visible-row';
    this.visibleInput = document.createElement('input');
    this.visibleInput.type = 'checkbox';
    this.visibleInput.className = 'properties-visible';
    this.visibleInput.addEventListener('change', () => {
      const obj = this.scene.activeObject;
      if (obj) obj.visible = this.visibleInput.checked;
    });
    const visLabel = document.createElement('span');
    visLabel.textContent = 'Visible';
    visRow.append(this.visibleInput, visLabel);
    this.body.append(visRow);

    // Shade Smooth toggle (like visibility: view state, no undo).
    const smoothRow = document.createElement('label');
    smoothRow.className = 'properties-visible-row';
    this.smoothInput = document.createElement('input');
    this.smoothInput.type = 'checkbox';
    this.smoothInput.dataset.action = 'shade-smooth';
    this.smoothInput.addEventListener('change', () => {
      const obj = this.scene.activeObject;
      if (obj) obj.shadeSmooth = this.smoothInput.checked;
    });
    const smoothLabel = document.createElement('span');
    smoothLabel.textContent = 'Shade Smooth';
    smoothRow.append(this.smoothInput, smoothLabel);
    this.body.append(smoothRow);

    // Editable Location / Rotation / Scale — shared with the viewport N-panel.
    this.transformFields = new TransformFields(this.scene, this.undo);
    this.body.appendChild(this.transformFields.element);

    container.append(this.empty, this.body);
    this.update();
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

    if (this.nameInput.value !== obj.name) this.nameInput.value = obj.name;
    this.nameBefore = obj.name;
    if (this.visibleInput.checked !== obj.visible) this.visibleInput.checked = obj.visible;
    if (this.smoothInput.checked !== obj.shadeSmooth) this.smoothInput.checked = obj.shadeSmooth;

    this.transformFields.update();
  }

  private isPanelFocused(): boolean {
    const active = document.activeElement;
    return active instanceof HTMLInputElement && this.body.contains(active);
  }

  /** Commit a rename via the same RenameObjectCommand the outliner uses. */
  private commitName(): void {
    const obj = this.scene.activeObject;
    if (!obj) return;
    const before = this.nameBefore;
    const after = this.nameInput.value.trim();
    if (!after || after === before) {
      // Empty or unchanged: snap the field back to the real name.
      this.nameInput.value = obj.name;
      return;
    }
    obj.name = after;
    this.nameBefore = after;
    this.undo.push(new RenameObjectCommand(obj, before, after));
  }
}

// The one built-in tab. Registered at module load so any PropertiesEditor built
// afterward picks it up. Its icon is a filled square, tooltip 'Object'.
registerPropertiesTab({
  id: 'object',
  icon: '⬛',
  title: 'Object',
  build: (container, ctx) => new ObjectTab(container, ctx.scene, ctx.undo),
});
