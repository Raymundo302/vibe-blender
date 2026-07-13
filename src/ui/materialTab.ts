import type { Scene, SceneObject } from '../core/scene/Scene';
import type { UndoStack, Command } from '../core/undo/UndoStack';
import type { Material, MaterialShader, MaterialChannelName, GradientInput, ChannelInput } from '../core/scene/objectData';
import {
  MATERIAL_SHADERS, channelsForShader, materialShader,
  getMaterialChannel, setMaterialChannel, cloneGradient, cloneAlpha,
} from '../core/scene/objectData';
import { srgbToLinear } from '../core/scene/worldData';
import { registerPropertiesTab } from './propertiesEditor';
import { InsertKeysCommand } from '../core/anim/animCommands';
import { propRow, socketButton } from './propRow';
import { Popover } from './popover';
import './materialTab.css';

/** Human-facing label for each named shader (the chooser + the Shader row). */
const SHADER_LABELS: Record<MaterialShader, string> = {
  diffuse: 'Diffuse',
  super: 'Super Shader',
  metal: 'Metal',
  glass: 'Glass',
  emit: 'Emit',
};

/** Human-facing label for each socketable channel. */
const LABELS: Record<MaterialChannelName, string> = {
  color: 'Color',
  roughness: 'Roughness',
  metallic: 'Metallic',
  alpha: 'Alpha',
};

/** Decoded base-color image cache: linear RGB, row 0 = top. */
type TexImage = { width: number; height: number; pixels: Float32Array };

/**
 * Decode a packed image data URL into linear-light pixels for the path tracer
 * (browser only, worldData HDRI style). Row 0 = top, sRGB→linear. The Rendered
 * viewport uploads the SAME data URL straight to a GL texture (Renderer), so the
 * two paths agree without sharing this decode.
 */
export function decodeTextureDataUrl(dataUrl: string): Promise<TexImage> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth, h = img.naturalHeight;
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('2d context unavailable')); return; }
        ctx.drawImage(img, 0, 0);
        const rgba = ctx.getImageData(0, 0, w, h).data;
        const pixels = new Float32Array(w * h * 3);
        for (let p = 0, q = 0; p < rgba.length; p += 4, q += 3) {
          pixels[q] = srgbToLinear(rgba[p] / 255);
          pixels[q + 1] = srgbToLinear(rgba[p + 1] / 255);
          pixels[q + 2] = srgbToLinear(rgba[p + 2] / 255);
        }
        resolve({ width: w, height: h, pixels });
      } catch (e) { reject(e as Error); }
    };
    img.onerror = () => reject(new Error('failed to decode texture image'));
    img.src = dataUrl;
  });
}

/**
 * Decode a packed image data URL into RAW 0..1 pixels — NO sRGB→linear
 * conversion (P13). Normal/bump, roughness and metallic maps store DATA, not
 * color, so a channel byte of 128 must round-trip to ≈0.502, not the
 * sRGB-linearized 0.216. The path tracer reads these caches straight off the
 * material. Row 0 = top, same layout as decodeTextureDataUrl.
 */
export function decodeRawTextureDataUrl(dataUrl: string): Promise<TexImage> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth, h = img.naturalHeight;
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('2d context unavailable')); return; }
        ctx.drawImage(img, 0, 0);
        const rgba = ctx.getImageData(0, 0, w, h).data;
        const pixels = new Float32Array(w * h * 3);
        for (let p = 0, q = 0; p < rgba.length; p += 4, q += 3) {
          pixels[q] = rgba[p] / 255;
          pixels[q + 1] = rgba[p + 1] / 255;
          pixels[q + 2] = rgba[p + 2] / 255;
        }
        resolve({ width: w, height: h, pixels });
      } catch (e) { reject(e as Error); }
    };
    img.onerror = () => reject(new Error('failed to decode map image'));
    img.src = dataUrl;
  });
}

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
  | 'name' | 'baseColor' | 'metallic' | 'roughness' | 'transmission' | 'ior'
  | 'emissive' | 'emissiveStrength'
  | 'subsurfaceWeight' | 'subsurfaceRadius' | 'bakeRes';

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

/** Snapshot of a material's texture state for undo/redo. */
interface TexState {
  texKind: Material['texKind'];
  texDataUrl: string | null;
  texImage: TexImage | undefined;
}

/**
 * Edit a material's texture (kind and/or packed image) in one undo step —
 * covers both a kind-select change (None/Checker/Image) and an image load
 * (worldTab HDRI style: one command with old/new url + decoded pixels, so undo
 * restores the tracer cache too).
 */
export class TextureEditCommand implements Command {
  readonly name = 'Edit Texture';

  constructor(
    private readonly material: Material,
    private readonly before: TexState,
    private readonly after: TexState,
  ) {}

  private write(s: TexState): void {
    this.material.texKind = s.texKind;
    this.material.texDataUrl = s.texDataUrl;
    this.material.texImage = s.texImage;
  }

  undo(): void { this.write(this.before); }
  redo(): void { this.write(this.after); }
}

// ------------------------------------------------------------- map commands --

/** The three P13 image-map slots (base-color texture is handled separately). */
export type MapSlot = 'normal' | 'rough' | 'metal';

/** Material data-url field for each map slot. */
const MAP_URL_FIELD: Record<MapSlot, 'normalDataUrl' | 'roughDataUrl' | 'metalDataUrl'> = {
  normal: 'normalDataUrl',
  rough: 'roughDataUrl',
  metal: 'metalDataUrl',
};

/** Material decoded-cache field for each map slot. */
const MAP_IMG_FIELD: Record<MapSlot, 'normalImage' | 'roughImage' | 'metalImage'> = {
  normal: 'normalImage',
  rough: 'roughImage',
  metal: 'metalImage',
};

/** Snapshot of one map slot: the data url AND its decoded cache. */
interface MapImgState {
  dataUrl: string | null;
  image: TexImage | undefined;
}

/**
 * Set or clear one image-map slot (normal/rough/metal) in ONE undo step. Stores
 * the data url AND the decoded cache in each snapshot so undo restores BOTH —
 * the tracer never sees a url without its pixels. Convention: caller has already
 * written `after` onto the material before pushing.
 */
