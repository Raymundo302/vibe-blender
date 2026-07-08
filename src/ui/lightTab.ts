import type { Scene, SceneObject } from '../core/scene/Scene';
import type { UndoStack } from '../core/undo/UndoStack';
import type { Command } from '../core/undo/UndoStack';
import type { LightData, LightType } from '../core/scene/objectData';
import { registerPropertiesTab } from './propertiesEditor';
import { InsertKeysCommand } from '../core/anim/animCommands';
import './lightTab.css';

/**
 * Light properties tab (P8-1) — Blender's lightbulb panel. Edits the ACTIVE
 * object's LightData live when that object is a light; otherwise it shows an
 * empty state (mirroring the Object/Modifier tabs). Lights already exist
 * end-to-end (Shift+A → Add Light, viewport icon, click-select, rendered mode
 * consumes them via collectLights); this tab is purely the data UI.
 *
 * Every field commit pushes ONE undoable LightCommand that snapshots the full
 * LightData before/after, so undo restores the exact prior light state. The
 * rendered viewport reflects edits immediately because it reads scene state per
 * frame — we just mutate obj.light in place.
 *
 * Registered at module load like the other tabs; main.ts imports this file once
 * for the side effect.
 */

// --- Pure helpers (unit-tested) ----------------------------------------------

const RAD_PER_DEG = Math.PI / 180;
const DEG_PER_RAD = 180 / Math.PI;

