import type { Scene } from '../core/scene/Scene';
import type { UndoStack, Command } from '../core/undo/UndoStack';
import { decodeHdriDataUrl, type World, type HdriImage } from '../core/scene/worldData';
import { registerPropertiesTab } from './propertiesEditor';
import './worldTab.css';

/**
 * World properties tab (P10-4) — Blender's World: the scene environment. Unlike
 * the Object/Material tabs this is ALWAYS available: the world is scene state,
 * not a property of the active object, so the tab shows the same UI with or
 * without a selection.
 *
 * Modes: Flat (one background color), Gradient (horizon→zenith), HDRI (an
 * equirectangular PNG/JPEG sampled by view-ray direction — genuine image-based
 * lighting through the tracer's bounces). `strength` scales the emitted energy.
 *
 * Undo: the capture pattern (before/after command on commit). Loading an HDRI is
 * ONE command holding the old/new packed data URL + mode.
 *
 * HDRI format: a plain equirectangular PNG or JPEG (v1). Real Radiance `.hdr`
 * (RGBE) is not decoded — the browser can't rasterize it — so the file input
 * documents PNG/JPEG; the equirect lighting is genuine regardless.
 */

// ------------------------------------------------------------- undo commands --

type WorldColorField = 'color' | 'horizon' | 'zenith';

function cloneRgb(c: readonly [number, number, number]): [number, number, number] {
  return [c[0], c[1], c[2]];
}

/** Edit a scalar/color field of the world. Caller writes `after` before pushing. */
class WorldEditCommand implements Command {
  readonly name = 'Edit World';
  constructor(
    private readonly world: World,
    private readonly field: WorldColorField | 'strength' | 'mode',
    private readonly before: string | number | [number, number, number],
    private readonly after: string | number | [number, number, number],
  ) {}
  private write(v: string | number | [number, number, number]): void {
    if (this.field === 'strength') this.world.strength = v as number;
    else if (this.field === 'mode') this.world.mode = v as World['mode'];
    else this.world[this.field] = cloneRgb(v as [number, number, number]);
  }
  undo(): void { this.write(this.before); }
  redo(): void { this.write(this.after); }
}

/** Snapshot of the HDRI-relevant world state for the load/undo command. */
interface HdriState {
  mode: World['mode'];
  hdri: string | null;
  hdriImage: HdriImage | null;
}

/** Load (or clear) an HDRI as a single undo step (mode + packed URL + pixels). */
class WorldHdriCommand implements Command {
  readonly name = 'Set World HDRI';
  constructor(
    private readonly world: World,
    private readonly before: HdriState,
    private readonly after: HdriState,
  ) {}
  private apply(s: HdriState): void {
    this.world.mode = s.mode;
    this.world.hdri = s.hdri;
    this.world.hdriImage = s.hdriImage;
  }
  undo(): void { this.apply(this.before); }
  redo(): void { this.apply(this.after); }
}

// ------------------------------------------------------------- color helpers --

function rgbToHex(c: readonly [number, number, number]): string {
  const h = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, '0');
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}
function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// ----------------------------------------------------------------- the tab UI --

class WorldTab {
  private readonly body: HTMLDivElement;
  private readonly modeSelect: HTMLSelectElement;
  private readonly flatRow: HTMLElement;
  private readonly gradientRows: HTMLElement;
  private readonly hdriRow: HTMLElement;
  private readonly colorInput: HTMLInputElement;
  private readonly horizonInput: HTMLInputElement;
  private readonly zenithInput: HTMLInputElement;
  private readonly strengthInput: HTMLInputElement;
  private readonly fileInput: HTMLInputElement;
  private readonly preview: HTMLImageElement;
  private readonly hdriLabel: HTMLSpanElement;

  /** Value captured when a color/strength input gained focus (undo `before`). */
  private editBefore: string | number | [number, number, number] | null = null;
  /** Last rendered signature; null forces a refresh. */
  private lastSig: string | null = null;