export class MapImageEditCommand implements Command {
  readonly name = 'Edit Map';

  constructor(
    private readonly material: Material,
    private readonly slot: MapSlot,
    private readonly before: MapImgState,
    private readonly after: MapImgState,
  ) {}

  private write(s: MapImgState): void {
    this.material[MAP_URL_FIELD[this.slot]] = s.dataUrl;
    this.material[MAP_IMG_FIELD[this.slot]] = s.image;
  }

  undo(): void { this.write(this.before); }
  redo(): void { this.write(this.after); }
}

/** Edit a scalar/boolean normal-map parameter (strength or bump toggle) in one
 * undo step. Convention: caller already wrote `after` before pushing. */
export class MapParamEditCommand implements Command {
  readonly name = 'Edit Map Param';

  constructor(
    private readonly material: Material,
    private readonly field: 'normalStrength' | 'normalIsBump',
    private readonly before: number | boolean,
    private readonly after: number | boolean,
  ) {}

  private write(v: number | boolean): void {
    if (this.field === 'normalIsBump') this.material.normalIsBump = v as boolean;
    else this.material.normalStrength = v as number;
  }

  undo(): void { this.write(this.before); }
  redo(): void { this.write(this.after); }
}

/** UR8-3 C: toggle a material's `alwaysTextured` flag in one undo step. */
export class AlwaysTexturedEditCommand implements Command {
  readonly name = 'Toggle Always Textured';
  constructor(
    private readonly material: Material,
    private readonly before: boolean,
    private readonly after: boolean,
  ) {}
  undo(): void { this.material.alwaysTextured = this.before; }
  redo(): void { this.material.alwaysTextured = this.after; }
}

/** The field cluster a UR10-3 preset (Glass / Metal) sets in one shot. */
export interface MaterialPresetState {
  baseColor: [number, number, number];
  metallic: number;
  roughness: number;
  transmission: number;
  ior: number;
}

/** Read the preset-relevant fields off a material into a fresh snapshot. */
export function readPresetState(mat: Material): MaterialPresetState {
  return {
    baseColor: cloneRgb(mat.baseColor),
    metallic: mat.metallic,
    roughness: mat.roughness,
    transmission: mat.transmission ?? 0,
    ior: mat.ior ?? 1.45,
  };
}

/**
 * Apply a whole material preset (Glass / Metal) as ONE undo entry (UR10-3). The
 * command name is the preset label so undo reads "Apply Glass Preset". Convention:
 * caller has NOT yet mutated the material — perform() snapshots the before-state,
 * writes the after-state, and returns the command ready to push.
 */
export class MaterialPresetCommand implements Command {
  private constructor(
    readonly name: string,
    private readonly material: Material,
    private readonly before: MaterialPresetState,
    private readonly after: MaterialPresetState,
  ) {}

  static perform(name: string, material: Material, after: MaterialPresetState): MaterialPresetCommand {
    const before = readPresetState(material);
    const cmd = new MaterialPresetCommand(name, material, before, after);
    cmd.write(after);
    return cmd;
  }

  private write(s: MaterialPresetState): void {
    this.material.baseColor = cloneRgb(s.baseColor);
    this.material.metallic = s.metallic;
    this.material.roughness = s.roughness;
    this.material.transmission = s.transmission;
    this.material.ior = s.ior;
  }

  undo(): void { this.write(this.before); }
  redo(): void { this.write(this.after); }
}

// ------------------------------------------------------ shader / socket cmds --

/** Change a material's top-level shader (UR16-2) in one undo step. Undo restores
 *  both the shader and the `shadeless` flag (emit ⇒ shadeless). */
export class ShaderEditCommand implements Command {
  readonly name = 'Change Shader';
  constructor(
    private readonly material: Material,
    private readonly before: { shader?: MaterialShader; shadeless?: boolean; emissiveStrength?: number },
    private readonly after: { shader?: MaterialShader; shadeless?: boolean; emissiveStrength?: number },
  ) {}
  private write(s: { shader?: MaterialShader; shadeless?: boolean; emissiveStrength?: number }): void {
    this.material.shader = s.shader;
    this.material.shadeless = s.shadeless;
    if (s.emissiveStrength !== undefined) this.material.emissiveStrength = s.emissiveStrength;
  }
  undo(): void { this.write(this.before); }
  redo(): void { this.write(this.after); }
}

/** The socket-relevant fields of a material — snapshotted so a socket-kind or
 *  gradient change (which touches several fields at once) round-trips as ONE
 *  undo entry. */
export interface MatSocketSnap {
  shader?: MaterialShader;
  alpha?: ChannelInput<number>;
  colorGradient?: GradientInput;
  roughGradient?: GradientInput;
  metalGradient?: GradientInput;
  baseColor: [number, number, number];
  roughness: number;
  metallic: number;
  texKind: Material['texKind'];
  texDataUrl: string | null;
  texImage: TexImage | undefined;
  roughDataUrl: string | null;
  roughImage: TexImage | undefined;
  metalDataUrl: string | null;
  metalImage: TexImage | undefined;
  shadeless?: boolean;
}

/** Deep-copy the socket-relevant fields of a material. */
export function snapMaterialSockets(m: Material): MatSocketSnap {
  return {
    shader: m.shader,
    alpha: m.alpha ? cloneAlpha(m.alpha) : undefined,
    colorGradient: m.colorGradient ? cloneGradient(m.colorGradient) : undefined,
    roughGradient: m.roughGradient ? cloneGradient(m.roughGradient) : undefined,
    metalGradient: m.metalGradient ? cloneGradient(m.metalGradient) : undefined,
    baseColor: [m.baseColor[0], m.baseColor[1], m.baseColor[2]],
    roughness: m.roughness,
    metallic: m.metallic,
    texKind: m.texKind,
    texDataUrl: m.texDataUrl,
    texImage: m.texImage,
    roughDataUrl: m.roughDataUrl,
    roughImage: m.roughImage,
    metalDataUrl: m.metalDataUrl,
    metalImage: m.metalImage,
    shadeless: m.shadeless,
  };
}

