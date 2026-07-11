import type { Scene, SceneObject } from '../core/scene/Scene';
import type { Material } from '../core/scene/objectData';
import { defaultHtmlPlaneData } from '../core/scene/objectData';
import type { Command, UndoStack } from '../core/undo/UndoStack';
import { EditableMesh } from '../core/mesh/EditableMesh';
import { Transform } from '../core/math/transform';
import { Vec3 } from '../core/math/vec3';
import { rasterizeHtml, decodeTexImageLinear } from './htmlPlane';
import { requestHtmlReraster } from './htmlPlaneDriver';

/**
 * UR8-4 — Extract Element tool. In Page Mode on an HTML plane, the user hovers a
 * DOM element rendered on the plane and clicks to pull it out onto its OWN
 * transparent, auto-cropped plane (a UR8-3 fragment), placed co-planar with the
 * source and nudged in front along the plane normal ("add depth" for parallax).
 *
 * This module is the CORE:
 *  - the computed-style INLINER (pure {@link inlineStyleDecl} + browser
 *    {@link inlineComputedStyles}) that freezes an element's look into a
 *    self-contained fragment,
 *  - the pointer→plane-UV→page-px MAPPING helpers (invert what the raster
 *    pipeline bakes),
 *  - the {@link extractElements} entry that rasterizes each picked element,
 *    creates its plane, hides it in the source, and pushes ONE undo entry.
 *
 * The DOM MIRROR + hover overlay live in ui/extractOverlay.ts (the controller);
 * the toolbar/InputManager wiring routes Page-Mode pointer/keys to it.
 */

// ─── The computed-style subset (documented) ──────────────────────────────────

/**
 * The pragmatic subset of CSS longhands inlined onto every extracted element +
 * descendant. Covers layout/box, color/background, border, font/text, shadow,
 * transform, animation and filter — enough for a self-contained fragment to look
 * like it did on the page. Explicitly NOT exhaustive (no grid-template, no
 * multi-background layering nuance, no writing-mode); a fragment that leans on an
 * un-listed property renders approximately. Position OFFSETS (top/left/right/
 * bottom) ARE inlined so descendants keep their internal absolute layout, but the
 * ROOT element's offsets are neutralized (see {@link inlineComputedStyles}) so the
 * fragment renders standalone at the origin.
 */
export const INLINED_PROPERTIES: string[] = [
  // Layout / box.
  'display', 'position', 'box-sizing', 'width', 'height',
  'min-width', 'min-height', 'max-width', 'max-height',
  'top', 'left', 'right', 'bottom',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'align-content', 'gap',
  'overflow-x', 'overflow-y',
  // Color / background.
  'color', 'opacity',
  'background-color', 'background-image', 'background-size',
  'background-position', 'background-repeat', 'background-clip', 'background-origin',
  // Border.
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-left-radius', 'border-top-right-radius',
  'border-bottom-right-radius', 'border-bottom-left-radius',
  // Font / text.
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
  'line-height', 'letter-spacing', 'word-spacing',
  'text-align', 'text-transform', 'text-decoration-line', 'text-decoration-color',
  'text-decoration-style', 'white-space', 'text-overflow', 'vertical-align',
  // Shadow / effects.
  'box-shadow', 'text-shadow', 'filter',
  // Transform.
  'transform', 'transform-origin',
  // Animation (references @keyframes carried into the fragment head).
  'animation-name', 'animation-duration', 'animation-timing-function',
  'animation-delay', 'animation-iteration-count', 'animation-direction',
  'animation-fill-mode', 'animation-play-state',
];

/** Position offsets neutralized on the ROOT so the fragment renders at origin. */
const ROOT_OFFSET_OVERRIDES = 'position:relative;top:auto;left:auto;right:auto;bottom:auto;margin:0';

/**
 * PURE, unit-tested core of the inliner: given a map of the element's CURRENT
 * computed values and a map of the tag's DEFAULT computed values, emit a
 * `prop:val;prop:val` declaration string of the `props` whose current value is
 * present and DIFFERS from the default. Order follows `props`. No DOM needed.
 */
export function inlineStyleDecl(
  current: Record<string, string>,
  defaults: Record<string, string>,
  props: string[] = INLINED_PROPERTIES,
): string {
  const out: string[] = [];
  for (const p of props) {
    const v = current[p];
    if (v === undefined || v === null || v === '') continue;
    if (defaults[p] === v) continue; // untouched → skip (keeps the fragment lean)
    out.push(`${p}:${v}`);
  }
  return out.join(';');
}