  constructor(
    container: HTMLElement,
    private readonly scene: Scene,
    private readonly undo: UndoStack,
  ) {
    this.body = document.createElement('div');
    this.body.className = 'properties-body world-tab';

    // Mode select.
    this.modeSelect = document.createElement('select');
    this.modeSelect.className = 'world-tab-mode';
    for (const [value, label] of [['flat', 'Flat'], ['gradient', 'Gradient'], ['hdri', 'HDRI']] as const) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      this.modeSelect.append(opt);
    }
    this.modeSelect.addEventListener('change', () => this.onModeChange());
    this.body.append(this.fieldRow('Mode', this.modeSelect));

    // Flat color.
    this.colorInput = this.colorPicker('world-tab-color');
    this.wireColor(this.colorInput, 'color');
    this.flatRow = this.fieldRow('Color', this.colorInput);

    // Gradient horizon + zenith.
    this.horizonInput = this.colorPicker('world-tab-horizon');
    this.wireColor(this.horizonInput, 'horizon');
    this.zenithInput = this.colorPicker('world-tab-zenith');
    this.wireColor(this.zenithInput, 'zenith');
    this.gradientRows = document.createElement('div');
    this.gradientRows.append(
      this.fieldRow('Horizon', this.horizonInput),
      this.fieldRow('Zenith', this.zenithInput),
    );

    // HDRI file input + preview swatch.
    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.className = 'world-tab-file';
    this.fileInput.accept = 'image/png,image/jpeg,.hdr';
    this.fileInput.addEventListener('change', () => this.onFile());
    // An <img> (not a <canvas>) shows the packed equirect thumbnail — the DOM
    // must hold exactly one <canvas> (the viewport), which the workspace suite
    // asserts, so the preview cannot introduce another.
    this.preview = document.createElement('img');
    this.preview.className = 'world-tab-preview';
    this.preview.alt = 'HDRI preview';
    this.hdriLabel = document.createElement('span');
    this.hdriLabel.className = 'world-tab-hdri-label';
    this.hdriLabel.textContent = '(no image)';
    this.hdriRow = document.createElement('div');
    this.hdriRow.className = 'world-tab-hdri';
    this.hdriRow.append(this.fileInput, this.preview, this.hdriLabel);

    this.body.append(this.flatRow, this.gradientRows, this.hdriRow);

    // Strength (always visible).
    this.strengthInput = document.createElement('input');
    this.strengthInput.type = 'number';
    this.strengthInput.className = 'world-tab-strength properties-input';
    this.strengthInput.min = '0';
    this.strengthInput.step = '0.1';
    this.wireStrength();
    this.body.append(this.fieldRow('Strength', this.strengthInput));

    container.append(this.body);

    // Debug handle for e2e (mirrors __renderEngine). Lets a suite drive the HDRI
    // load with a generated data URL instead of a real file dialog.
    (window as unknown as Record<string, unknown>).__world = {
      get: () => this.scene.world,
      loadHdri: (dataUrl: string) => this.loadHdriFromDataUrl(dataUrl),
    };

