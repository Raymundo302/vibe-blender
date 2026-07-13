import { EditableMesh } from '../core/mesh/EditableMesh';
import { srgbToLinear } from '../core/scene/worldData';
import type { Scene, SceneObject } from '../core/scene/Scene';
import type { Material } from '../core/scene/objectData';
import type { Command, UndoStack } from '../core/undo/UndoStack';

/**
 * UR4-3 — "Image ▸" add menu: turn a chosen image into a textured plane.
 *
 * DOM-light by design: the file-picker and the browser image `decode()` live
 * behind small functions ({@link pickImagePlane}, {@link decodeImageSize}) so
 * the geometry/material core ({@link createImagePlane}) is unit-testable with a
 * plain data URL + explicit natural dimensions (no DOM needed).
 *
 * The plane lies in the world XY plane (Z-up world, normal +Z): height 2 world
 * units, width 2·(w/h) so the image keeps its aspect ratio. UVs are laid out so
 * the image reads right-side-up — +Y maps to the image top (v=0), +X to the
 * image right (u=1) — matching the app's UNPACK_FLIP_Y=false convention (v=0
 * samples the top row; see Renderer.materialTexture / renderedPass).
 *
 * Two variants:
 *  - Diffuse: lit like any material (roughness 1, metallic 0, shadeless false).
 *  - Emit: `shadeless` — renders exactly as the image looks, no lighting/shadows
 *    (blueprints / references).
 */

export type ImagePlaneMode = 'diffuse' | 'emit';

export interface CreateImagePlaneOptions {
  /** Packed image as a data URL (assigned to the material's texDataUrl). */
  dataUrl: string;
  /** Object + material name (file basename sans extension). */
  name: string;
  /** Natural image width in pixels (drives the plane aspect). */
  w: number;
  /** Natural image height in pixels. */
  h: number;
  mode: ImagePlaneMode;
  /** UR8-3: the texture carries real transparency → material.alphaBlend (blended
   *  draw + tracer cutout + no shadow/AO casting). Default false. */
  alphaBlend?: boolean;
}

/**
 * Build the image-plane quad. XY footprint, height 2 (Y ∈ [-1, 1]), width
 * 2·(w/h) (X ∈ [-aspect, aspect]), normal +Z. Falls back to a square when the
 * dimensions are degenerate (0 / non-finite) so a bad decode can't NaN the mesh.
 */
export function makeImagePlaneMesh(w: number, h: number): EditableMesh {
  const aspect = w > 0 && h > 0 && Number.isFinite(w / h) ? w / h : 1;
  const halfW = aspect; // width = 2·aspect
  const halfH = 1; // height = 2
  // Vert order TL, BL, BR, TR (same spatial order makePlane uses → normal +Z).
  const mesh = EditableMesh.fromData(
    [
      [-halfW, halfH, 0], // 0 top-left     (-X, +Y)
      [-halfW, -halfH, 0], // 1 bottom-left  (-X, -Y)
      [halfW, -halfH, 0], // 2 bottom-right (+X, -Y)
      [halfW, halfH, 0], // 3 top-right    (+X, +Y)
    ],
    [[0, 1, 2, 3]],
  );
  // UVs parallel to the face's vert order. +Y (top) → v=0, +X (right) → u=1, so
  // the image shows upright in Rendered mode.
  const faceId = [...mesh.faces.keys()][0];
  mesh.setFaceUVs(faceId, [
    [0, 0], // TL → image top-left
    [0, 1], // BL → image bottom-left
    [1, 1], // BR → image bottom-right
    [1, 0], // TR → image top-right
  ]);
  return mesh;
}

/**
 * ONE undo entry covering the object, its material, and the assignment — a
 * single Ctrl+Z removes all of it. Convention (A4): the state change has already
 * happened when the command is pushed; undo()/redo() restore it. Positions are
 * captured so redo re-inserts the material + object at their original indices
 * (keeps serialize order + activeCamera/index math stable).
 */
class AddImagePlaneCommand implements Command {
  readonly name = 'Add Image Plane';
  private readonly objIndex: number;
  private readonly matIndex: number;

  constructor(
    private readonly scene: Scene,
    private readonly obj: SceneObject,
    private readonly mat: Material,
  ) {
    this.objIndex = scene.objects.indexOf(obj);
    this.matIndex = scene.materials.indexOf(mat);
  }

  undo(): void {
    // Remove the object first (public API reparents nothing — it has no
    // children), then drop the material directly so obj.materialId survives for
    // redo (scene.removeMaterial would null it out on live objects).
    this.scene.remove(this.obj.id);
    const mi = this.scene.materials.indexOf(this.mat);
    if (mi >= 0) this.scene.materials.splice(mi, 1);
  }

  redo(): void {
    this.scene.materials.splice(Math.min(this.matIndex, this.scene.materials.length), 0, this.mat);
    this.scene.insertAt(this.obj, this.objIndex);
    this.obj.materialId = this.mat.id;
    this.scene.selectOnly(this.obj.id);
  }
}

/**
 * Create an image plane: a textured quad + a matching material in the scene
 * library, assigned to the plane, spawned at the 3D cursor and selected. Pushes
 * exactly ONE undo entry ("Add Image Plane"). Returns the new object.
 *
 * Used by BOTH the picker path ({@link pickImagePlane}) and the unit/e2e tests,
 * which drive it directly with a small data-URL PNG (bypassing the picker).
 */