function restoreMaterialSockets(m: Material, s: MatSocketSnap): void {
  m.shader = s.shader;
  m.alpha = s.alpha ? cloneAlpha(s.alpha) : undefined;
  m.colorGradient = s.colorGradient ? cloneGradient(s.colorGradient) : undefined;
  m.roughGradient = s.roughGradient ? cloneGradient(s.roughGradient) : undefined;
  m.metalGradient = s.metalGradient ? cloneGradient(s.metalGradient) : undefined;
  m.baseColor = [s.baseColor[0], s.baseColor[1], s.baseColor[2]];
  m.roughness = s.roughness;
  m.metallic = s.metallic;
  m.texKind = s.texKind;
  m.texDataUrl = s.texDataUrl;
  m.texImage = s.texImage;
  m.roughDataUrl = s.roughDataUrl;
  m.roughImage = s.roughImage;
  m.metalDataUrl = s.metalDataUrl;
  m.metalImage = s.metalImage;
  m.shadeless = s.shadeless;
}

/**
 * A socket-kind change or gradient edit as ONE undo entry (UR16-2). The socket
 * accessors (setMaterialChannel) mutate several material fields at once, so the
 * command snapshots the whole socket-relevant field set before + after.
 */
export class MaterialSocketCommand implements Command {
  private constructor(
    readonly name: string,
    private readonly material: Material,
    private readonly before: MatSocketSnap,
    private readonly after: MatSocketSnap,
  ) {}

  /** Snapshot before, run `mutate`, snapshot after. */
  static capture(name: string, material: Material, mutate: () => void): MaterialSocketCommand {
    const before = snapMaterialSockets(material);
    mutate();
    return new MaterialSocketCommand(name, material, before, snapMaterialSockets(material));
  }

  /** Build from a `before` snapshot taken earlier (the mutation already ran —
   *  e.g. live-preview gradient drags). Captures the current state as `after`. */
  static fromBefore(name: string, material: Material, before: MatSocketSnap): MaterialSocketCommand {
    return new MaterialSocketCommand(name, material, before, snapMaterialSockets(material));
  }

  undo(): void { restoreMaterialSockets(this.material, this.before); }
  redo(): void { restoreMaterialSockets(this.material, this.after); }
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

  /** Value captured when an input gained focus — the undo `before`. */
  private editBefore: MaterialFieldValue | null = null;
  /** Socket snapshot captured on focus for live-preview gradient/alpha edits. */
  private socketBefore: MatSocketSnap | null = null;
  /** Value captured when the normal-strength slider gained focus. */
  private strengthBefore: number | null = null;

  /** Guards concurrent decode-on-select of the same map (keyed matId:slot:len). */
  private readonly pendingDecode = new Set<string>();

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
    this.body.append(this.fields);

    container.append(this.empty, this.body);

    // Debug handle for e2e (mirrors __world).
    (window as unknown as Record<string, unknown>).__materialTab = {
      material: () => this.material(),
      // Legacy handles (kept for existing suites).
      loadTexture: (dataUrl: string) => this.setChannelImage('color', dataUrl),
      setMap: (slot: MapSlot, dataUrl: string) => this.loadMapFromDataUrl(slot, dataUrl),
      clearMap: (slot: MapSlot) => this.onMapClear(slot),
      applyPreset: (kind: 'glass' | 'metal') => this.applyPreset(kind),
      // UR16-2 socket/shader handles.
      setShader: (s: MaterialShader) => this.setShader(s),
      setChannelValue: (ch: MaterialChannelName) => this.setChannelValue(ch),
      setChannelImage: (ch: MaterialChannelName, dataUrl: string) => this.setChannelImage(ch, dataUrl),
      setGradient: (ch: MaterialChannelName, g: GradientInput) => this.setGradientExplicit(ch, g),
      setChecker: () => this.setChecker(),
      shaderLabels: () => ({ ...SHADER_LABELS }),
    };