/** Read the listed props off a CSSStyleDeclaration into a plain string map. */
function readComputed(style: CSSStyleDeclaration, props: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const p of props) map[p] = style.getPropertyValue(p);
  return map;
}

/**
 * Cache of default computed styles per tag name, measured off a throwaway
 * reference element inserted into the SAME document (so the browser's UA defaults
 * apply). Per-controller, so pass a fresh Map per extraction session.
 */
type DefaultsCache = Map<string, Record<string, string>>;

function defaultsFor(tag: string, doc: Document, win: Window, cache: DefaultsCache): Record<string, string> {
  const key = tag.toLowerCase();
  const hit = cache.get(key);
  if (hit) return hit;
  const ref = doc.createElement(tag);
  // Off-screen host so the reference lays out without disturbing the page.
  let host = doc.getElementById('__vibe_defaults_host') as HTMLElement | null;
  if (!host) {
    host = doc.createElement('div');
    host.id = '__vibe_defaults_host';
    host.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;';
    doc.body.appendChild(host);
  }
  host.appendChild(ref);
  const map = readComputed(win.getComputedStyle(ref), INLINED_PROPERTIES);
  host.removeChild(ref);
  cache.set(key, map);
  return map;
}

/**
 * Browser walker (needs getComputedStyle): deep-clone `root` and, for every
 * element in the subtree, inline the {@link INLINED_PROPERTIES} that differ from
 * that tag's UA default. Returns the clone's `outerHTML` — a self-contained
 * snapshot of the element's look. `root` must live in a RENDERED document
 * (getComputedStyle needs layout); the returned string is DOM-free.
 *
 * The ROOT element's position offsets are neutralized (position:relative, top/
 * left/right/bottom:auto, margin:0) so the fragment renders standalone at the
 * origin instead of at its old page coordinates. Descendants keep their offsets
 * (their internal absolute layout is relative to the root).
 */
export function inlineComputedStyles(root: HTMLElement): string {
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  if (!win) return root.outerHTML;
  const cache: DefaultsCache = new Map();
  const clone = root.cloneNode(true) as HTMLElement;

  const srcAll = [root, ...Array.from(root.querySelectorAll('*'))] as HTMLElement[];
  const dstAll = [clone, ...Array.from(clone.querySelectorAll('*'))] as HTMLElement[];
  const n = Math.min(srcAll.length, dstAll.length);
  for (let i = 0; i < n; i++) {
    const s = srcAll[i];
    const d = dstAll[i];
    if (!(s instanceof win.HTMLElement)) continue;
    const computed = readComputed(win.getComputedStyle(s), INLINED_PROPERTIES);
    const defaults = defaultsFor(s.tagName, doc, win, cache);
    const decl = inlineStyleDecl(computed, defaults);
    const existing = d.getAttribute('style') ?? '';
    const parts = [existing, decl];
    if (i === 0) parts.push(ROOT_OFFSET_OVERRIDES); // root renders at the origin
    d.setAttribute('style', parts.filter((p) => p).join(';'));
  }

  // Clean up the defaults host so it never leaks into a later serialization.
  const host = doc.getElementById('__vibe_defaults_host');
  if (host) host.remove();

  return clone.outerHTML;
}

/**
 * Collect every `@keyframes` rule reachable from `win`'s stylesheets into one CSS
 * string, so an extracted element that animates carries its animation definitions
 * (the inlined `animation-name` resolves against these in the fragment head).
 * Cross-origin sheets throw on `.cssRules` and are skipped.
 */
export function collectKeyframesCss(win: Window): string {
  let css = '';
  const KEYFRAMES = (win as unknown as { CSSRule?: { KEYFRAMES_RULE: number } }).CSSRule?.KEYFRAMES_RULE ?? 7;
  const sheets = win.document.styleSheets;
  for (let i = 0; i < sheets.length; i++) {
    let rules: CSSRuleList;
    try {
      rules = sheets[i].cssRules;
    } catch {
      continue; // cross-origin / inaccessible
    }
    for (let j = 0; j < rules.length; j++) {
      const r = rules[j];
      const isKeyframes = r.type === KEYFRAMES || /Keyframes/.test(r.constructor?.name ?? '');
      if (isKeyframes) css += r.cssText + '\n';
    }
  }
  return css;
}

