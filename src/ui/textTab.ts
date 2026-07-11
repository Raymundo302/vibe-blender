import type { Scene, SceneObject } from '../core/scene/Scene';
import type { UndoStack } from '../core/undo/UndoStack';
import type { TextData } from '../core/scene/objectData';
import { registerPropertiesTab, type PropertiesTabContext } from './propertiesEditor';
import { TextCommand, ConvertTextToMeshCommand } from '../core/undo/textCommands';
import { InsertKeysCommand } from '../core/anim/animCommands';
import { fontAvailable } from '../core/text/raster';
import './textTab.css';

/**
 * Text properties tab (UR8-2) — Blender's text data panel. Edits the ACTIVE
 * object's TextData live when that object is kind 'text'; otherwise it shows an
 * empty state (mirroring the Light tab). Every field commit pushes ONE undoable
 * TextCommand snapshotting the whole payload before/after; the frame-loop text
 * driver regenerates the mesh whenever the payload's signature changes.
 */

/** 0..1 RGB floats → "#rrggbb". */
function rgbToHex(c: readonly [number, number, number]): string {
  const h = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, '0');
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}
/** "#rrggbb" → 0..1 RGB float triple. */
function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Curated font candidates (UR8-2). Only the AVAILABLE ones are shown, each
 *  rendered in its own family so the list previews the fonts. */
const FONT_CANDIDATES = [
  'Arial', 'Helvetica', 'Georgia', 'Times New Roman', 'Courier New', 'monospace',
  'Verdana', 'Trebuchet MS', 'Impact', 'Comic Sans MS', 'DejaVu Sans', 'DejaVu Serif',
  'Liberation Sans', 'Liberation Mono', 'Press Start 2P',
];

/** Generic CSS families are keywords — must NOT be quoted; every real family
 *  name IS quoted (names with spaces/digits like "Press Start 2P" are invalid
 *  unquoted and silently fall back to the inherited font). */
const GENERIC_FAMILIES = new Set(['monospace', 'sans-serif', 'serif', 'cursive', 'fantasy']);
function cssFamily(family: string): string {
  return GENERIC_FAMILIES.has(family) ? family : `"${family}"`;
}

const ALIGNS: TextData['align'][] = ['left', 'center', 'right', 'justify'];
const STYLES: TextData['style'][] = ['face', 'outline', 'both'];

class TextTab {
  private readonly empty: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly contentArea: HTMLTextAreaElement;
  private readonly fontBtn: HTMLButtonElement;
  private readonly fontList: HTMLDivElement;
  private readonly sizeInput: HTMLInputElement;
  private readonly wrapToggle: HTMLInputElement;
  private readonly wrapWidthInput: HTMLInputElement;
  private readonly alignBtns = new Map<TextData['align'], HTMLButtonElement>();
  private readonly styleBtns = new Map<TextData['style'], HTMLButtonElement>();
  private readonly faceColor: HTMLInputElement;
  private readonly outlineColor: HTMLInputElement;
  private readonly thicknessInput: HTMLInputElement;
  private contentBefore = '';