    this.update();
  }

  // ---------------------------------------------------------------- update ---

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
    if (mat) this.ensureMapsDecoded(mat);
    const sig = this.signature(obj!, mat);
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    this.rebuild(obj!, mat);
  }

  private signature(obj: SceneObject, mat: Material | null): string {
    if (!mat) return `${obj.id}#-#${this.scene.materials.map((m) => `${m.id}:${m.name}`).join('|')}`;
    const g = (x?: GradientInput): string => (x ? `${x.axis}:${x.offset}:${x.scale}:${x.a.join(',')}:${x.b.join(',')}` : '-');
    const a = mat.alpha;
    const alphaSig = !a ? '1' : a.kind === 'value' ? `v${a.value}` : a.kind === 'gradient' ? `g${g(a)}` : `i`;
    return [
      obj.id, obj.materialId,
      this.scene.materials.map((m) => `${m.id}:${m.name}`).join('|'),
      materialShader(mat),
      `${rgbToHex(mat.baseColor)}:${mat.metallic}:${mat.roughness}:${mat.transmission ?? 0}:${mat.ior ?? 1.45}`,
      `${rgbToHex(mat.emissive)}:${mat.emissiveStrength}:${mat.subsurfaceWeight}:${mat.subsurfaceRadius}`,
      `${mat.texKind}:${mat.texDataUrl ? mat.texDataUrl.length : 0}:${mat.alwaysTextured === true}`,
      `${mat.normalDataUrl ? mat.normalDataUrl.length : 0}:${mat.normalIsBump}:${mat.normalStrength}`,
      `${mat.roughDataUrl ? mat.roughDataUrl.length : 0}:${mat.metalDataUrl ? mat.metalDataUrl.length : 0}`,
      `${g(mat.colorGradient)}#${g(mat.roughGradient)}#${g(mat.metalGradient)}#${alphaSig}`,
      `${mat.bakeRes ?? 128}`,
    ].join('#');
  }

  private isPanelFocused(): boolean {
    const active = document.activeElement;
    return (
      (active instanceof HTMLInputElement || active instanceof HTMLSelectElement) &&
      this.body.contains(active)
    );
  }

  // -------------------------------------------------------------- rebuild ---

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

    this.fields.replaceChildren();
    this.fields.style.display = mat ? '' : 'none';
    if (!mat) return;

    const shader = materialShader(mat);

    // (1) Shader row — the socket circle opens the chooser.
    this.fields.append(this.buildShaderRow(shader));

    // (2) Name row.
    this.fields.append(this.buildNameRow(mat));

    // (3) Channel rows for this shader.
    for (const ch of channelsForShader(shader)) {
      this.fields.append(this.buildChannelRow(mat, ch));
      // Always Textured sits next to the color row (super / image planes).
      if (ch === 'color') {
        const at = this.buildAlwaysTexturedRow(mat, shader);
        if (at) this.fields.append(at);
      }
      // A gradient channel expands an indented sub-row directly under it.
      const input = getMaterialChannel(mat, ch);
      if (input.kind === 'gradient') this.fields.append(this.buildGradientSubrow(mat, ch, input));
    }

    // (4) Shader-specific value-only rows.
    if (shader === 'glass') this.fields.append(this.buildIorRow(mat));
    if (shader === 'emit') this.fields.append(this.buildStrengthRow(mat));

    // (5) Super shader extras.
    if (shader === 'super') this.buildSuperExtras(mat);
  }

  // ---------------------------------------------------------- row builders ---

  private buildShaderRow(shader: MaterialShader): HTMLElement {
    const socket = socketButton('value', (btn) => this.openShaderChooser(btn));
    socket.classList.add('material-tab-shader-socket');
    socket.title = 'Choose shader';
    const value = document.createElement('button');
    value.type = 'button';
    value.className = 'prop-value-btn material-tab-shader-value';
    value.textContent = SHADER_LABELS[shader];
    value.style.cssText = 'flex:1;min-width:0;text-align:left;background:#333;color:#ddd;border:1px solid rgba(255,255,255,0.15);border-radius:3px;cursor:pointer;padding:0 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    value.addEventListener('click', () => this.openShaderChooser(value));
    return propRow({ label: 'Shader', socket, controls: [value], rowClass: 'material-tab-shader-row' });
  }

  private buildNameRow(mat: Material): HTMLElement {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'material-tab-name';
    inp.value = mat.name;
    this.wireField(inp, 'name', () => inp.value, () => this.material()?.name ?? '');
    return propRow({ label: 'Name', controls: [inp] });
  }

  private buildChannelRow(mat: Material, ch: MaterialChannelName): HTMLElement {
    const input = getMaterialChannel(mat, ch);
    const socket = socketButton(input.kind, (btn) => this.openChannelSocketMenu(btn, ch));
    socket.title = `${LABELS[ch]} input`;
    const controls: HTMLElement[] = [];

    if (ch === 'color') {
      const swatch = document.createElement('input');
      swatch.type = 'color';
      swatch.className = 'material-tab-basecolor';
      swatch.value = rgbToHex(mat.baseColor);
      this.wireField(swatch, 'baseColor', () => hexToRgb(swatch.value), () => this.material()?.baseColor ?? [0, 0, 0]);
      controls.push(swatch, this.keyButton('material-tab-key-basecolor', 'Insert Base Color keyframe',
        ['material.baseColor.r', 'material.baseColor.g', 'material.baseColor.b']));
      if (input.kind === 'image') controls.push(...this.imageControls('color', mat.texDataUrl, 'material-tab-texfile', 'material-tab-texthumb'));
    } else if (ch === 'alpha') {
      controls.push(...this.alphaControls(mat, input as ChannelInput<number>));
    } else {
      // roughness / metallic scalar slider + numeric readout.
      const field = ch as 'roughness' | 'metallic';
      const num = document.createElement('span');
      num.className = 'prop-num';
      const slider = this.slider(`material-tab-${field}`);
      slider.value = String(mat[field]);
      num.textContent = mat[field].toFixed(2);
      this.wireField(slider, field, () => parseFloat(slider.value), () => this.material()?.[field] ?? 0,
        () => { num.textContent = Number(slider.value).toFixed(2); });
      controls.push(slider, num);
      if (ch === 'roughness') controls.push(this.keyButton('material-tab-key-roughness', 'Insert Roughness keyframe', ['material.roughness']));
      if (input.kind === 'image') {
        const url = field === 'roughness' ? mat.roughDataUrl : mat.metalDataUrl;
        controls.push(...this.imageControls(field, url, `material-tab-${field}file`, `material-tab-${field}thumb`));
      }
    }

    return propRow({ label: LABELS[ch], socket, controls, data: { channel: ch } });
  }

  /** File re-pick + thumbnail + clear for an image-kind channel. */
  private imageControls(ch: MaterialChannelName, dataUrl: string | null, fileCls: string, thumbCls: string): HTMLElement[] {
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = 'image/*';
    file.className = `material-tab-mapfile ${fileCls}`;
    file.style.cssText = 'flex:1;min-width:0;';
    file.addEventListener('change', () => {
      const f = file.files?.[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => { void this.setChannelImage(ch, String(reader.result)); };
      reader.readAsDataURL(f);
    });
    const thumb = document.createElement('img');
    thumb.className = `material-tab-texthumb ${thumbCls}`;
    thumb.alt = LABELS[ch];
    if (dataUrl) { thumb.src = dataUrl; } else thumb.style.display = 'none';
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'material-tab-mapclear';
    clear.textContent = '✕';
    clear.title = `Clear ${LABELS[ch]} image`;
    clear.style.cssText = 'flex:none;cursor:pointer;line-height:1;padding:0 6px;';
    clear.addEventListener('click', () => this.setChannelValue(ch));
    return [file, thumb, clear];
  }

  /** Alpha value slider (0..1) + numeric readout, editing mat.alpha as a value. */
  private alphaControls(mat: Material, input: ChannelInput<number>): HTMLElement[] {
    const num = document.createElement('span');
    num.className = 'prop-num';
    const slider = this.slider('material-tab-alpha');
    const cur = input.kind === 'value' ? input.value : 1;
    slider.value = String(cur);
    num.textContent = cur.toFixed(2);
    slider.disabled = input.kind === 'gradient';
    slider.addEventListener('focus', () => { this.socketBefore = mat ? snapMaterialSockets(this.material()!) : null; });
    slider.addEventListener('input', () => {
      const m = this.material();
      if (!m) return;
      if (this.socketBefore === null) this.socketBefore = snapMaterialSockets(m);
      m.alpha = { kind: 'value', value: parseFloat(slider.value) };
      num.textContent = Number(slider.value).toFixed(2);
    });
    slider.addEventListener('change', () => {
      const m = this.material();
      if (!m) { this.socketBefore = null; return; }
      m.alpha = { kind: 'value', value: parseFloat(slider.value) };
      const before = this.socketBefore ?? snapMaterialSockets(m);
      this.socketBefore = null;
      this.undo.push(MaterialSocketCommand.fromBefore('Edit Alpha', m, before));
      this.lastSig = null;
    });
    return [slider, num];
  }

  private buildAlwaysTexturedRow(mat: Material, shader: MaterialShader): HTMLElement | null {
    // Meaningful only with an image color OR the everything shader.
    if (!(mat.texKind === 'image' || shader === 'super')) return null;
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'material-tab-always-textured';
    check.checked = mat.alwaysTextured === true;
    check.addEventListener('change', () => this.onAlwaysTexturedToggle(check.checked));
    return propRow({ label: 'Always Textured', controls: [check] });
  }

  private buildIorRow(mat: Material): HTMLElement {
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.className = 'material-tab-ior';
    inp.min = '1'; inp.max = '2.5'; inp.step = '0.01';
    inp.value = String(mat.ior ?? 1.45);
    inp.title = 'Index of refraction (1.0–2.5).';
    this.wireField(inp, 'ior', () => Math.max(1, Math.min(2.5, parseFloat(inp.value))), () => this.material()?.ior ?? 1.45);
    return propRow({ label: 'IOR', controls: [inp], rowClass: 'material-tab-ior-row' });
  }

  private buildStrengthRow(mat: Material): HTMLElement {
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.className = 'material-tab-emissive-strength';
    inp.min = '0'; inp.max = '100'; inp.step = '0.1';
    inp.value = String(mat.emissiveStrength);
    inp.title = 'Emission strength (0–100).';
    this.wireField(inp, 'emissiveStrength', () => Math.max(0, Math.min(100, parseFloat(inp.value))), () => this.material()?.emissiveStrength ?? 0);
    return propRow({ label: 'Strength', controls: [inp], rowClass: 'material-tab-strength-row' });
  }

  private buildGradientSubrow(mat: Material, ch: MaterialChannelName, g: GradientInput): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'prop-subrow material-tab-gradient';
    wrap.dataset.channel = ch;

    // Endpoints A / B.
    const endpoints = document.createElement('div');
    endpoints.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const mkEndpoint = (which: 'a' | 'b'): HTMLElement => {
      if (ch === 'color') {
        const sw = document.createElement('input');
        sw.type = 'color';
        sw.className = `material-tab-grad-${which}`;
        sw.value = rgbToHex(g[which]);
        this.wireGradient(mat, ch, sw, (grad) => { grad[which] = hexToRgb(sw.value); });
        return sw;
      }
      const n = document.createElement('input');
      n.type = 'number'; n.min = '0'; n.max = '1'; n.step = '0.01';
      n.className = `material-tab-grad-${which}`;
      n.value = String(g[which][0]);
      this.wireGradient(mat, ch, n, (grad) => { const v = Math.max(0, Math.min(1, parseFloat(n.value))); grad[which] = [v, v, v]; });
      return n;
    };
    const la = document.createElement('span'); la.textContent = 'A'; la.style.opacity = '0.7';
    const lb = document.createElement('span'); lb.textContent = 'B'; lb.style.opacity = '0.7';
    endpoints.append(la, mkEndpoint('a'), lb, mkEndpoint('b'));
    wrap.append(endpoints);

    // Axis segmented X | Y | Z.
    const axisRow = document.createElement('div');
    axisRow.className = 'material-tab-grad-axis';
    axisRow.style.cssText = 'display:flex;gap:0;';
    for (const ax of ['x', 'y', 'z'] as const) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'material-tab-grad-axis-btn' + (g.axis === ax ? ' is-active' : '');
      b.dataset.axis = ax;
      b.textContent = ax.toUpperCase();
      b.style.cssText = `flex:1;cursor:pointer;padding:2px 0;border:1px solid rgba(255,255,255,0.15);background:${g.axis === ax ? '#e8a33d' : '#333'};color:${g.axis === ax ? '#000' : '#ccc'};`;
      b.addEventListener('click', () => {
        const m = this.material();
        if (!m) return;
        this.undo.push(MaterialSocketCommand.capture('Gradient Axis', m, () => {
          const grad = getMaterialChannel(m, ch);
          if (grad.kind === 'gradient') grad.axis = ax;
        }));
        this.lastSig = null;
      });
      axisRow.append(b);
    }
    wrap.append(axisRow);

    // Offset / Scale numerics.
    const os = document.createElement('div');
    os.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const mkNum = (label: string, cls: string, val: number, apply: (grad: GradientInput, v: number) => void): void => {
      const l = document.createElement('span'); l.textContent = label; l.style.opacity = '0.7';
      const n = document.createElement('input');
      n.type = 'number'; n.step = '0.05'; n.className = cls; n.value = String(val);
      n.style.cssText = 'width:64px;';
      this.wireGradient(mat, ch, n, (grad) => apply(grad, parseFloat(n.value)));
      os.append(l, n);
    };
    mkNum('Off', 'material-tab-grad-offset', g.offset, (grad, v) => { grad.offset = Number.isFinite(v) ? v : 0; });
    mkNum('Scl', 'material-tab-grad-scale', g.scale, (grad, v) => { grad.scale = Number.isFinite(v) ? v : 1; });
    wrap.append(os);

    return wrap;
  }

  /** Wire a gradient sub-control: capture before on focus, live-mutate on input,
   *  commit ONE MaterialSocketCommand on change. */
  private wireGradient(mat: Material, ch: MaterialChannelName, el: HTMLInputElement, mutate: (g: GradientInput) => void): void {
    el.addEventListener('focus', () => { this.socketBefore = snapMaterialSockets(this.material() ?? mat); });
    el.addEventListener('input', () => {
      const m = this.material();
      if (!m) return;
      if (this.socketBefore === null) this.socketBefore = snapMaterialSockets(m);
      const g = getMaterialChannel(m, ch);
      if (g.kind === 'gradient') mutate(g);
    });
    el.addEventListener('change', () => {
      const m = this.material();
      if (!m) { this.socketBefore = null; return; }
      const g = getMaterialChannel(m, ch);
      if (g.kind === 'gradient') mutate(g);
      const before = this.socketBefore ?? snapMaterialSockets(m);
      this.socketBefore = null;
      this.undo.push(MaterialSocketCommand.fromBefore('Edit Gradient', m, before));
      this.lastSig = null;
    });
  }

  private buildSuperExtras(mat: Material): void {
    // Emissive color + strength.
    const emis = document.createElement('input');
    emis.type = 'color';
    emis.className = 'material-tab-emissive';
    emis.value = rgbToHex(mat.emissive);
    this.wireField(emis, 'emissive', () => hexToRgb(emis.value), () => this.material()?.emissive ?? [0, 0, 0]);
    this.fields.append(propRow({ label: 'Emissive', controls: [emis] }));
    this.fields.append(this.buildStrengthRow(mat));

    // Subsurface weight + radius.
    const ssNum = document.createElement('span'); ssNum.className = 'prop-num';
    const ss = this.slider('material-tab-subsurface');
    ss.value = String(mat.subsurfaceWeight); ssNum.textContent = mat.subsurfaceWeight.toFixed(2);
    this.wireField(ss, 'subsurfaceWeight', () => parseFloat(ss.value), () => this.material()?.subsurfaceWeight ?? 0,
      () => { ssNum.textContent = Number(ss.value).toFixed(2); });
    this.fields.append(propRow({ label: 'Subsurface', controls: [ss, ssNum] }));

    const ssr = document.createElement('input');
    ssr.type = 'number'; ssr.min = '0'; ssr.step = '0.01';
    ssr.className = 'material-tab-subsurface-radius';
    ssr.value = String(mat.subsurfaceRadius);
    this.wireField(ssr, 'subsurfaceRadius', () => Math.max(0, parseFloat(ssr.value)), () => this.material()?.subsurfaceRadius ?? 0.05);
    this.fields.append(propRow({ label: 'SSS Radius', controls: [ssr] }));

    // Normal / bump map — joins the material as its own row + sub-row.
    this.buildNormalRows(mat);

    // Nodes — bake resolution.
    const nodesHeading = document.createElement('div');
    nodesHeading.className = 'material-tab-nodes-title properties-group-title';
    nodesHeading.textContent = 'Nodes';
    nodesHeading.style.marginTop = '8px';
    this.fields.append(nodesHeading);

    const bake = document.createElement('select');
    bake.className = 'material-tab-bakeres';
    for (const r of [128, 256, 512, 1024]) {
      const opt = document.createElement('option');
      opt.value = String(r); opt.textContent = `${r}×${r}`;
      bake.append(opt);
    }
    bake.value = String(mat.bakeRes ?? 128);
    bake.addEventListener('change', () => this.onBakeResChange(Number(bake.value)));
    this.fields.append(propRow({ label: 'Bake Res', controls: [bake] }));
  }

  private buildNormalRows(mat: Material): void {
    const file = document.createElement('input');
    file.type = 'file'; file.accept = 'image/*';
    file.className = 'material-tab-mapfile material-tab-normalfile';
    file.style.cssText = 'flex:1;min-width:0;';
    file.addEventListener('change', () => this.onMapFile('normal', file));
    const thumb = document.createElement('img');
    thumb.className = 'material-tab-texthumb material-tab-normalthumb';
    thumb.alt = 'Normal';
    if (mat.normalDataUrl) thumb.src = mat.normalDataUrl; else thumb.style.display = 'none';
    const clear = document.createElement('button');
    clear.type = 'button'; clear.className = 'material-tab-mapclear'; clear.textContent = '✕';
    clear.title = 'Clear Normal map';
    clear.style.cssText = 'flex:none;cursor:pointer;line-height:1;padding:0 6px;';
    clear.addEventListener('click', () => this.onMapClear('normal'));
    const socket = socketButton(mat.normalDataUrl ? 'image' : 'value', () => file.click());
    socket.title = 'Normal map';
    this.fields.append(propRow({ label: 'Normal', socket, controls: [file, thumb, clear], data: { channel: 'normal' } }));

    // Bump + Strength sub-row.
    const bump = document.createElement('input');
    bump.type = 'checkbox'; bump.className = 'material-tab-normal-bump';
    bump.checked = mat.normalIsBump;
    bump.addEventListener('change', () => this.onBumpToggle(bump.checked));
    this.fields.append(propRow({ label: 'Bump (height)', controls: [bump] }));

    const num = document.createElement('span'); num.className = 'prop-num';
    const strength = document.createElement('input');
    strength.type = 'range'; strength.className = 'material-tab-normal-strength';
    strength.min = '0'; strength.max = '2'; strength.step = '0.05';
    strength.value = String(mat.normalStrength);
    num.textContent = mat.normalStrength.toFixed(2);
    this.wireStrength(strength, num);
    this.fields.append(propRow({ label: 'Strength', controls: [strength, num] }));
  }

  // -------------------------------------------------------- socket actions ---

  private openShaderChooser(anchor: HTMLElement): void {
    const mat = this.material();
    if (!mat) return;
    const cur = materialShader(mat);
    new Popover(anchor, MATERIAL_SHADERS.map((s) => ({
      label: SHADER_LABELS[s],
      active: s === cur,
      data: { shader: s },
      run: () => this.setShader(s),
    })), { itemClass: 'material-shader-option' });
  }

  private openChannelSocketMenu(anchor: HTMLElement, ch: MaterialChannelName): void {
    const mat = this.material();
    if (!mat) return;
    const cur = getMaterialChannel(mat, ch).kind;
    const items = [
      { label: ch === 'color' ? 'Color' : 'Value', active: cur === 'value', data: { kind: 'value' }, run: () => this.setChannelValue(ch) },
    ];
    if (ch !== 'alpha') items.push({ label: 'Image', active: cur === 'image', data: { kind: 'image' }, run: () => this.pickChannelImage(ch) });
    items.push({ label: 'Gradient', active: cur === 'gradient', data: { kind: 'gradient' }, run: () => this.setChannelGradient(ch) });
    new Popover(anchor, items, { itemClass: 'material-socket-option' });
  }

  private setShader(s: MaterialShader): void {
    const mat = this.material();
    if (!mat) return;
    const before = { shader: mat.shader, shadeless: mat.shadeless, emissiveStrength: mat.emissiveStrength };
    // UR16-4: switching TO emit defaults the light strength to 1 (exact pixels)
    // when it was 0, so the surface shows its color socket instead of going black.
    const emitStrength = s === 'emit' && !(mat.emissiveStrength > 0) ? 1 : mat.emissiveStrength;
    const after = { shader: s, shadeless: s === 'emit', emissiveStrength: emitStrength };
    if (before.shader === after.shader && (before.shadeless ?? false) === after.shadeless) return;
    mat.shader = after.shader;
    mat.shadeless = after.shadeless;
    mat.emissiveStrength = after.emissiveStrength;
    this.undo.push(new ShaderEditCommand(mat, before, after));
    this.lastSig = null;
  }

  private setChannelValue(ch: MaterialChannelName): void {
    const mat = this.material();
    if (!mat) return;
    let value: [number, number, number] | number;
    if (ch === 'color') value = [mat.baseColor[0], mat.baseColor[1], mat.baseColor[2]];
    else if (ch === 'roughness') value = mat.roughness;
    else if (ch === 'metallic') value = mat.metallic;
    else value = mat.alpha && mat.alpha.kind === 'value' ? mat.alpha.value : 1;
    this.undo.push(MaterialSocketCommand.capture(`Set ${LABELS[ch]} Value`, mat, () => {
      setMaterialChannel(mat, ch, { kind: 'value', value } as ChannelInput<[number, number, number]> | ChannelInput<number>);
      if (ch === 'color') mat.texImage = undefined;
      else if (ch === 'roughness') mat.roughImage = undefined;
      else if (ch === 'metallic') mat.metalImage = undefined;
    }));
    this.lastSig = null;
  }

  private setChannelGradient(ch: MaterialChannelName): void {
    const mat = this.material();
    if (!mat) return;
    this.undo.push(MaterialSocketCommand.capture(`Set ${LABELS[ch]} Gradient`, mat, () => {
      setMaterialChannel(mat, ch, this.defaultGradient(mat, ch) as ChannelInput<[number, number, number]> | ChannelInput<number>);
    }));
    this.lastSig = null;
  }

  private setGradientExplicit(ch: MaterialChannelName, g: GradientInput): void {
    const mat = this.material();
    if (!mat) return;
    this.undo.push(MaterialSocketCommand.capture(`Set ${LABELS[ch]} Gradient`, mat, () => {
      setMaterialChannel(mat, ch, cloneGradient(g) as ChannelInput<[number, number, number]> | ChannelInput<number>);
    }));
    this.lastSig = null;
  }

  private defaultGradient(mat: Material, ch: MaterialChannelName): GradientInput {
    if (ch === 'color') {
      const a: [number, number, number] = [mat.baseColor[0], mat.baseColor[1], mat.baseColor[2]];
      const b: [number, number, number] = [1 - a[0], 1 - a[1], 1 - a[2]];
      return { kind: 'gradient', a, b, axis: 'z', offset: 0.5, scale: 0.5 };
    }
    const v = ch === 'roughness' ? mat.roughness : ch === 'metallic' ? mat.metallic : (mat.alpha && mat.alpha.kind === 'value' ? mat.alpha.value : 1);
    return { kind: 'gradient', a: [v, v, v], b: [1 - v, 1 - v, 1 - v], axis: 'z', offset: 0.5, scale: 0.5 };
  }

  private pickChannelImage(ch: MaterialChannelName): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      if (!f) { input.remove(); return; }
      const reader = new FileReader();
      reader.onload = () => { void this.setChannelImage(ch, String(reader.result)); input.remove(); };
      reader.readAsDataURL(f);
    });
    document.body.appendChild(input);
    input.click();
  }

  /** Load an image into a channel's socket (color = sRGB decode, rough/metal =
   *  RAW decode) in ONE undo step, clearing any gradient on that channel. */
  async setChannelImage(ch: MaterialChannelName, dataUrl: string): Promise<void> {
    const mat = this.material();
    if (!mat) return;
    const decode = ch === 'color' ? decodeTextureDataUrl : decodeRawTextureDataUrl;
    let image: TexImage;
    try { image = await decode(dataUrl); } catch { return; }
    if (this.material() !== mat) return;
    const before = snapMaterialSockets(mat);
    setMaterialChannel(mat, ch, { kind: 'image', dataUrl } as ChannelInput<[number, number, number]> | ChannelInput<number>);
    if (ch === 'color') mat.texImage = image;
    else if (ch === 'roughness') mat.roughImage = image;
    else if (ch === 'metallic') mat.metalImage = image;
    this.undo.push(MaterialSocketCommand.fromBefore(`Set ${LABELS[ch]} Image`, mat, before));
    this.lastSig = null;
  }

  /** Set the color channel to the procedural checker (legacy texKind). */
  private setChecker(): void {
    const mat = this.material();
    if (!mat) return;
    this.undo.push(MaterialSocketCommand.capture('Set Checker', mat, () => {
      mat.colorGradient = undefined;
      mat.texKind = 'checker';
      mat.texDataUrl = null;
      mat.texImage = undefined;
    }));
    this.lastSig = null;
  }

  // ----------------------------------------------------- shared value wiring --

  private slider(cls: string): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'range';
    input.className = cls;
    input.min = '0';
    input.max = '1';
    input.step = '0.01';
    return input;
  }

  private keyButton(className: string, title: string, channels: string[]): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `material-tab-key-btn ${className}`;
    btn.textContent = '●';
    btn.title = title;
    btn.style.cssText =
      'flex:none;margin-left:2px;background:none;border:none;color:#e8a33d;cursor:pointer;font-size:11px;line-height:1;padding:2px 3px;';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const obj = this.scene.activeObject;
      if (!obj || obj.kind !== 'mesh') return;
      const cmd = InsertKeysCommand.perform(title, this.scene, [obj], channels, this.scene.frameCurrent);
      if (cmd) this.undo.push(cmd);
    });
    return btn;
  }

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
    this.applyLive(mat, field, after);

    if (this.valuesEqual(before, after)) { this.lastSig = null; return; }
    this.undo.push(new MaterialEditCommand(mat, field, before, after));
    this.lastSig = null;
  }

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

  private applyPreset(kind: 'glass' | 'metal'): void {
    const mat = this.material();
    if (!mat) return;
    let after: MaterialPresetState;
    let name: string;
    if (kind === 'glass') {
      after = { baseColor: [0.95, 0.95, 0.95], metallic: 0, roughness: 0, transmission: 1, ior: 1.45 };
      name = 'Apply Glass Preset';
    } else {
      after = { baseColor: cloneRgb(mat.baseColor), metallic: 1, roughness: 0.15, transmission: 0, ior: mat.ior ?? 1.45 };
      name = 'Apply Metal Preset';
    }
    this.undo.push(MaterialPresetCommand.perform(name, mat, after));
    this.lastSig = null;
  }

  private onAlwaysTexturedToggle(checked: boolean): void {
    const mat = this.material();
    if (!mat) return;
    const before = mat.alwaysTextured === true;
    if (before === checked) return;
    mat.alwaysTextured = checked;
    this.undo.push(new AlwaysTexturedEditCommand(mat, before, checked));
    this.lastSig = null;
  }

  private onBakeResChange(after: number): void {
    const mat = this.material();
    if (!mat) return;
    const before = mat.bakeRes ?? 128;
    if (before === after) return;
    mat.bakeRes = after;
    this.undo.push(new MaterialEditCommand(mat, 'bakeRes', before, after));
    this.lastSig = null;
  }

  // ------------------------------------------------------------ map slots ----

  private wireStrength(input: HTMLInputElement, num: HTMLSpanElement): void {
    input.addEventListener('focus', () => { this.strengthBefore = this.material()?.normalStrength ?? null; });
    input.addEventListener('input', () => {
      const mat = this.material();
      if (!mat) return;
      if (this.strengthBefore === null) this.strengthBefore = mat.normalStrength;
      mat.normalStrength = parseFloat(input.value);
      num.textContent = Number(input.value).toFixed(2);
    });
    input.addEventListener('change', () => {
      const mat = this.material();
      if (!mat) { this.strengthBefore = null; return; }
      const after = parseFloat(input.value);
      const before = this.strengthBefore ?? after;
      this.strengthBefore = null;
      if (!Number.isFinite(after)) { this.lastSig = null; return; }
      mat.normalStrength = after;
      if (before === after) { this.lastSig = null; return; }
      this.undo.push(new MapParamEditCommand(mat, 'normalStrength', before, after));
      this.lastSig = null;
    });
  }

  private onBumpToggle(checked: boolean): void {
    const mat = this.material();
    if (!mat) return;
    const before = mat.normalIsBump;
    if (before === checked) return;
    mat.normalIsBump = checked;
    this.undo.push(new MapParamEditCommand(mat, 'normalIsBump', before, checked));
    this.lastSig = null;
  }

  private onMapFile(slot: MapSlot, input: HTMLInputElement): void {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { void this.loadMapFromDataUrl(slot, String(reader.result)); };
    reader.readAsDataURL(file);
  }

  private onMapClear(slot: MapSlot): void {
    const mat = this.material();
    if (!mat) return;
    if (mat[MAP_URL_FIELD[slot]] === null && mat[MAP_IMG_FIELD[slot]] === undefined) return;
    const before = this.mapState(mat, slot);
    mat[MAP_URL_FIELD[slot]] = null;
    mat[MAP_IMG_FIELD[slot]] = undefined;
    this.undo.push(new MapImageEditCommand(mat, slot, before, this.mapState(mat, slot)));
    this.lastSig = null;
  }

  private mapState(mat: Material, slot: MapSlot): MapImgState {
    return { dataUrl: mat[MAP_URL_FIELD[slot]], image: mat[MAP_IMG_FIELD[slot]] };
  }

  async loadMapFromDataUrl(slot: MapSlot, dataUrl: string): Promise<void> {
    const mat = this.material();
    if (!mat) return;
    const image = await decodeRawTextureDataUrl(dataUrl);
    if (this.material() !== mat) return;
    const before = this.mapState(mat, slot);
    mat[MAP_URL_FIELD[slot]] = dataUrl;
    mat[MAP_IMG_FIELD[slot]] = image;
    this.undo.push(new MapImageEditCommand(mat, slot, before, this.mapState(mat, slot)));
    this.lastSig = null;
  }

  private ensureMapsDecoded(mat: Material): void {
    for (const slot of ['normal', 'rough', 'metal'] as MapSlot[]) {
      const url = mat[MAP_URL_FIELD[slot]];
      if (!url || mat[MAP_IMG_FIELD[slot]]) continue;
      const key = `${mat.id}:${slot}:${url.length}`;
      if (this.pendingDecode.has(key)) continue;
      this.pendingDecode.add(key);
      decodeRawTextureDataUrl(url)
        .then((decoded) => {
          if (mat[MAP_URL_FIELD[slot]] === url) mat[MAP_IMG_FIELD[slot]] = decoded;
          this.pendingDecode.delete(key);
          this.lastSig = null;
        })
        .catch(() => { this.pendingDecode.delete(key); });
    }
    // Also decode a present-but-uncached color texture (so socket→image after a
    // scene load fills the tracer cache).
    if (mat.texKind === 'image' && mat.texDataUrl && !mat.texImage) {
      const key = `${mat.id}:color:${mat.texDataUrl.length}`;
      if (!this.pendingDecode.has(key)) {
        this.pendingDecode.add(key);
        const url = mat.texDataUrl;
        decodeTextureDataUrl(url)
          .then((decoded) => {
            if (mat.texDataUrl === url) mat.texImage = decoded;
            this.pendingDecode.delete(key);
            this.lastSig = null;
          })
          .catch(() => { this.pendingDecode.delete(key); });
      }
    }
  }

  async loadTextureFromDataUrl(dataUrl: string): Promise<void> {
    return this.setChannelImage('color', dataUrl);
  }
}

// Registered at module load so any PropertiesEditor built afterward includes it.
registerPropertiesTab({
  id: 'material',
  icon: '🎨',
  title: 'Material',
  build: (container, ctx) => new MaterialTab(container, ctx.scene, ctx.undo),
});