/**
 * Assemble a standalone fragment document from an inlined element's outerHTML and
 * the page's @keyframes CSS. Has a `<body>` so the UR8-3 add path treats it as a
 * document (we force transparent+autoCrop explicitly), and the keyframes make the
 * fragment animate on its OWN page clock (starts playing=false — documented).
 */
export function buildFragmentSource(inlinedOuterHtml: string, keyframesCss: string): string {
  const head = keyframesCss ? `<style>${keyframesCss}</style>` : '';
  return `<html><head>${head}</head><body>${inlinedOuterHtml}</body></html>`;
}

// ─── Pointer ↔ page-px mapping (inverts the raster/portal pipeline) ──────────

export interface PlaneExtent {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** The plane quad's local XY extent (top = maxY), or null for an empty mesh. */
export function planeExtent(mesh: EditableMesh): PlaneExtent | null {
  const verts = [...mesh.verts.values()];
  if (verts.length === 0) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const v of verts) {
    if (v.co.x < minX) minX = v.co.x;
    if (v.co.x > maxX) maxX = v.co.x;
    if (v.co.y < minY) minY = v.co.y;
    if (v.co.y > maxY) maxY = v.co.y;
  }
  if (maxX - minX < 1e-9 || maxY - minY < 1e-9) return null;
  return { minX, maxX, minY, maxY };
}

/**
 * Map a source-plane LOCAL point (z≈0) to page px. Inverse of the HTML-plane UV
 * layout (u=0 at minX, v=0 at maxY = page top). `scrollY` shifts the page down so
 * a hit maps to the scrolled document coordinate (native-scroll mirror). Pure.
 */
export function planeLocalToPagePx(
  lx: number, ly: number, ext: PlaneExtent, pageW: number, pageH: number, scrollY = 0,
): { x: number; y: number } {
  const u = (lx - ext.minX) / (ext.maxX - ext.minX);
  const v = (ext.maxY - ly) / (ext.maxY - ext.minY);
  return { x: u * pageW, y: v * pageH + scrollY };
}

/**
 * Map page px back to a source-plane LOCAL point (z=0). Inverse of
 * {@link planeLocalToPagePx} — used to place the extracted plane and to project
 * the highlight rectangle. Pure.
 */
export function pagePxToPlaneLocal(
  px: number, py: number, ext: PlaneExtent, pageW: number, pageH: number, scrollY = 0,
): Vec3 {
  const u = px / pageW;
  const v = (py - scrollY) / pageH;
  const lx = ext.minX + u * (ext.maxX - ext.minX);
  const ly = ext.maxY - v * (ext.maxY - ext.minY);
  return new Vec3(lx, ly, 0);
}

// ─── Fragment plane creation (no undo push — the composite command owns it) ──

interface BuiltPlane {
  obj: SceneObject;
  mat: Material;
  objIndex: number;
  matIndex: number;
}

/**
 * Create a transparent, auto-cropped fragment plane (UR8-3 look) for `dataUrl`
 * sized `rw×rh` px, co-planar with `source` at the element's local rect, nudged
 * `+FRONT_NUDGE` along the source normal. Appended to the scene but NOT pushed to
 * undo (the {@link ExtractElementCommand} owns insert/remove). Returns the pieces
 * the command needs to undo/redo insertion.
 */
const FRONT_NUDGE = 0.01;