    this.update();
  }

  private colorPicker(cls: string): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'color';
    input.className = cls;
    return input;
  }

  private fieldRow(label: string, ...controls: HTMLElement[]): HTMLElement {
    const row = document.createElement('label');
    row.className = 'world-tab-field';
    const span = document.createElement('span');
    span.className = 'world-tab-label properties-group-title';
    span.style.marginBottom = '0';
    span.textContent = label;
    row.append(span, ...controls);
    return row;
  }

  /** Live-preview on input, one WorldEditCommand on change; capture before on focus. */
  private wireColor(input: HTMLInputElement, field: WorldColorField): void {
    input.addEventListener('focus', () => { this.editBefore = cloneRgb(this.scene.world[field]); });
    input.addEventListener('input', () => {
      if (this.editBefore === null) this.editBefore = cloneRgb(this.scene.world[field]);
      this.scene.world[field] = hexToRgb(input.value);
    });
    input.addEventListener('change', () => {
      const after = hexToRgb(input.value);
      const before = (this.editBefore as [number, number, number]) ?? after;
      this.scene.world[field] = after;
      this.editBefore = null;
      if (before[0] === after[0] && before[1] === after[1] && before[2] === after[2]) return;
      this.undo.push(new WorldEditCommand(this.scene.world, field, cloneRgb(before), cloneRgb(after)));
      this.lastSig = null;
    });
  }

  private wireStrength(): void {
    const input = this.strengthInput;
    input.addEventListener('focus', () => { this.editBefore = this.scene.world.strength; });
    input.addEventListener('input', () => {
      if (this.editBefore === null) this.editBefore = this.scene.world.strength;
      const v = parseFloat(input.value);
      if (Number.isFinite(v)) this.scene.world.strength = Math.max(0, v);
    });
    input.addEventListener('change', () => {
      const raw = parseFloat(input.value);
      const before = (this.editBefore as number) ?? this.scene.world.strength;
      this.editBefore = null;
      if (!Number.isFinite(raw)) { this.lastSig = null; return; }
      const after = Math.max(0, raw);
      this.scene.world.strength = after;
      if (before === after) { this.lastSig = null; return; }
      this.undo.push(new WorldEditCommand(this.scene.world, 'strength', before, after));
      this.lastSig = null;
    });
  }

  private onModeChange(): void {
    const before = this.scene.world.mode;
    const after = this.modeSelect.value as World['mode'];
    if (before === after) return;
    this.scene.world.mode = after;
    this.undo.push(new WorldEditCommand(this.scene.world, 'mode', before, after));
    this.lastSig = null;
  }

  private onFile(): void {
    const file = this.fileInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { void this.loadHdriFromDataUrl(String(reader.result)); };
    reader.readAsDataURL(file);
  }

  /**
   * Decode a packed HDRI data URL, set it as the world environment, and push ONE
   * undo command holding the old/new HDRI state. Exposed via __world for e2e.
   */
  async loadHdriFromDataUrl(dataUrl: string): Promise<void> {
    const image = await decodeHdriDataUrl(dataUrl);
    const w = this.scene.world;
    const before: HdriState = { mode: w.mode, hdri: w.hdri, hdriImage: w.hdriImage ?? null };
    const after: HdriState = { mode: 'hdri', hdri: dataUrl, hdriImage: image };
    w.mode = after.mode;
    w.hdri = after.hdri;
    w.hdriImage = after.hdriImage;
    this.undo.push(new WorldHdriCommand(w, before, after));
    this.lastSig = null;
  }

  update(): void {
    // Never yank focus out from under an in-progress edit.
    if (this.isPanelFocused()) return;
    const w = this.scene.world;
    const sig = [
      w.mode,
      rgbToHex(w.color), rgbToHex(w.horizon), rgbToHex(w.zenith),
      w.strength, w.hdri ? w.hdri.length : 0,
    ].join('#');
    if (sig === this.lastSig) return;
    this.lastSig = sig;

    this.modeSelect.value = w.mode;
    this.flatRow.style.display = w.mode === 'flat' ? '' : 'none';
    this.gradientRows.style.display = w.mode === 'gradient' ? '' : 'none';
    this.hdriRow.style.display = w.mode === 'hdri' ? '' : 'none';

    this.colorInput.value = rgbToHex(w.color);
    this.horizonInput.value = rgbToHex(w.horizon);
    this.zenithInput.value = rgbToHex(w.zenith);
    this.strengthInput.value = String(w.strength);
    // The <img> shows the packed data URL directly (browser decodes + scales it
    // via CSS). Hidden when there is no image so no broken-image glyph shows.
    if (w.hdri) { this.preview.src = w.hdri; this.preview.style.display = ''; }
    else { this.preview.removeAttribute('src'); this.preview.style.display = 'none'; }
    this.hdriLabel.textContent = w.hdri ? 'equirect loaded' : '(no image)';
  }

  private isPanelFocused(): boolean {
    const active = document.activeElement;
    return (
      (active instanceof HTMLInputElement || active instanceof HTMLSelectElement) &&
      this.body.contains(active)
    );
  }
}

// Registered at module load so any PropertiesEditor built afterward includes it.
registerPropertiesTab({
  id: 'world',
  icon: '🌍',
  title: 'World',
  build: (container, ctx) => new WorldTab(container, ctx.scene, ctx.undo),
});
