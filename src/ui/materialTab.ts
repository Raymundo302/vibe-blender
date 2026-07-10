import type { Scene, SceneObject } from '../core/scene/Scene';
import type { UndoStack, Command } from '../core/undo/UndoStack';
import type { Material } from '../core/scene/objectData';
import { srgbToLinear } from '../core/scene/worldData';
import { registerPropertiesTab } from './propertiesEditor';
import { InsertKeysCommand } from '../core/anim/animCommands';
import './materialTab.css';

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
  | 'name' | 'baseColor' | 'metallic' | 'roughness' | 'emissive' | 'emissiveStrength'
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
  private texKindSelect!: HTMLSelectElement;
  private bakeResSelect!: HTMLSelectElement;
  private texImageRow!: HTMLElement;
  private texFileInput!: HTMLInputElement;
  private texThumb!: HTMLImageElement;

  // P13 map slots.
  private normalThumb!: HTMLImageElement;
  private normalBumpCheck!: HTMLInputElement;
  private normalStrengthInput!: HTMLInputElement;
  private normalStrengthNum!: HTMLSpanElement;
  private roughThumb!: HTMLImageElement;
  private metalThumb!: HTMLImageElement;

  /** Value captured when the normal-strength slider gained focus. */
  private strengthBefore: number | null = null;

  /** Guards concurrent decode-on-select of the same map (keyed matId:slot:len). */
  private readonly pendingDecode = new Set<string>();

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

    // Debug handle for e2e (mirrors __world). Lets a suite drive an image-texture
    // load with a generated data URL instead of a real file dialog.
    (window as unknown as Record<string, unknown>).__materialTab = {
      material: () => this.material(),
      loadTexture: (dataUrl: string) => this.loadTextureFromDataUrl(dataUrl),
      setMap: (slot: MapSlot, dataUrl: string) => this.loadMapFromDataUrl(slot, dataUrl),
      clearMap: (slot: MapSlot) => this.onMapClear(slot),
    };

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
    this.fields.append(this.fieldRow('Base Color', this.baseColorInput,
      this.keyButton('material-tab-key-basecolor', 'Insert Base Color keyframe',
        ['material.baseColor.r', 'material.baseColor.g', 'material.baseColor.b'])));

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
    this.fields.append(this.fieldRow('Roughness', this.roughnessInput, this.roughnessNum,
      this.keyButton('material-tab-key-roughness', 'Insert Roughness keyframe', ['material.roughness'])));

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

    // Texture kind (None / Checker / Image) — the base-color texture through UVs.
    this.texKindSelect = document.createElement('select');
    this.texKindSelect.className = 'material-tab-texkind';
    for (const [value, label] of [['none', 'None'], ['checker', 'Checker'], ['image', 'Image']] as const) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      this.texKindSelect.append(opt);
    }
    this.texKindSelect.addEventListener('change', () => this.onTexKindChange());
    this.fields.append(this.fieldRow('Texture', this.texKindSelect));

    // Image row: file picker + thumbnail <img> (NOT a canvas). Shown only when
    // texKind === 'image'.
    this.texFileInput = document.createElement('input');
    this.texFileInput.type = 'file';
    this.texFileInput.accept = 'image/*';
    this.texFileInput.className = 'material-tab-texfile';
    this.texFileInput.addEventListener('change', () => this.onTexFile());
    this.texThumb = document.createElement('img');
    this.texThumb.className = 'material-tab-texthumb';
    this.texThumb.alt = 'texture';
    this.texImageRow = this.fieldRow('Image', this.texFileInput, this.texThumb);
    this.fields.append(this.texImageRow);

    this.buildMapFields();

    // Node-bake resolution (P16 follow-up). The Rendered viewport bakes a
    // useNodes graph to `bakeRes`² textures; higher = crisper procedural detail,
    // slower to bake. Default 128 keeps a graph edit under a few ms.
    const nodesHeading = document.createElement('div');
    nodesHeading.className = 'material-tab-nodes-title properties-group-title';
    nodesHeading.textContent = 'Nodes';
    this.fields.append(nodesHeading);

    this.bakeResSelect = document.createElement('select');
    this.bakeResSelect.className = 'material-tab-bakeres';
    for (const r of [128, 256, 512, 1024]) {
      const opt = document.createElement('option');
      opt.value = String(r);
      opt.textContent = `${r}×${r}`;
      this.bakeResSelect.append(opt);
    }
    this.bakeResSelect.addEventListener('change', () => this.onBakeResChange());
    this.fields.append(this.fieldRow('Bake Res', this.bakeResSelect));
  }

  /** Change the material's node-bake resolution in one undo step. Bumps nothing
   *  else — ensureBaked re-bakes because its cache key includes the size. */
  private onBakeResChange(): void {
    const mat = this.material();
    if (!mat) return;
    const after = Number(this.bakeResSelect.value);
    const before = mat.bakeRes ?? 128;
    if (before === after) return;
    mat.bakeRes = after;
    this.undo.push(new MaterialEditCommand(mat, 'bakeRes', before, after));
    this.lastSig = null;
  }

  /** P13 map-slot UI: Normal Map (file + Bump toggle + Strength), Roughness Map,
   * Metallic Map. All rows follow the existing fieldRow pattern. */
  private buildMapFields(): void {
    const heading = document.createElement('div');
    heading.className = 'material-tab-maps-title properties-group-title';
    heading.textContent = 'Maps';
    this.fields.append(heading);

    // --- Normal Map: file + thumb + clear ---
    const normal = this.mapRow('Normal', 'normal');
    this.normalThumb = normal.thumb;

    // Bump (height) checkbox → normalIsBump.
    this.normalBumpCheck = document.createElement('input');
    this.normalBumpCheck.type = 'checkbox';
    this.normalBumpCheck.className = 'material-tab-normal-bump';
    this.normalBumpCheck.addEventListener('change', () => this.onBumpToggle());
    this.fields.append(this.fieldRow('Bump (height)', this.normalBumpCheck));

    // Strength slider 0..2 step 0.05 → normalStrength, with numeric readout.
    this.normalStrengthNum = document.createElement('span');
    this.normalStrengthNum.className = 'material-tab-num';
    this.normalStrengthInput = document.createElement('input');
    this.normalStrengthInput.type = 'range';
    this.normalStrengthInput.className = 'material-tab-normal-strength';
    this.normalStrengthInput.min = '0';
    this.normalStrengthInput.max = '2';
    this.normalStrengthInput.step = '0.05';
    this.wireStrength();
    this.fields.append(this.fieldRow('Strength', this.normalStrengthInput, this.normalStrengthNum));

    // --- Roughness Map: file + thumb + clear ---
    const rough = this.mapRow('Roughness', 'rough');
    this.roughThumb = rough.thumb;

    // --- Metallic Map: file + thumb + clear ---
    const metal = this.mapRow('Metallic', 'metal');
    this.metalThumb = metal.thumb;
  }

  /** Build a file-input + thumbnail + clear-✕ row for a map slot, wire its
   * handlers and append it. Returns the controls for value binding in rebuild. */
  private mapRow(label: string, slot: MapSlot): { file: HTMLInputElement; thumb: HTMLImageElement } {
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = 'image/*';
    file.className = `material-tab-mapfile material-tab-${slot}file`;
    file.addEventListener('change', () => this.onMapFile(slot, file));

    const thumb = document.createElement('img');
    thumb.className = `material-tab-texthumb material-tab-mapthumb material-tab-${slot}thumb`;
    thumb.alt = label;

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = `material-tab-mapclear material-tab-${slot}clear`;
    clear.textContent = '✕';
    clear.title = `Clear ${label} map`;
    clear.addEventListener('click', () => this.onMapClear(slot));

    this.fields.append(this.fieldRow(label, file, thumb, clear));
    return { file, thumb };
  }

  /** Live-preview + single-command wiring for the normal-strength slider. */
  private wireStrength(): void {
    this.normalStrengthInput.addEventListener('focus', () => {
      this.strengthBefore = this.material()?.normalStrength ?? null;
    });
    this.normalStrengthInput.addEventListener('input', () => {
      const mat = this.material();
      if (!mat) return;
      if (this.strengthBefore === null) this.strengthBefore = mat.normalStrength;
      mat.normalStrength = parseFloat(this.normalStrengthInput.value);
      this.normalStrengthNum.textContent = Number(this.normalStrengthInput.value).toFixed(2);
    });
    this.normalStrengthInput.addEventListener('change', () => {
      const mat = this.material();
      if (!mat) { this.strengthBefore = null; return; }
      const after = parseFloat(this.normalStrengthInput.value);
      const before = this.strengthBefore ?? after;
      this.strengthBefore = null;
      if (!Number.isFinite(after)) { this.lastSig = null; return; }
      mat.normalStrength = after;
      if (before === after) { this.lastSig = null; return; }
      this.undo.push(new MapParamEditCommand(mat, 'normalStrength', before, after));
      this.lastSig = null;
    });
  }

  private onBumpToggle(): void {
    const mat = this.material();
    if (!mat) return;
    const before = mat.normalIsBump;
    const after = this.normalBumpCheck.checked;
    if (before === after) return;
    mat.normalIsBump = after;
    this.undo.push(new MapParamEditCommand(mat, 'normalIsBump', before, after));
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

  /** Snapshot the current data url + decoded cache of a map slot. */
  private mapState(mat: Material, slot: MapSlot): MapImgState {
    return { dataUrl: mat[MAP_URL_FIELD[slot]], image: mat[MAP_IMG_FIELD[slot]] };
  }

  /**
   * Decode a packed image RAW (no sRGB) and set it on a map slot in one undo
   * step (both url and decoded cache captured). Exposed via __materialTab for
   * e2e. No-op when no material is active.
   */
  async loadMapFromDataUrl(slot: MapSlot, dataUrl: string): Promise<void> {
    const mat = this.material();
    if (!mat) return;
    const image = await decodeRawTextureDataUrl(dataUrl);
    // The active material may have changed while decoding; re-fetch and bail if so.
    if (this.material() !== mat) return;
    const before = this.mapState(mat, slot);
    mat[MAP_URL_FIELD[slot]] = dataUrl;
    mat[MAP_IMG_FIELD[slot]] = image;
    this.undo.push(new MapImageEditCommand(mat, slot, before, this.mapState(mat, slot)));
    this.lastSig = null;
  }

  /**
   * Decode-on-select: for each present-but-uncached map, decode its data url
   * RAW into the material cache asynchronously so the tracer sees it (e.g. after
   * a scene load or when a map's cache was nulled by undo). Idempotent + guarded
   * against duplicate concurrent decodes.
   */
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

  /**
   * A small ● insert-keyframe button (P15-4) that keys `channels` on the active
   * mesh object's material at scene.frameCurrent through one undoable
   * InsertKeysCommand. No-op when nothing is keyable (no active mesh, or no
   * assigned material so the channel is unresolvable / the frozen default).
   */
  private keyButton(className: string, title: string, channels: string[]): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `material-tab-key-btn ${className}`;
    btn.textContent = '●';
    btn.title = title;
    btn.style.cssText =
      'margin-left:6px;background:none;border:none;color:#e8a33d;cursor:pointer;font-size:11px;line-height:1;padding:2px 3px;';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const obj = this.scene.activeObject;
      if (!obj || obj.kind !== 'mesh') return;
      const cmd = InsertKeysCommand.perform(title, this.scene, [obj], channels, this.scene.frameCurrent);
      if (cmd) this.undo.push(cmd);
    });
    return btn;
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

  /** Current texture state of a material as a fresh snapshot. */
  private texState(mat: Material): TexState {
    return { texKind: mat.texKind, texDataUrl: mat.texDataUrl, texImage: mat.texImage };
  }

  /** Kind select changed: swap texKind, keeping any packed url so switching back
   * to Image restores it. One undo command. */
  private onTexKindChange(): void {
    const mat = this.material();
    if (!mat) return;
    const kind = this.texKindSelect.value as Material['texKind'];
    if (kind === mat.texKind) return;
    const before = this.texState(mat);
    mat.texKind = kind;
    this.undo.push(new TextureEditCommand(mat, before, this.texState(mat)));
    this.lastSig = null;
  }

  private onTexFile(): void {
    const file = this.texFileInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { void this.loadTextureFromDataUrl(String(reader.result)); };
    reader.readAsDataURL(file);
  }

  /**
   * Decode a packed image data URL, set it as the active material's base-color
   * texture (kind → 'image'), and push ONE undo command with the old/new state.
   * Exposed via __materialTab for e2e. Returns silently if no material is active.
   */
  async loadTextureFromDataUrl(dataUrl: string): Promise<void> {
    const mat = this.material();
    if (!mat) return;
    const image = await decodeTextureDataUrl(dataUrl);
    const before = this.texState(mat);
    mat.texKind = 'image';
    mat.texDataUrl = dataUrl;
    mat.texImage = image;
    this.undo.push(new TextureEditCommand(mat, before, this.texState(mat)));
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
    // Decode-on-select: fill any present-but-uncached map caches for the tracer.
    if (mat) this.ensureMapsDecoded(mat);
    const sig = [
      obj!.id,
      obj!.materialId,
      this.scene.materials.map((m) => `${m.id}:${m.name}`).join('|'),
      mat ? `${rgbToHex(mat.baseColor)}:${mat.metallic}:${mat.roughness}:${rgbToHex(mat.emissive)}:${mat.emissiveStrength}:${mat.subsurfaceWeight}:${mat.subsurfaceRadius}` : '-',
      mat ? `${mat.texKind}:${mat.texDataUrl ? mat.texDataUrl.length : 0}` : '-',
      mat ? `${mat.normalDataUrl ? mat.normalDataUrl.length : 0}:${mat.normalIsBump}:${mat.normalStrength}:${mat.roughDataUrl ? mat.roughDataUrl.length : 0}:${mat.metalDataUrl ? mat.metalDataUrl.length : 0}` : '-',
      mat ? `${mat.bakeRes ?? 128}` : '-',
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

    // Texture: kind select + image row (file + thumbnail) visible only for Image.
    this.texKindSelect.value = mat.texKind;
    this.texImageRow.style.display = mat.texKind === 'image' ? '' : 'none';
    if (mat.texKind === 'image' && mat.texDataUrl) {
      this.texThumb.src = mat.texDataUrl;
      this.texThumb.style.display = '';
    } else {
      this.texThumb.removeAttribute('src');
      this.texThumb.style.display = 'none';
    }

    // P13 map slots.
    this.setMapThumb(this.normalThumb, mat.normalDataUrl);
    this.normalBumpCheck.checked = mat.normalIsBump;
    this.normalStrengthInput.value = String(mat.normalStrength);
    this.normalStrengthNum.textContent = mat.normalStrength.toFixed(2);
    this.setMapThumb(this.roughThumb, mat.roughDataUrl);
    this.setMapThumb(this.metalThumb, mat.metalDataUrl);

    // Nodes: bake resolution (default 128 when unset).
    this.bakeResSelect.value = String(mat.bakeRes ?? 128);
  }

  /** Show a map thumbnail when a data url is present, else hide it. */
  private setMapThumb(thumb: HTMLImageElement, dataUrl: string | null): void {
    if (dataUrl) {
      thumb.src = dataUrl;
      thumb.style.display = '';
    } else {
      thumb.removeAttribute('src');
      thumb.style.display = 'none';
    }
  }
}

// Registered at module load so any PropertiesEditor built afterward includes it.
registerPropertiesTab({
  id: 'material',
  icon: '🎨',
  title: 'Material',
  build: (container, ctx) => new MaterialTab(container, ctx.scene, ctx.undo),
});
