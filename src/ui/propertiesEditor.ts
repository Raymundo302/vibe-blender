import type { Scene, SceneObject } from '../core/scene/Scene';
import type { UndoStack } from '../core/undo/UndoStack';
import { Vec3 } from '../core/math/vec3';
import { Quat } from '../core/math/quat';
import { TransformCommand } from '../core/undo/commands';
import { RenameObjectCommand } from '../core/undo/objectCommands';
import { InsertKeysCommand } from '../core/anim/animCommands';
import { setHtmlPageExtent } from '../tools/htmlPlane';
import { requestHtmlReraster } from '../tools/htmlPlaneDriver';
import { clampHtmlFps, HTML_PLANE_FPS_MIN, HTML_PLANE_FPS_MAX } from '../core/scene/objectData';
import { makeCollapsible } from './collapsibleSection';

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

/** 0..1 RGB floats → lowercase "#rrggbb" for a native color input. */
function rgbToHex(c: readonly [number, number, number]): string {
  const h = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, '0');
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}

/** "#rrggbb" → 0..1 RGB float triple. */
function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

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

/** Context handed to every tab's build(): the shared scene + undo stack, plus an
 *  optional status setter (UR8-2 Convert to Mesh reports through it). */
export interface PropertiesTabContext {
  scene: Scene;
  undo: UndoStack;
  setStatus?: (text: string) => void;
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

/** Register a tab type. Ignores duplicate ids (same pattern as modifiers).
 *  `prepend` puts the tab at the FRONT of the strip (UR16-3 Render tab sits
 *  above Object, which self-registers when this module loads). */
export function registerPropertiesTab(tab: PropertiesTab, prepend = false): void {
  if (registry.some((t) => t.id === tab.id)) return;
  if (prepend) registry.unshift(tab);
  else registry.push(tab);
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

  /** UR14-3 item 3: the active tab's human title, so the panel header can read
   *  "Properties · Material" (main.ts polls this in the wrapPanel updater). */
  get activeTitle(): string {
    return registry.find((t) => t.id === this.activeTab)?.title ?? '';
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

// ---------------------------------------------------------- Web Page section --

/**
 * "Web Page" section of the Object tab (UR7-2 C) — shown ONLY when the active
 * object is an HTML plane (`obj.html`). Exposes the page controls:
 *  - Page Width / Page Height (px) → drive the plane geometry (UR7-2 B), one
 *    undo per committed edit via {@link setHtmlPageExtent};
 *  - Scroll Y (readonly readout of the browse-mode scroll);
 *  - FPS (1–15 re-raster cap, a preview setting — no undo, like the shading knobs);
 *  - Source (readonly: file → name + first chars; url → the address, editable in UR7-3);
 *  - a Play/Pause toggle (▶/⏸) driving `html.playing` and a ● key button that
 *    keys the `html.playing` channel at the current frame (reuses lightTab's
 *    InsertKeysCommand pattern);
 *  - a Re-rasterize button that forces a fresh raster (useful after fonts load).
 */
class WebPageSection {
  readonly element: HTMLDivElement;
  private readonly widthInput: HTMLInputElement;
  private readonly heightInput: HTMLInputElement;
  private readonly scrollReadout: HTMLInputElement;
  private readonly fpsInput: HTMLInputElement;
  private readonly sourceReadout: HTMLInputElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly portalHint: HTMLDivElement;
  private lastId: number | null = -1 as unknown as number;

  constructor(
    private readonly scene: Scene,
    private readonly undo: UndoStack,
  ) {
    this.element = document.createElement('div');
    this.element.className = 'properties-group web-page-section';
    this.element.dataset.section = 'web-page';

    const heading = document.createElement('div');
    heading.className = 'properties-group-title';
    heading.textContent = 'Web Page';
    this.element.append(heading);

    // Page Width / Height (px) — drive the plane geometry, one undo per commit.
    this.widthInput = this.numInput('page-width', '1', '1');
    this.heightInput = this.numInput('page-height', '1', '1');
    this.widthInput.addEventListener('change', () => this.commitExtent());
    this.heightInput.addEventListener('change', () => this.commitExtent());
    this.element.append(this.labelledRow('Page Width', this.widthInput));
    this.element.append(this.labelledRow('Page Height', this.heightInput));

    // Scroll Y — readonly readout (page mode's wheel drives it; not undoable).
    this.scrollReadout = this.numInput('scroll-y', '1', '0');
    this.scrollReadout.readOnly = true;
    this.element.append(this.labelledRow('Scroll Y', this.scrollReadout));

    // FPS (1–15 re-raster cap) — a preview setting, no undo.
    this.fpsInput = this.numInput('fps', '1', String(HTML_PLANE_FPS_MIN));
    this.fpsInput.min = String(HTML_PLANE_FPS_MIN);
    this.fpsInput.max = String(HTML_PLANE_FPS_MAX);
    this.fpsInput.addEventListener('change', () => this.commitFps());
    this.element.append(this.labelledRow('FPS', this.fpsInput));

    // Source (readonly; UR7-3 makes the url editable).
    this.sourceReadout = document.createElement('input');
    this.sourceReadout.type = 'text';
    this.sourceReadout.className = 'properties-input web-page-source';
    this.sourceReadout.dataset.field = 'source';
    this.sourceReadout.readOnly = true;
    this.element.append(this.labelledRow('Source', this.sourceReadout));

    // Play/Pause + ● key + Re-rasterize buttons.
    const btnRow = document.createElement('div');
    btnRow.className = 'properties-row web-page-buttons';

    this.playBtn = document.createElement('button');
    this.playBtn.type = 'button';
    this.playBtn.className = 'web-page-play';
    this.playBtn.dataset.action = 'play-toggle';
    this.playBtn.addEventListener('click', () => {
      const obj = this.activeHtml();
      if (obj) obj.html!.playing = !obj.html!.playing;
      this.writeFields();
    });

    const keyBtn = document.createElement('button');
    keyBtn.type = 'button';
    keyBtn.className = 'web-page-key';
    keyBtn.dataset.action = 'play-key';
    keyBtn.textContent = '●';
    keyBtn.title = 'Insert a key on Play at the current frame';
    keyBtn.style.color = '#e8a33d';
    keyBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const obj = this.activeHtml();
      if (!obj) return;
      const cmd = InsertKeysCommand.perform(
        'Key Play', this.scene, [obj], ['html.playing'], this.scene.frameCurrent, 'constant');
      if (cmd) this.undo.push(cmd);
    });

    const rerasterBtn = document.createElement('button');
    rerasterBtn.type = 'button';
    rerasterBtn.className = 'web-page-reraster';
    rerasterBtn.dataset.action = 'reraster';
    rerasterBtn.textContent = 'Re-rasterize';
    rerasterBtn.title = 'Force a fresh raster (e.g. after web fonts load)';
    rerasterBtn.addEventListener('click', () => {
      const obj = this.activeHtml();
      if (obj) requestHtmlReraster(obj);
    });

    btnRow.append(this.playBtn, keyBtn, rerasterBtn);
    this.element.append(btnRow);

    // UR7-3: one-line portal-limits hint, shown ONLY for URL (portal) planes.
    this.portalHint = document.createElement('div');
    this.portalHint.className = 'web-page-hint';
    this.portalHint.dataset.field = 'portal-hint';
    this.portalHint.textContent =
      'Live portal: an iframe drawn OVER the 3D scene (no occlusion) — invisible ' +
      'in F12/Ctrl+F12 renders and viewport screenshots. Sites that refuse framing ' +
      'show blank; press ⏸ to snapshot the page (CORS) or a card onto the plane.';
    this.portalHint.style.display = 'none';
    this.element.append(this.portalHint);
  }

  private numInput(field: string, step: string, min: string): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'properties-input';
    input.dataset.field = field;
    input.step = step;
    input.min = min;
    return input;
  }