function buildFragmentPlane(
  scene: Scene,
  source: SceneObject,
  ext: PlaneExtent,
  fragmentSource: string,
  dataUrl: string,
  rw: number,
  rh: number,
  elemRect: { left: number; top: number; width: number; height: number },
  name: string,
): BuiltPlane {
  const pageW = source.html!.pageW;
  const pageH = source.html!.pageH;

  // Element bbox center + size in source-plane LOCAL units (z=0). The mirror is
  // natively scrolled, so `elemRect` is already in VISIBLE page-viewport px (the
  // same space the raster/UV maps) — no scrollY term needed here.
  const cx = elemRect.left + elemRect.width / 2;
  const cy = elemRect.top + elemRect.height / 2;
  const cLocal = pagePxToPlaneLocal(cx, cy, ext, pageW, pageH);
  const localH = (elemRect.height / pageH) * (ext.maxY - ext.minY);
  const aspect = rh > 0 ? rw / rh : 1;
  const halfH = localH / 2;
  const halfW = halfH * aspect;

  // Material — mirror createImagePlane's fragment material (emit + alphaBlend +
  // alwaysTextured), added to the library but not undo-pushed here.
  const mat = scene.addMaterial(name);
  mat.name = name;
  mat.baseColor = [1, 1, 1];
  mat.metallic = 0;
  mat.roughness = 1;
  mat.texKind = 'image';
  mat.texDataUrl = dataUrl;
  mat.shadeless = true;
  mat.alwaysTextured = true;
  mat.alphaBlend = true;
  decodeTexImageLinear(dataUrl)
    .then((img) => { if (img && mat.texDataUrl === dataUrl) mat.texImage = img; })
    .catch(() => { /* tracer falls back — Rendered viewport unaffected */ });

  // Geometry: a quad in SOURCE-local units centered at origin (source scale is
  // applied via the transform below, so 1 unit here == 1 source-local unit).
  const mesh = makeSizedPlaneMesh(halfW, halfH);
  const obj = scene.add(name, mesh);
  obj.materialId = mat.id;

  // Placement: co-planar with the source (its world rotation+scale) at the
  // element center, nudged in front along the source normal.
  const world = scene.worldMatrix(source);
  const worldT = Transform.fromMat4(world);
  const worldCenter = world.transformPoint(cLocal);
  const normal = world.transformDir(new Vec3(0, 0, 1)).normalize();
  obj.transform = new Transform(
    worldCenter.add(normal.scale(FRONT_NUDGE)),
    worldT.rotation,
    worldT.scale,
  );

  // UR7/UR8 payload: a transparent auto-cropped fragment plane (pageW/pageH = the
  // crop box). Starts playing=false on its own page clock (independent animation).
  obj.html = { ...defaultHtmlPlaneData('file', fragmentSource), pageW: rw, pageH: rh, transparent: true, autoCrop: true };

  return { obj, mat, objIndex: scene.objects.indexOf(obj), matIndex: scene.materials.indexOf(mat) };
}

/** A quad of half-extents halfW×halfH centered at origin, normal +Z, upright UVs. */
function makeSizedPlaneMesh(halfW: number, halfH: number): EditableMesh {
  const hw = Number.isFinite(halfW) && halfW > 0 ? halfW : 1;
  const hh = Number.isFinite(halfH) && halfH > 0 ? halfH : 1;
  const mesh = EditableMesh.fromData(
    [
      [-hw, hh, 0],
      [-hw, -hh, 0],
      [hw, -hh, 0],
      [hw, hh, 0],
    ],
    [[0, 1, 2, 3]],
  );
  const faceId = [...mesh.faces.keys()][0];
  mesh.setFaceUVs(faceId, [[0, 0], [0, 1], [1, 1], [1, 0]]);
  return mesh;
}

// ─── The one-undo composite command ──────────────────────────────────────────

/**
 * ONE undo entry for a whole Extract activation: the source plane's text edit
 * (visibility rule added), its re-raster, the new fragment plane(s), and the
 * selection change. Convention A4: the state is already applied when pushed.
 */
export class ExtractElementCommand implements Command {
  readonly name = 'Extract Element';
  private readonly prevSelection: number[];
  private readonly prevActive: number | null;

  constructor(
    private readonly scene: Scene,
    private readonly source: SceneObject,
    private readonly beforeSource: string,
    private readonly afterSource: string,
    private readonly planes: BuiltPlane[],
    prevSelection: number[],
    prevActive: number | null,
  ) {
    this.prevSelection = prevSelection;
    this.prevActive = prevActive;
  }

  undo(): void {
    // Remove the fragment planes (objects then their materials, reverse order).
    for (let i = this.planes.length - 1; i >= 0; i--) {
      const p = this.planes[i];
      this.scene.remove(p.obj.id);
      const mi = this.scene.materials.indexOf(p.mat);
      if (mi >= 0) this.scene.materials.splice(mi, 1);
    }
    // Restore the source text + re-raster (removes the visibility hole).
    this.source.html!.source = this.beforeSource;
    requestHtmlReraster(this.source);
    // Restore selection.
    this.restoreSelection(this.prevSelection, this.prevActive);
  }

  redo(): void {
    // Re-hide the extracted elements in the source + re-raster.
    this.source.html!.source = this.afterSource;
    requestHtmlReraster(this.source);
    // Re-insert the materials + objects at their captured indices.
    for (const p of this.planes) {
      this.scene.materials.splice(Math.min(p.matIndex, this.scene.materials.length), 0, p.mat);
      this.scene.insertAt(p.obj, p.objIndex);
      p.obj.materialId = p.mat.id;
    }
    // Select the last extracted plane (matches the fresh-extract selection).
    const last = this.planes.at(-1);
    if (last) this.scene.selectOnly(last.obj.id);
  }