  constructor(
    container: HTMLElement,
    private readonly scene: Scene,
    private readonly undo: UndoStack,
    private readonly setStatus?: (text: string) => void,
  ) {
    this.empty = document.createElement('div');
    this.empty.className = 'properties-empty';
    this.empty.textContent = 'No text object selected';

    this.body = document.createElement('div');
    this.body.className = 'properties-body text-tab';

    // Content — "a little text box in the property panel". Commit on blur, or on
    // Ctrl/Cmd+Enter (plain Enter inserts a newline). One undo per commit.
    this.contentArea = document.createElement('textarea');
    this.contentArea.className = 'text-tab-content';
    this.contentArea.dataset.field = 'content';
    this.contentArea.rows = 3;
    this.contentArea.addEventListener('blur', () => this.commitContent());
    this.contentArea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.commitContent(); }
      e.stopPropagation(); // keep viewport shortcuts from firing while typing here
    });
    this.body.append(this.labelledRow('Content', this.contentArea));

    // Font — a CUSTOM dropdown rendered in the actual fonts.
    this.fontBtn = document.createElement('button');
    this.fontBtn.type = 'button';
    this.fontBtn.className = 'text-tab-font-current';
    this.fontBtn.dataset.field = 'font';
    this.fontBtn.addEventListener('click', () => {
      this.fontList.hidden = !this.fontList.hidden;
    });
    this.fontList = document.createElement('div');
    this.fontList.className = 'text-tab-font-list';
    this.fontList.hidden = true;
    this.body.append(this.labelledRow('Font', this.fontBtn));
    this.body.append(this.fontList);

    // Size
    this.sizeInput = this.numInput('size', '0.05', '0.01');
    this.sizeInput.addEventListener('change', () => {
      const v = parseFloat(this.sizeInput.value);
      if (!Number.isFinite(v) || v <= 0) return this.refresh();
      this.commit('Set Text Size', (t) => { t.size = v; });
    });
    this.body.append(this.labelledRow('Size', this.sizeInput));

    // Wrap toggle + wrap width
    this.wrapToggle = document.createElement('input');
    this.wrapToggle.type = 'checkbox';
    this.wrapToggle.dataset.field = 'wrap';
    this.wrapToggle.addEventListener('change', () => {
      const on = this.wrapToggle.checked;
      this.commit('Set Text Wrap', (t) => { t.wrap = on; });
    });
    this.body.append(this.labelledRow('Wrap', this.wrapToggle));

    this.wrapWidthInput = this.numInput('wrap-width', '1', '1');
    this.wrapWidthInput.addEventListener('change', () => {
      const v = parseFloat(this.wrapWidthInput.value);
      if (!Number.isFinite(v) || v <= 0) return this.refresh();
      this.commit('Set Wrap Width', (t) => { t.wrapWidth = v; });
    });
    this.body.append(this.labelledRow('Wrap Width', this.wrapWidthInput));

    // Align — 4-way segmented control.
    this.body.append(this.labelledRow('Align', this.segmented(
      ALIGNS, this.alignBtns, (a) => this.commit('Set Text Align', (t) => { t.align = a; }),
      { left: '⌫', center: '≡', right: '⌦', justify: '☰' },
    )));

    // Style — face / outline / both segmented control.
    this.body.append(this.labelledRow('Style', this.segmented(
      STYLES, this.styleBtns, (s) => this.commit('Set Text Style', (t) => { t.style = s; }),
      { face: 'Face', outline: 'Outline', both: 'Both' },
    )));

    // Colors
    this.faceColor = this.colorInput('face-color');
    this.faceColor.addEventListener('input', () => {
      const rgb = hexToRgb(this.faceColor.value);
      this.commit('Set Face Color', (t) => { t.faceColor = rgb; });
    });
    this.body.append(this.labelledRow('Face Color', this.faceColor));

    this.outlineColor = this.colorInput('outline-color');
    this.outlineColor.addEventListener('input', () => {
      const rgb = hexToRgb(this.outlineColor.value);
      this.commit('Set Outline Color', (t) => { t.outlineColor = rgb; });
    });
    this.body.append(this.labelledRow('Outline Color', this.outlineColor));

    // Thickness + ● key button on the text.thickness channel.
    this.thicknessInput = this.numInput('thickness', '0.05', '0');
    this.thicknessInput.addEventListener('change', () => {
      const v = parseFloat(this.thicknessInput.value);
      if (!Number.isFinite(v) || v < 0) return this.refresh();
      this.commit('Set Text Thickness', (t) => { t.thickness = v; });
    });
    const thickRow = this.labelledRow('Thickness', this.thicknessInput);
    thickRow.append(this.keyButton());
    this.body.append(thickRow);

    // Convert to Mesh
    const convertBtn = document.createElement('button');
    convertBtn.type = 'button';
    convertBtn.className = 'text-tab-convert';
    convertBtn.dataset.action = 'convert-to-mesh';
    convertBtn.textContent = 'Convert to Mesh';
    convertBtn.addEventListener('click', () => this.convertToMesh());
    this.body.append(convertBtn);

    container.append(this.empty, this.body);
    this.update();
  }

  private numInput(field: string, step: string, min: string): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'text-tab-input';
    input.dataset.field = field;
    input.step = step;
    input.min = min;
    return input;
  }

  private colorInput(field: string): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'color';
    input.className = 'text-tab-color';
    input.dataset.field = field;
    return input;
  }

  private segmented<K extends string>(
    values: readonly K[],
    map: Map<K, HTMLButtonElement>,
    onPick: (v: K) => void,
    labels: Record<K, string>,
  ): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'text-tab-segmented';
    for (const v of values) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'text-tab-seg-btn';
      btn.dataset.value = v;
      btn.textContent = labels[v];
      btn.title = v;
      btn.addEventListener('click', () => onPick(v));
      wrap.append(btn);
      map.set(v, btn);
    }
    return wrap;
  }

  private keyButton(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'text-tab-key-btn';
    btn.dataset.action = 'key-thickness';
    btn.textContent = '●';
    btn.title = 'Insert a Thickness keyframe at the current frame';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const obj = this.activeText();
      if (!obj) return;
      const cmd = InsertKeysCommand.perform(
        'Key Thickness', this.scene, [obj], ['text.thickness'], this.scene.frameCurrent);
      if (cmd) this.undo.push(cmd);
    });
    return btn;
  }

  private labelledRow(text: string, control: HTMLElement): HTMLElement {
    const row = document.createElement('label');
    row.className = 'text-tab-row';
    const label = document.createElement('span');
    label.className = 'properties-group-title text-tab-label';
    label.textContent = text;
    label.style.marginBottom = '0';
    row.append(label, control);
    return row;
  }

  /** The active object iff it is a text object with a payload, else null. */
  private activeText(): SceneObject | null {
    const obj = this.scene.activeObject;
    return obj && obj.kind === 'text' && obj.text ? obj : null;
  }

  update(): void {
    const obj = this.activeText();
    if (!obj || !obj.text) {
      this.empty.style.display = '';
      this.body.style.display = 'none';
      this.fontList.hidden = true;
      return;
    }
    this.empty.style.display = 'none';
    this.body.style.display = '';
    if (this.isPanelFocused()) return; // don't clobber mid-edit fields
    this.writeFields(obj.text);
  }

  private isPanelFocused(): boolean {
    const a = document.activeElement;
    return (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) && this.body.contains(a);
  }

  private writeFields(t: TextData): void {
    if (document.activeElement !== this.contentArea) {
      if (this.contentArea.value !== t.content) this.contentArea.value = t.content;
      this.contentBefore = t.content;
    }
    this.buildFontList(t.font);
    if (this.sizeInput.value !== String(t.size)) this.sizeInput.value = String(t.size);
    this.wrapToggle.checked = t.wrap;
    this.wrapWidthInput.disabled = !t.wrap;
    if (this.wrapWidthInput.value !== String(t.wrapWidth)) this.wrapWidthInput.value = String(t.wrapWidth);
    for (const [a, btn] of this.alignBtns) btn.classList.toggle('active', a === t.align);
    for (const [s, btn] of this.styleBtns) btn.classList.toggle('active', s === t.style);
    const fh = rgbToHex(t.faceColor);
    if (this.faceColor.value !== fh) this.faceColor.value = fh;
    const oh = rgbToHex(t.outlineColor);
    if (this.outlineColor.value !== oh) this.outlineColor.value = oh;
    if (this.thicknessInput.value !== String(t.thickness)) this.thicknessInput.value = String(t.thickness);
  }

  /** (Re)build the font dropdown: current font + every AVAILABLE candidate, each
   *  option rendered in its own family. */
  private buildFontList(current: string): void {
    this.fontBtn.textContent = current;
    this.fontBtn.style.fontFamily = cssFamily(current);
    // Rebuild the option list only when the set of available fonts / current
    // could have changed — cheap enough to rebuild each refresh (short list).
    const families = FONT_CANDIDATES.filter((f) => fontAvailable(f) || f === 'monospace');
    if (!families.includes(current)) families.unshift(current);
    // Skip a rebuild if unchanged (avoid clobbering a mid-hover state).
    const key = families.join('|');
    if (this.fontList.dataset.key === key) {
      for (const el of this.fontList.children) {
        (el as HTMLElement).classList.toggle('active', (el as HTMLElement).dataset.value === current);
      }
      return;
    }
    this.fontList.dataset.key = key;
    this.fontList.textContent = '';
    for (const family of families) {
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'text-tab-font-option';
      opt.dataset.value = family;
      opt.textContent = family;
      opt.style.fontFamily = cssFamily(family);
      opt.classList.toggle('active', family === current);
      opt.addEventListener('click', () => {
        this.fontList.hidden = true;
        this.commit('Set Font', (t) => { t.font = family; });
      });
      this.fontList.append(opt);
    }
  }

  /** Push one TextCommand for the active text object, then refresh. */
  private commit(name: string, mutate: (t: TextData) => void): void {
    const obj = this.activeText();
    if (!obj) return;
    this.undo.push(TextCommand.capture(name, obj, mutate));
    this.refresh();
  }

  private commitContent(): void {
    const obj = this.activeText();
    if (!obj || !obj.text) return;
    const after = this.contentArea.value;
    if (after === this.contentBefore) return;
    this.undo.push(TextCommand.capture('Edit Text', obj, (t) => { t.content = after; }));
    this.contentBefore = after;
  }

  private convertToMesh(): void {
    const obj = this.activeText();
    if (!obj) return;
    const cmd = ConvertTextToMeshCommand.create(this.scene, obj);
    if (!cmd) return;
    cmd.redo(); // apply, then push (the caller-applies-then-pushes convention)
    this.undo.push(cmd);
    this.setStatus?.('Converted to mesh');
  }

  private refresh(): void {
    const obj = this.activeText();
    if (obj && obj.text) this.writeFields(obj.text);
  }
}

registerPropertiesTab({
  id: 'text',
  icon: '\u{1D413}', // 𝐓
  title: 'Text',
  build: (container: HTMLElement, ctx: PropertiesTabContext) =>
    new TextTab(container, ctx.scene, ctx.undo, ctx.setStatus),
});