  private labelledRow(text: string, control: HTMLElement): HTMLElement {
    const row = document.createElement('label');
    row.className = 'properties-field web-page-row';
    const label = document.createElement('span');
    label.className = 'properties-axis web-page-label';
    label.textContent = text;
    row.append(label, control);
    return row;
  }

  /** The active object iff it is an HTML plane, else null. */
  private activeHtml(): SceneObject | null {
    const obj = this.scene.activeObject;
    return obj && obj.html ? obj : null;
  }

  update(): void {
    const obj = this.activeHtml();
    if (!obj) {
      this.element.style.display = 'none';
      this.lastId = null;
      return;
    }
    this.element.style.display = '';
    const switched = obj.id !== this.lastId;
    this.lastId = obj.id;
    // Don't clobber a field the user is mid-edit in (unless we just switched).
    if (!switched && this.isFocused()) {
      this.writePlayButton(obj); // the toggle glyph can still follow state
      this.writeScroll(obj);
      return;
    }
    this.writeFields();
  }

  private isFocused(): boolean {
    const active = document.activeElement;
    return active instanceof HTMLInputElement && this.element.contains(active);
  }

  private writeFields(): void {
    const obj = this.activeHtml();
    if (!obj || !obj.html) return;
    const html = obj.html;
    this.writeNum(this.widthInput, html.pageW);
    this.writeNum(this.heightInput, html.pageH);
    this.writeNum(this.fpsInput, clampHtmlFps(html.fps));
    this.writeScroll(obj);
    const src = html.kind === 'url'
      ? html.source
      : `${obj.name} — ${html.source.replace(/\s+/g, ' ').trim().slice(0, 60)}`;
    if (this.sourceReadout.value !== src) this.sourceReadout.value = src;
    this.portalHint.style.display = html.kind === 'url' ? '' : 'none';
    this.writePlayButton(obj);
  }