/** 0..1 RGB floats → lowercase "#rrggbb" for a native color input. */
export function rgbToHex(c: readonly [number, number, number]): string {
  const h = (n: number) =>
    Math.round(Math.max(0, Math.min(1, n)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}

/** "#rrggbb" → 0..1 RGB float triple (treated as linear, like obj.color). */
export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Deep copy of a LightData (its only non-primitive is the color triple). */
export function cloneLight(l: LightData): LightData {
  return { ...l, color: [l.color[0], l.color[1], l.color[2]] };
}

// --- Undo command ------------------------------------------------------------

/**
 * One undoable edit to an object's LightData. Snapshots the full payload
 * before/after so undo/redo restore the exact prior light (type, color, power,
 * spot cone) regardless of which field changed. Assigns a fresh clone on each
 * direction so the live object never shares a reference with the snapshots.
 */
export class LightCommand implements Command {
  private constructor(
    readonly name: string,
    private readonly obj: SceneObject,
    private readonly before: LightData,
    private readonly after: LightData,
  ) {}

  /** Snapshot obj.light, run mutate() against the live payload, snapshot again. */
  static capture(name: string, obj: SceneObject, mutate: (l: LightData) => void): LightCommand {
    const light = obj.light;
    if (!light) throw new Error('LightCommand.capture: object has no light');
    const before = cloneLight(light);
    mutate(light);
    const after = cloneLight(light);
    return new LightCommand(name, obj, before, after);
  }

  undo(): void {
    this.obj.light = cloneLight(this.before);
  }

  redo(): void {
    this.obj.light = cloneLight(this.after);
  }
}

// --- Tab ---------------------------------------------------------------------

const LIGHT_TYPES: readonly { value: LightType; label: string }[] = [
  { value: 'point', label: 'Point' },
  { value: 'sun', label: 'Sun' },
  { value: 'spot', label: 'Spot' },
];

class LightTab {
  private readonly empty: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly typeSelect: HTMLSelectElement;
  private readonly colorInput: HTMLInputElement;
  private readonly powerInput: HTMLInputElement;
  private readonly radiusRow: HTMLElement;
  private readonly radiusInput: HTMLInputElement;
  private readonly spotBlock: HTMLDivElement;
  private readonly angleInput: HTMLInputElement;
  private readonly blendInput: HTMLInputElement;

  constructor(
    container: HTMLElement,
    private readonly scene: Scene,
    private readonly undo: UndoStack,
  ) {
    this.empty = document.createElement('div');
    this.empty.className = 'properties-empty';
    this.empty.textContent = 'No light selected';

    this.body = document.createElement('div');
    this.body.className = 'properties-body';

    // Type ------------------------------------------------------------------
    this.typeSelect = document.createElement('select');
    this.typeSelect.className = 'light-tab-select';
    this.typeSelect.dataset.field = 'type';
    for (const { value, label } of LIGHT_TYPES) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      this.typeSelect.append(opt);
    }
    this.typeSelect.addEventListener('change', () => {
      const type = this.typeSelect.value as LightType;
      // Type change keeps color/power/cone — defaultLight is only for NEW lights.
      this.commit('Set Light Type', (l) => { l.type = type; });
    });
    this.body.append(this.labelledRow('Type', this.typeSelect));

    // Color -----------------------------------------------------------------
    this.colorInput = document.createElement('input');
    this.colorInput.type = 'color';
    this.colorInput.className = 'light-tab-color';
    this.colorInput.dataset.field = 'color';
    this.colorInput.addEventListener('change', () => {
      const rgb = hexToRgb(this.colorInput.value);
      this.commit('Set Light Color', (l) => { l.color = rgb; });
    });
    const colorRow = this.labelledRow('Color', this.colorInput);
    colorRow.append(this.keyButton(
      'light-tab-key-color',
      'Insert Color keyframe',
      ['light.color.r', 'light.color.g', 'light.color.b'],
    ));
    this.body.append(colorRow);

    // Power -----------------------------------------------------------------
    this.powerInput = document.createElement('input');
    this.powerInput.type = 'number';
    this.powerInput.className = 'light-tab-input';
    this.powerInput.dataset.field = 'power';
    this.powerInput.min = '0';
    this.powerInput.step = '1';
    this.powerInput.addEventListener('change', () => {
      const raw = parseFloat(this.powerInput.value);
      if (!Number.isFinite(raw)) return this.refresh();
      const power = Math.max(0, raw);
      this.commit('Set Light Power', (l) => { l.power = power; });
    });
    const powerRow = this.labelledRow('Power', this.powerInput);
    powerRow.append(this.keyButton('light-tab-key-power', 'Insert Power keyframe', ['light.power']));
    this.body.append(powerRow);

    // Radius (soft-shadow source size; point/spot only) ---------------------
    this.radiusInput = document.createElement('input');
    this.radiusInput.type = 'number';
    this.radiusInput.className = 'light-tab-input';
    this.radiusInput.dataset.field = 'radius';
    this.radiusInput.min = '0';
    this.radiusInput.step = '0.05';
    this.radiusInput.addEventListener('change', () => {
      const raw = parseFloat(this.radiusInput.value);
      if (!Number.isFinite(raw)) return this.refresh();
      const radius = Math.max(0, raw);
      this.commit('Set Light Radius', (l) => { l.radius = radius; });
    });
    this.radiusRow = this.labelledRow('Radius', this.radiusInput);
    this.body.append(this.radiusRow);

    // Spot-only: angle (degrees in UI, radians in data) + blend -------------
    this.spotBlock = document.createElement('div');
    this.spotBlock.className = 'light-tab-spot';

    this.angleInput = document.createElement('input');
    this.angleInput.type = 'number';
    this.angleInput.className = 'light-tab-input';
    this.angleInput.dataset.field = 'angle';
    this.angleInput.min = '0';
    this.angleInput.max = '180';
    this.angleInput.step = '1';
    this.angleInput.addEventListener('change', () => {
      const deg = parseFloat(this.angleInput.value);
      if (!Number.isFinite(deg)) return this.refresh();
      const rad = Math.max(0, Math.min(180, deg)) * RAD_PER_DEG;
      this.commit('Set Spot Angle', (l) => { l.spotAngle = rad; });
    });
    this.spotBlock.append(this.labelledRow('Angle', this.angleInput));

    this.blendInput = document.createElement('input');
    this.blendInput.type = 'number';
    this.blendInput.className = 'light-tab-input';
    this.blendInput.dataset.field = 'blend';
    this.blendInput.min = '0';
    this.blendInput.max = '1';
    this.blendInput.step = '0.05';
    this.blendInput.addEventListener('change', () => {
      const raw = parseFloat(this.blendInput.value);
      if (!Number.isFinite(raw)) return this.refresh();
      const blend = Math.max(0, Math.min(1, raw));
      this.commit('Set Spot Blend', (l) => { l.spotBlend = blend; });
    });
    this.spotBlock.append(this.labelledRow('Blend', this.blendInput));

    this.body.append(this.spotBlock);

    container.append(this.empty, this.body);
    this.update();
  }

  /**
   * A small ● insert-keyframe button (P15-4) that keys `channels` on the active
   * light at scene.frameCurrent through one undoable InsertKeysCommand. No-op
   * when nothing is keyable (no active light / unresolvable channel). Sits
   * inside a field row but is its own interactive control, so clicking it keys
   * rather than toggling the adjacent input.
   */
  private keyButton(className: string, title: string, channels: string[]): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `light-tab-key-btn ${className}`;
    btn.textContent = '●';
    btn.title = title;
    btn.style.cssText =
      'margin-left:6px;background:none;border:none;color:#e8a33d;cursor:pointer;font-size:11px;line-height:1;padding:2px 3px;';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const obj = this.activeLight();
      if (!obj) return;
      const cmd = InsertKeysCommand.perform(title, this.scene, [obj], channels, this.scene.frameCurrent);
      if (cmd) this.undo.push(cmd);
    });
    return btn;
  }

  private labelledRow(text: string, control: HTMLElement): HTMLElement {
    const row = document.createElement('label');
    row.className = 'light-tab-row';
    const label = document.createElement('span');
    label.className = 'properties-group-title light-tab-label';
    label.textContent = text;
    label.style.marginBottom = '0';
    row.append(label, control);
    return row;
  }

  /** The active object iff it is a light with a payload, else null. */
  private activeLight(): SceneObject | null {
    const obj = this.scene.activeObject;
    return obj && obj.kind === 'light' && obj.light ? obj : null;
  }

  update(): void {
    const obj = this.activeLight();
    if (!obj || !obj.light) {
      this.empty.style.display = '';
      this.body.style.display = 'none';
      return;
    }
    this.empty.style.display = 'none';
    this.body.style.display = '';

    // Never overwrite a field the user is mid-edit in (matches the Object tab).
    if (this.isPanelFocused()) {
      // Type-driven visibility can still follow the committed type without
      // stealing focus from whatever field the user is mid-edit in.
      this.spotBlock.hidden = obj.light.type !== 'spot';
      this.radiusRow.hidden = obj.light.type === 'sun';
      return;
    }
    this.writeFields(obj.light);
  }

  private writeFields(l: LightData): void {
    if (this.typeSelect.value !== l.type) this.typeSelect.value = l.type;
    const hex = rgbToHex(l.color);
    if (this.colorInput.value !== hex) this.colorInput.value = hex;
    const power = String(round(l.power));
    if (this.powerInput.value !== power) this.powerInput.value = power;

    // Radius: shown for point/spot (world-unit sphere), hidden for sun.
    this.radiusRow.hidden = l.type === 'sun';
    const radius = String(round(l.radius ?? 0.1));
    if (this.radiusInput.value !== radius) this.radiusInput.value = radius;

    this.spotBlock.hidden = l.type !== 'spot';
    const deg = String(round(l.spotAngle * DEG_PER_RAD));
    if (this.angleInput.value !== deg) this.angleInput.value = deg;
    const blend = String(round(l.spotBlend, 2));
    if (this.blendInput.value !== blend) this.blendInput.value = blend;
  }

  private isPanelFocused(): boolean {
    const active = document.activeElement;
    return (
      (active instanceof HTMLInputElement || active instanceof HTMLSelectElement) &&
      this.body.contains(active)
    );
  }

  /** Push one undoable LightCommand for the active light, then refresh visuals. */
  private commit(name: string, mutate: (l: LightData) => void): void {
    const obj = this.activeLight();
    if (!obj) return;
    this.undo.push(LightCommand.capture(name, obj, mutate));
    this.refresh();
  }

  /** Force field values back in sync with the model (after commit / bad input). */
  private refresh(): void {
    const obj = this.activeLight();
    if (obj && obj.light) this.writeFields(obj.light);
  }
}

/** Round to `decimals` places, trimming float noise for display. */
function round(n: number, decimals = 3): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

// Registered at module load so any PropertiesEditor built afterward includes it.
registerPropertiesTab({
  id: 'light',
  icon: '💡',
  title: 'Light',
  build: (container, ctx) => new LightTab(container, ctx.scene, ctx.undo),
});