export function createImagePlane(
  scene: Scene,
  undo: UndoStack,
  opts: CreateImagePlaneOptions,
): SceneObject {
  const { dataUrl, name, w, h, mode } = opts;

  // Material — added to the scene library, textured with the packed image.
  const mat = scene.addMaterial(name);
  mat.name = name;
  // UR16-1: the image lives in the shader's COLOR socket (texKind image); the
  // shader is 'emit' for shadeless image planes (Ray's blueprint/ref look) and
  // 'diffuse' for lit ones. shaderOverrides folds emit → shadeless in the engines.
  mat.shader = mode === 'emit' ? 'emit' : 'diffuse';
  mat.baseColor = [1, 1, 1]; // white base so the image shows unmodified
  mat.metallic = 0;
  mat.roughness = 1;
  mat.texKind = 'image';
  mat.texDataUrl = dataUrl;
  mat.shadeless = mode === 'emit';
  // UR16-4: the emit shader's COLOR socket × strength drives its emission; default
  // strength 1 makes the plane a "screen" that shows its exact pixels (and, above
  // 1, a light that tints the room — a TV in a dark room).
  if (mode === 'emit') mat.emissiveStrength = 1;
  // UR8-3 C: image + HTML planes should look like themselves in EVERY shading
  // mode — Always Textured on by default for these materials.
  mat.alwaysTextured = true;
  // UR8-3 B: transparent rasters (e.g. auto-cropped HTML fragments) alpha-blend.
  mat.alphaBlend = opts.alphaBlend === true;

  // Decode the pixels for the F12 path tracer (browser only, best-effort — the
  // Rendered viewport uploads the data URL straight to GL and never needs this).
  decodeTexImage(dataUrl)
    .then((img) => { if (img) mat.texImage = img; })
    .catch(() => { /* tracer falls back to white — Rendered viewport unaffected */ });

  // Geometry + assignment.
  const obj = scene.add(name, makeImagePlaneMesh(w, h));
  obj.transform = obj.transform.withPosition(scene.cursor); // spawn at the 3D cursor
  obj.materialId = mat.id;
  scene.selectOnly(obj.id);

  undo.push(new AddImagePlaneCommand(scene, obj, mat));
  return obj;
}

/**
 * Open a native file picker for an image and, once one is chosen, build the
 * plane via {@link createImagePlane}. Cancelling the picker does nothing (no
 * undo entry). Browser-only. Optionally reports progress through `setStatus`.
 */
export function pickImagePlane(
  scene: Scene,
  undo: UndoStack,
  mode: ImagePlaneMode,
  setStatus?: (text: string) => void,
): void {
  if (typeof document === 'undefined') return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.style.display = 'none';
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    input.remove();
    if (!file) return; // cancelled → nothing happens
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (!dataUrl) return;
      const name = basename(file.name);
      decodeImageSize(dataUrl)
        .then(({ w, h }) => {
          createImagePlane(scene, undo, { dataUrl, name, w, h, mode });
          setStatus?.(`Added Image Plane "${name}"`);
        })
        .catch(() => setStatus?.('Could not read image'));
    };
    reader.onerror = () => setStatus?.('Could not read image');
    reader.readAsDataURL(file);
  });
  document.body.appendChild(input);
  input.click();
}

/** File basename without its extension ("refs/plan.PNG" → "plan"). */
export function basename(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  return base.replace(/\.[^.]+$/, '') || base;
}

/** Decode an image data URL to its natural pixel dimensions (browser only). */
export function decodeImageSize(dataUrl: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    if (typeof Image === 'undefined') { reject(new Error('no Image decoder')); return; }
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error('failed to decode image'));
    img.src = dataUrl;
  });
}

/** Decoded texture cache shape (linear RGB, row 0 = top) — matches the tracer.
 *  `alpha` (UR8-3) carries the per-pixel alpha (0..1) for the tracer cutout. */
type TexImage = { width: number; height: number; pixels: Float32Array; alpha?: Float32Array };

/**
 * Decode a data URL to linear-light pixels for the tracer (sRGB→linear, row 0 =
 * top). Returns null when there is no DOM/canvas (unit tests) — the caller
 * treats that as "no decode", exactly like a material whose image hasn't loaded.
 * Kept local (not imported from materialTab) so this module stays DOM-light.
 */
function decodeTexImage(dataUrl: string): Promise<TexImage | null> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined' || typeof Image === 'undefined') { resolve(null); return; }
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth, h = img.naturalHeight;
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(null); return; }
        ctx.drawImage(img, 0, 0);
        const rgba = ctx.getImageData(0, 0, w, h).data;
        const pixels = new Float32Array(w * h * 3);
        const alpha = new Float32Array(w * h);
        for (let p = 0, q = 0, a = 0; p < rgba.length; p += 4, q += 3, a += 1) {
          pixels[q] = srgbToLinear(rgba[p] / 255);
          pixels[q + 1] = srgbToLinear(rgba[p + 1] / 255);
          pixels[q + 2] = srgbToLinear(rgba[p + 2] / 255);
          alpha[a] = rgba[p + 3] / 255;
        }
        resolve({ width: w, height: h, pixels, alpha });
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}