  private writeScroll(obj: SceneObject): void {
    this.writeNum(this.scrollReadout, Math.round(obj.html!.scrollY));
  }

  private writePlayButton(obj: SceneObject): void {
    const playing = obj.html!.playing;
    this.playBtn.textContent = playing ? '⏸' : '▶';
    this.playBtn.title = playing ? 'Pause the page' : 'Play the page';
    this.playBtn.setAttribute('aria-pressed', String(playing));
  }

  private writeNum(input: HTMLInputElement, value: number): void {
    const s = String(value);
    if (input.value !== s && document.activeElement !== input) input.value = s;
  }

  private commitExtent(): void {
    const obj = this.activeHtml();
    if (!obj) return;
    const w = parseFloat(this.widthInput.value);
    const h = parseFloat(this.heightInput.value);
    // Bad input → snap the fields back to the committed values.
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) { this.writeFields(); return; }
    setHtmlPageExtent(obj, this.undo, w, h);
    this.writeFields();
  }

  private commitFps(): void {
    const obj = this.activeHtml();
    if (!obj) return;
    const raw = parseFloat(this.fpsInput.value);
    if (Number.isFinite(raw)) obj.html!.fps = clampHtmlFps(raw); // preview cap — no undo
    this.writeFields();
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
  private colorInput!: HTMLInputElement;
  private readonly transformFields: TransformFields;
  private readonly webPage: WebPageSection;

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
    this.empty.textContent = 'No active object — Shift+A adds one';

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

    // Viewport display color (like visibility: view state, no undo). The native
    // color picker stores hex; we convert to/from the object's 0..1 RGB floats.
    const colorRow = document.createElement('label');
    colorRow.className = 'properties-visible-row';
    this.colorInput = document.createElement('input');
    this.colorInput.type = 'color';
    this.colorInput.className = 'properties-color';
    this.colorInput.dataset.action = 'object-color';
    this.colorInput.addEventListener('input', () => {
      const obj = this.scene.activeObject;
      if (obj) obj.color = hexToRgb(this.colorInput.value);
    });
    const colorLabel = document.createElement('span');
    colorLabel.textContent = 'Color';
    colorRow.append(this.colorInput, colorLabel);
    this.body.append(colorRow);

    // Editable Location / Rotation / Scale — shared with the viewport N-panel.
    this.transformFields = new TransformFields(this.scene, this.undo);
    this.body.appendChild(this.transformFields.element);

    // Web Page section — only shown for HTML planes (self-hiding in update()).
    this.webPage = new WebPageSection(this.scene, this.undo);
    this.body.appendChild(this.webPage.element);

    // UR14-3 item 9: make the long Object-tab sections collapsible (persisted
    // via uiPrefs, like shadePrefs.sections). Only this instance's DOM is
    // touched — the N-panel builds its OWN TransformFields, so it's unaffected.
    for (const group of Array.from(
      this.transformFields.element.querySelectorAll<HTMLElement>(':scope > .properties-group'),
    )) {
      const title = group.querySelector<HTMLElement>(':scope > .properties-group-title');
      if (title) makeCollapsible(group, title, `object.${title.textContent ?? ''}`);
    }
    const webTitle = this.webPage.element.querySelector<HTMLElement>(':scope > .properties-group-title');
    if (webTitle) makeCollapsible(this.webPage.element, webTitle, 'object.Web Page');

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

    // The Web Page section refreshes every frame (its own focus guard protects
    // mid-edit fields) so the Scroll Y readout tracks browse-mode scrolling live.
    this.webPage.update();

    // Skip value rewrites while the user is editing a field (unless we just
    // switched objects, in which case the fields must repopulate immediately —
    // switching also blurs any prior input).
    if (!switched && this.isPanelFocused()) return;

    if (this.nameInput.value !== obj.name) this.nameInput.value = obj.name;
    this.nameBefore = obj.name;
    if (this.visibleInput.checked !== obj.visible) this.visibleInput.checked = obj.visible;
    if (this.smoothInput.checked !== obj.shadeSmooth) this.smoothInput.checked = obj.shadeSmooth;
    const hex = rgbToHex(obj.color);
    if (this.colorInput.value !== hex) this.colorInput.value = hex;

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