  private restoreSelection(ids: number[], active: number | null): void {
    this.scene.deselectAll();
    for (const id of ids) if (this.scene.get(id)) this.scene.selection.add(id);
    this.scene.activeId = active !== null && this.scene.get(active) ? active : null;
  }
}

// ─── The extraction entry ─────────────────────────────────────────────────────

/**
 * The picked elements as {LIVE mirror element, its injected id} pairs. The mirror
 * doc + serialization live in the controller; this entry does the async raster +
 * scene mutation + undo push. `mirrorWin` is the mirror iframe's window (for
 * getComputedStyle + @keyframes); `afterSource` is the source text WITH the
 * visibility rules + data attributes already injected (serialized by the caller).
 */
export interface PickedElement {
  el: HTMLElement;
  /** getBoundingClientRect() in the mirror's viewport (page px, scroll-adjusted). */
  rect: { left: number; top: number; width: number; height: number };
  /** The unique data-vibe-extract index (also in `afterSource`). */
  index: number;
}

/**
 * Rasterize each picked element to its own transparent/cropped fragment plane,
 * hide the elements in the source, and push ONE "Extract Element" undo entry.
 * Returns the created objects. Async (rasterization). The source's own re-raster
 * is triggered via {@link requestHtmlReraster} (the driver's next tick).
 */
export async function extractElements(
  scene: Scene,
  undo: UndoStack,
  source: SceneObject,
  picks: PickedElement[],
  mirrorWin: Window,
  afterSource: string,
): Promise<SceneObject[]> {
  const ext = planeExtent(source.mesh);
  if (!ext || !source.html || picks.length === 0) return [];

  const keyframes = collectKeyframesCss(mirrorWin);
  const built: BuiltPlane[] = [];

  for (const pick of picks) {
    const inlined = inlineComputedStyles(pick.el);
    const fragSource = buildFragmentSource(inlined, keyframes);
    const raster = await rasterizeHtml(fragSource, undefined, undefined, { transparent: true, autoCrop: true });
    const name = `${source.name}·${elementLabel(pick.el)}`;
    built.push(
      buildFragmentPlane(scene, source, ext, fragSource, raster.dataUrl, raster.w, raster.h, pick.rect, name),
    );
  }

  // Snapshot selection BEFORE mutating it.
  const prevSelection = [...scene.selection];
  const prevActive = scene.activeId;

  // Apply the source edit + re-raster (Convention A4: state applied before push).
  const beforeSource = source.html.source;
  source.html.source = afterSource;
  requestHtmlReraster(source);

  // Select the last new plane.
  const last = built.at(-1);
  if (last) scene.selectOnly(last.obj.id);

  undo.push(new ExtractElementCommand(scene, source, beforeSource, afterSource, built, prevSelection, prevActive));
  return built.map((b) => b.obj);
}

/** A short label for the extracted-plane name (tag + id/class if present). */
function elementLabel(el: HTMLElement): string {
  const id = el.id ? `#${el.id}` : '';
  const cls = !id && el.classList.length ? `.${el.classList[0]}` : '';
  return `${el.tagName.toLowerCase()}${id}${cls}`;
}

// ─── Controller handshake (implemented in ui/extractOverlay.ts) ──────────────

/** Structural interface so InputManager can drive the active controller without
 *  importing the DOM-heavy controller class (avoids an import cycle). */
export interface ExtractController {
  /** True once the DOM mirror has loaded and hit-testing is live. */
  ready(): boolean;
  /** Pointer moved to canvas-local (x,y): update the hover highlight. */
  moveTo(x: number, y: number): void;
  /** LMB at the current hover: extract (shift = accumulate for multi-extract). */
  click(shift: boolean): void;
  /** Enter: finish a multi-extract (commit accumulated picks). */
  finish(): void;
  /** Esc / mode exit: cancel with no undo entry. */
  cancel(): void;
  /** Tear down the mirror + overlay. */
  dispose(): void;
}

/** Active Extract-Element controller (null = tool not active). Module-level,
 *  viewport-ish state like pageModeState. InputManager routes pointer/keys here. */
export const extractState: { controller: ExtractController | null } = { controller: null };

/** True while the Extract Element tool is picking. */
export function inExtractMode(): boolean {
  return extractState.controller !== null;
}
