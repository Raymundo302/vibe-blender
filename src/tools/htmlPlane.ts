import { srgbToLinear } from '../core/scene/worldData';
import type { Scene, SceneObject } from '../core/scene/Scene';
import { defaultHtmlPlaneData, type Material } from '../core/scene/objectData';
import type { Command, UndoStack } from '../core/undo/UndoStack';
import { EditableMesh } from '../core/mesh/EditableMesh';
import { basename, createImagePlane } from './imagePlane';

/**
 * UR8-3 A — a source WITHOUT a `<body`/`<html` tag is a bare FRAGMENT (Ray's
 * "just the bouncy ball + shadow"): it defaults to a transparent, auto-cropped
 * raster (real transparency around the content, plane sized to its bbox). A full
 * document keeps the opaque, full-page 1024×768 raster. Pure — the add paths use
 * it as the DEFAULT when the caller doesn't force transparent/autoCrop.
 */
export function isBareFragment(source: string): boolean {
  return !/<body[\s>]/i.test(source) && !/<html[\s>]/i.test(source);
}

/**
 * Scan an RGBA byte array (row-major, 4 bytes/pixel) for the bounding box of the
 * pixels whose alpha exceeds `alphaThreshold` (0..255), padded by `pad` px and
 * clamped to the image. Returns null when the image is fully transparent. Pure +
 * unit-tested (UR8-3 A autoCrop) — the browser crop path calls this on the
 * getImageData bytes, then re-draws into a canvas of exactly the returned size.
 */
export function alphaBBox(
  rgba: Uint8ClampedArray | Uint8Array | number[],
  w: number,
  h: number,
  pad = 2,
  alphaThreshold = 0,
): { x: number; y: number; w: number; h: number } | null {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3] > alphaThreshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return null; // fully transparent
  const x0 = Math.max(0, minX - pad);
  const y0 = Math.max(0, minY - pad);
  const x1 = Math.min(w - 1, maxX + pad);
  const y1 = Math.min(h - 1, maxY + pad);
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * UR4-4 — "Image ▸ HTML Snapshot… / HTML Live…" add-menu items: rasterize a
 * self-contained .html file onto a shadeless (emit) image plane, reusing the
 * UR4-3 {@link createImagePlane} pipeline.
 *
 * ── HOW IT RASTERIZES ────────────────────────────────────────────────────────
 * The HTML text is embedded in an SVG `<foreignObject>` (an XHTML document),
 * loaded as an `<img>` from a blob URL, and drawn to a canvas → PNG data URL →
 * emit image plane (blueprints want the exact pixels, so shadeless).
 *
 * ── HARD LIMITS (self-contained HTML only) ──────────────────────────────────
 * SVG-image rasterization is a SANDBOX with strict rules — the same limits are
 * echoed in the status line on add:
 *   • **Scripts do NOT execute.** No `<script>`, no JS, no interactivity.
 *   • **External resources do NOT load** — http(s) images, web fonts, remote
 *     CSS/`<link>` are all blocked. Inline everything (data: URIs, `<style>`).
 *   • **XML strictness.** foreignObject content is parsed as XML, so unclosed
 *     void tags (`<br>`, `<img>`, `<meta>`) or mismatched tags break parsing.
 *     Malformed HTML that kills the XML parse is caught and rasterized as an
 *     **error card** ("HTML failed to parse") instead of throwing.
 * No iframes, no URLs, no clickable/interactive HTML on the plane.
 *
 * ── LIVE vs SNAPSHOT ────────────────────────────────────────────────────────
 *   • **Snapshot** ({@link pickHtmlSnapshot}): plain `<input type=file>` read
 *     once. Works in every browser.
 *   • **Live** ({@link pickHtmlLive}): `window.showOpenFilePicker()` (Chrome File
 *     System Access API) yields a re-readable handle. A single module-level 2s
 *     poller compares `getFile().lastModified`; on change it re-rasterizes and
 *     swaps the SAME material's `texDataUrl` in place (the Rendered-mode texture
 *     cache re-uploads automatically on a url change — see
 *     Renderer.materialTexture). Edit the file in your editor → the plane
 *     updates in-app. Liveness is **session-only**: file handles are held in a
 *     non-serialized runtime map (WeakMap by object), so after save/load the
 *     plane loads as a static image plane. Where `showOpenFilePicker` is missing
 *     (Firefox / headless), Live falls back to snapshot behaviour.
 */

/** Fixed raster size (documented). The plane keeps this 4:3 aspect. */
export const RASTER_W = 1024;
export const RASTER_H = 768;

/** Shown on the error-card plane (and asserted by the pure tests). */
export const PARSE_FAILURE_MESSAGE = 'HTML failed to parse';

/** Poll interval for Live planes. */
const POLL_MS = 2000;

// ─── Pure document construction (unit-tested, no DOM) ────────────────────────

/**
 * Split an HTML source into `{ head, body }` fragments. Full documents
 * contribute their `<body>` inner HTML (and `<head>` inner HTML, so
 * self-contained `<style>` blocks survive); a bare fragment becomes the body
 * verbatim with an empty head.
 */
export function extractParts(source: string): { head: string; body: string } {
  const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(source);
  if (bodyMatch) {
    const headMatch = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(source);
    return { head: headMatch ? headMatch[1] : '', body: bodyMatch[1] };
  }
  return { head: '', body: source };
}

/**
 * Wrap a body fragment (and optional head fragment) in an XHTML `<html>` root
 * carrying the XHTML namespace foreignObject requires. A small reset makes
 * `height:100%` children fill the raster and gives blueprints a white ground.
 */
export function wrapXhtml(bodyFragment: string, headFragment = '', transparent = false): string {
  // UR8-3 A: `transparent` swaps the white ground for `background:transparent`
  // so the raster keeps real alpha around the content (a bare fragment plane).
  const bg = transparent ? 'transparent' : '#ffffff';
  return (
    '<html xmlns="http://www.w3.org/1999/xhtml"><head>' +
    '<style>html,body{margin:0;padding:0;width:100%;height:100%;' +
    `box-sizing:border-box;background:${bg};}</style>` +
    headFragment +
    `</head><body>${bodyFragment}</body></html>`
  );
}

/**
 * Build the full SVG document string that embeds `source` as XHTML inside a
 * `<foreignObject>`, sized `w × h`. `source` may be a full HTML document or a
 * bare body fragment — {@link extractParts} normalizes it.
 */
export function buildSvgDocument(source: string, w = RASTER_W, h = RASTER_H, transparent = false): string {
  const { head, body } = extractParts(source);
  return buildSvgFromParts(head, body, w, h, transparent);
}

/** Same SVG construction from already-normalized head/body fragments. */
export function buildSvgFromParts(head: string, body: string, w = RASTER_W, h = RASTER_H, transparent = false): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    '<foreignObject x="0" y="0" width="100%" height="100%">' +
    wrapXhtml(body, head, transparent) +
    '</foreignObject></svg>'
  );
}

/**
 * The body fragment for the parse-failure error card — a centered message on a
 * pale-red ground. `message` defaults to {@link PARSE_FAILURE_MESSAGE}. Pure,
 * XML-safe (angle brackets escaped), unit-tested.
 */
export function errorCardFragment(message: string = PARSE_FAILURE_MESSAGE): string {
  const safe = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return (
    '<div style="display:flex;align-items:center;justify-content:center;' +
    'width:100%;height:100%;background:#3a2020;color:#ff8a8a;' +
    "font-family:monospace;font-size:48px;text-align:center;padding:40px;\">" +
    safe +
    '</div>'
  );
}

// ─── Browser rasterization ───────────────────────────────────────────────────

/** Result of a rasterization: the PNG data URL and whether parsing succeeded. */
export interface RasterResult {
  dataUrl: string;
  /** false when the source failed to parse and an error card was drawn. */
  ok: boolean;
  /** Final raster width in px (UR8-3 A: the CROP size when autoCrop trimmed it,
   *  else the requested w). The plane geometry uses this for the content aspect. */
  w: number;
  /** Final raster height in px (see {@link w}). */
  h: number;
  /** True when this raster carries real transparency (transparent option) — the
   *  add path sets the material's alphaBlend from it. */
  transparent: boolean;
}

/** Per-raster options (UR8-3 A). */
export interface RasterOptions {
  w?: number;
  h?: number;
  scrollY?: number;
  /** No white ground — keep alpha around the content. Default false (opaque). */
  transparent?: boolean;
  /** After drawing, crop the canvas to the alpha bounding box (pad 2px). Only
   *  meaningful with transparent. Default false. */
  autoCrop?: boolean;
}

/**
 * Draw an SVG document string to a canvas and return its PNG data URL. Rejects
 * if the SVG fails to load (malformed XML) or the canvas can't be read. Browser
 * only. A white ground is painted first (self-contained content over white).
 *
 * The SVG is loaded from a **data: URL, NOT a blob: URL** — this matters:
 * drawing a foreignObject SVG loaded from a blob URL TAINTS the canvas in Chrome
 * (`toDataURL` then throws SecurityError), whereas the inline data URL stays
 * clean. Self-contained content only, so encodeURIComponent is safe.
 */
function svgToCanvas(
  svg: string,
  w: number,
  h: number,
  opts?: { transparent?: boolean; autoCrop?: boolean },
): Promise<HTMLCanvasElement> {
  const transparent = opts?.transparent ?? false;
  const autoCrop = opts?.autoCrop ?? false;
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined' || typeof Image === 'undefined') {
      reject(new Error('no DOM'));
      return;
    }
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no 2d context');
        // UR8-3 A: transparent → NO white ground fill, so the raster keeps the
        // content's alpha. Opaque → paint white first (self-contained blueprint).
        if (!transparent) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, w, h);
        }
        ctx.drawImage(img, 0, 0, w, h);
        if (autoCrop) {
          // Scan the alpha channel for the content bbox and re-draw into a canvas
          // of EXACTLY that size (padding 2px) so the plane uses the content aspect.
          const rgba = ctx.getImageData(0, 0, w, h).data;
          const box = alphaBBox(rgba, w, h, 2);
          if (box) {
            const out = document.createElement('canvas');
            out.width = box.w;
            out.height = box.h;
            const octx = out.getContext('2d');
            if (!octx) throw new Error('no 2d context');
            octx.drawImage(canvas, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
            resolve(out);
            return;
          }
        }
        resolve(canvas);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };
    img.onerror = () => {
      reject(new Error('SVG failed to load (malformed HTML/XML)'));
    };
    img.src = url;
  });
}

/** Rasterize an SVG string to a PNG data URL + its final pixel size. */
function svgToPng(
  svg: string,
  w: number,
  h: number,
  opts?: { transparent?: boolean; autoCrop?: boolean },
): Promise<{ dataUrl: string; w: number; h: number }> {
  return svgToCanvas(svg, w, h, opts).then((canvas) => ({
    dataUrl: canvas.toDataURL('image/png'),
    w: canvas.width,
    h: canvas.height,
  }));
}

/** Last-resort plain-canvas error card if even the error SVG can't rasterize. */
function fallbackErrorCanvas(w: number, h: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#3a2020';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#ff8a8a';
    ctx.font = '48px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(PARSE_FAILURE_MESSAGE, w / 2, h / 2);
  }
  return canvas.toDataURL('image/png');
}

/**
 * Normalize arbitrary real-world HTML into well-formed XHTML fragments.
 * foreignObject demands strict XML, but real pages have unclosed `<br>`,
 * `&nbsp;`, unquoted attributes, … — so we round-trip through the browser's
 * LENIENT HTML parser (DOMParser text/html never throws) and re-emit each
 * head/body child with XMLSerializer, which is well-formed by construction.
 * `<script>` elements are dropped (they never execute inside an SVG image and
 * their raw `<`/`&` content would re-break the XML). Browser only.
 */
export function sanitizeToXhtml(source: string): { head: string; body: string } {
  const doc = new DOMParser().parseFromString(source, 'text/html');
  for (const s of Array.from(doc.querySelectorAll('script'))) s.remove();
  const ser = new XMLSerializer();
  const serialize = (el: Element): string =>
    Array.from(el.childNodes).map((n) => ser.serializeToString(n)).join('');
  return { head: serialize(doc.head), body: serialize(doc.body) };
}

/**
 * Rasterize an HTML source to a PNG data URL via SVG `<foreignObject>`. The
 * source is sanitized to well-formed XHTML first (see {@link sanitizeToXhtml}),
 * so ordinary non-XML HTML rasterizes fine. On any remaining parse/draw
 * failure it falls back to an **error-card** raster (never throws), with
 * `ok:false`. Browser only.
 */
export async function rasterizeHtml(
  source: string,
  w: number = RASTER_W,
  h: number = RASTER_H,
  opts?: { transparent?: boolean; autoCrop?: boolean },
): Promise<RasterResult> {
  const transparent = opts?.transparent ?? false;
  const autoCrop = opts?.autoCrop ?? false;
  try {
    const { head, body } = sanitizeToXhtml(source);
    const png = await svgToPng(buildSvgFromParts(head, body, w, h, transparent), w, h,
      { transparent, autoCrop });
    return { dataUrl: png.dataUrl, ok: true, w: png.w, h: png.h, transparent };
  } catch {
    // Parse/draw failed → rasterize an error card instead of throwing (opaque).
    try {
      const errSvg = buildSvgDocument(errorCardFragment(), w, h);
      const png = await svgToPng(errSvg, w, h);
      return { dataUrl: png.dataUrl, ok: false, w: png.w, h: png.h, transparent: false };
    } catch {
      return { dataUrl: fallbackErrorCanvas(w, h), ok: false, w, h, transparent: false };
    }
  }
}

// ─── Timed rasterization (UR7-1 page clock) ─────────────────────────────────

/**
 * The CSS rule that samples the page's animation pose at `tSeconds` (pure,
 * unit-tested). Every element is force-PAUSED and given a NEGATIVE animation
 * delay of `-t`s, which advances each running CSS animation to its `t`-second
 * pose and then holds it — exactly how you snapshot an animation clock.
 *
 * ── v1 LIMITATION (documented) ──────────────────────────────────────────────
 * `animation-delay` here OVERRIDES any author-set per-animation delay: all page
 * animations are folded into ONE global sample clock (there is no per-animation
 * offset). Author staggering via delay is lost; keyframe timing/duration is not.
 */
export function pausedAnimationRule(tSeconds: number): string {
  const t = Number.isFinite(tSeconds) ? Math.max(0, tSeconds) : 0;
  return `*{animation-play-state:paused !important;animation-delay:-${t}s !important}`;
}

/** The `<style>` block appended to the page head to sample pose at `tSeconds`. */
export function pausedAnimationStyle(tSeconds: number): string {
  return `<style>${pausedAnimationRule(tSeconds)}</style>`;
}

/**
 * Consume `html.scrollY` (UR7-2 A) by wrapping the sanitized body in a fixed
 * clipping VIEWPORT: an `overflow:hidden`, full-height outer div holds an inner
 * div translated UP by `scrollY` CSS px (`transform: translateY(-scrollY)`), so
 * the raster shows the page scrolled down by that many pixels. The inner div
 * keeps the body's NATURAL flow height (only the outer div is clamped to the
 * raster viewport), so content below the fold — e.g. a marker at page-y 900 —
 * comes into view once you scroll to it.
 *
 * At scrollY = 0 the body is returned UNCHANGED so the raster is byte-identical
 * to the un-scrolled UR7-1 pipeline (keeps the page-clock determinism + existing
 * screenshots stable). Chosen over `overflow:scroll` positioning because a
 * transform composes predictably inside foreignObject across backends and needs
 * no scrollbar suppression.
 */
export function scrollWrap(body: string, scrollY: number): string {
  const y = Number.isFinite(scrollY) ? Math.max(0, scrollY) : 0;
  if (y === 0) return body;
  return (
    '<div style="position:absolute;top:0;left:0;width:100%;height:100%;overflow:hidden;">' +
    `<div style="position:absolute;top:0;left:0;width:100%;transform:translateY(-${y}px);">` +
    body +
    '</div></div>'
  );
}

/**
 * Rasterize `source` at page-clock time `tSeconds` (UR7-1). Same sanitize →
 * SVG-foreignObject → canvas pipeline as {@link rasterizeHtml}, but a
 * pose-sampling style ({@link pausedAnimationStyle}) is appended LAST in the head
 * so it wins the cascade and freezes every CSS animation at its `t`-second pose.
 * Never throws — an error card is rasterized on parse/draw failure (`ok:false`).
 * `opts.w/h` default to the documented 1024×768. Browser only.
 */
export async function rasterizeHtmlAt(
  source: string,
  tSeconds: number,
  opts?: RasterOptions,
): Promise<RasterResult> {
  const w = opts?.w ?? RASTER_W;
  const h = opts?.h ?? RASTER_H;
  const scrollY = opts?.scrollY ?? 0;
  const transparent = opts?.transparent ?? false;
  const autoCrop = opts?.autoCrop ?? false;
  try {
    const { head, body } = sanitizeToXhtml(source);
    const png = await svgToPng(
      buildSvgFromParts(head + pausedAnimationStyle(tSeconds), scrollWrap(body, scrollY), w, h, transparent),
      w,
      h,
      { transparent, autoCrop },
    );
    return { dataUrl: png.dataUrl, ok: true, w: png.w, h: png.h, transparent };
  } catch {
    try {
      const errSvg = buildSvgDocument(errorCardFragment(), w, h);
      const png = await svgToPng(errSvg, w, h);
      return { dataUrl: png.dataUrl, ok: false, w: png.w, h: png.h, transparent: false };
    } catch {
      return { dataUrl: fallbackErrorCanvas(w, h), ok: false, w, h, transparent: false };
    }
  }
}

/** Decoded texture cache shape (linear RGB, row 0 = top) — matches the tracer.
 *  `alpha` (UR8-3) is the per-pixel alpha (0..1) so the tracer cutout can read it. */
type TexImage = { width: number; height: number; pixels: Float32Array; alpha?: Float32Array };

/**
 * Decode a PNG data URL to linear-light pixels for the F12 path tracer (awaitable
 * so callers that need determinism — Ctrl+F12 — can wait). Returns null with no
 * DOM/canvas (unit tests) or on a decode error. Mirrors imagePlane.decodeTexImage.
 */
export function decodeTexImageLinear(dataUrl: string): Promise<TexImage | null> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined' || typeof Image === 'undefined') { resolve(null); return; }
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
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

// ─── Plane creation ──────────────────────────────────────────────────────────

/**
 * Rasterize `text` and add it as an emit (shadeless) image plane, pushing the
 * ONE "Add Image Plane" undo entry {@link createImagePlane} already provides.
 * Never throws for bad HTML — an error card is rasterized instead. Returns the
 * new object (and whether the HTML parsed).
 */
export async function addHtmlPlaneFromText(
  scene: Scene,
  undo: UndoStack,
  text: string,
  name: string,
  setStatus?: (text: string) => void,
  quiet = false,
  opts?: { transparent?: boolean; autoCrop?: boolean },
): Promise<{ obj: SceneObject; ok: boolean }> {
  // UR8-3 A heuristic: a bare fragment (no <body>/<html>) defaults to a
  // transparent, auto-cropped raster; a full document keeps the opaque full
  // page. Either can be forced via opts (the add-dialog checkboxes).
  const bare = isBareFragment(text);
  const transparent = opts?.transparent ?? bare;
  const autoCrop = opts?.autoCrop ?? bare;
  const { dataUrl, ok, w, h } = await rasterizeHtml(text, RASTER_W, RASTER_H, { transparent, autoCrop });
  const obj = createImagePlane(scene, undo, {
    dataUrl,
    name,
    // Cropped fragment → the plane uses the CONTENT aspect (crop box), not 1024×768.
    w,
    h,
    mode: 'emit',
    // Transparent rasters carry real alpha → blend + tracer cutout.
    alphaBlend: transparent,
  });
  // UR7-1: stamp the HTML-plane payload so the page can animate on the plane and
  // Play becomes a keyable channel. kind 'file' serializes the source text into
  // the scene. Old scenes (no payload) load as plain static image planes.
  // UR8-3 A: pageW/pageH store the CROP box so the plane matches the content;
  // transparent/autoCrop ride along so the playback driver re-rasters identically.
  obj.html = { ...defaultHtmlPlaneData('file', text), pageW: w, pageH: h, transparent, autoCrop };
  if (!quiet) {
    setStatus?.(
      ok
        ? `Added HTML plane "${name}" (${w}×${h}${transparent ? ', transparent' : ''}; self-contained HTML only — no scripts or external images/fonts/CSS)`
        : `Added HTML plane "${name}" — ${PARSE_FAILURE_MESSAGE} (self-contained HTML only — no scripts/external resources)`,
    );
  }
  return { obj, ok };
}

// ─── Page extent geometry (UR7-2 B) ─────────────────────────────────────────

/**
 * Build the HTML-plane quad for a page extent (UR7-2 B). The world WIDTH is kept
 * as `width` ("stays as-built"); the TOP edge stays at `topY` and the plane
 * HEIGHT = width·pageH/pageW extends DOWNWARD (the bottom edge drops to
 * `topY − height`) — Ray's "the plane's bottom edge goes further down to show
 * more of the page". UVs stay the full 0..1 raster (the whole page still maps
 * onto the taller plane). Degenerate width / pageW / pageH fall back to a
 * finite square so a bad edit can't NaN the mesh.
 *
 * Consistent with {@link makeImagePlaneMesh}: for the default 1024×768 built
 * width 2·1024/768, this reproduces the original height-2 plane (top +1,
 * bottom −1) exactly, so switching the two never jumps the geometry.
 */
export function makeHtmlPlaneMesh(width: number, topY: number, pageW: number, pageH: number): EditableMesh {
  const w = Number.isFinite(width) && width > 0 ? width : 2;
  const ratio = pageW > 0 && pageH > 0 && Number.isFinite(pageH / pageW) ? pageH / pageW : 1;
  const height = w * ratio;
  const halfW = w / 2;
  const top = Number.isFinite(topY) ? topY : 1;
  const bottom = top - height;
  const mesh = EditableMesh.fromData(
    [
      [-halfW, top, 0], // 0 TL (-X, top)
      [-halfW, bottom, 0], // 1 BL (-X, bottom)
      [halfW, bottom, 0], // 2 BR (+X, bottom)
      [halfW, top, 0], // 3 TR (+X, top)
    ],
    [[0, 1, 2, 3]],
  );
  const faceId = [...mesh.faces.keys()][0];
  mesh.setFaceUVs(faceId, [
    [0, 0], // TL → raster top-left
    [0, 1], // BL → raster bottom-left
    [1, 1], // BR → raster bottom-right
    [1, 0], // TR → raster top-right
  ]);
  return mesh;
}

/**
 * Read the current world WIDTH and TOP-edge Y of a plane quad from its verts —
 * the invariants {@link makeHtmlPlaneMesh} preserves across a page-extent edit
 * (width never changes, top stays put). Returns null for an empty mesh.
 */
export function htmlPlaneExtent(mesh: EditableMesh): { width: number; topY: number } | null {
  const verts = [...mesh.verts.values()];
  if (verts.length === 0) return null;
  let minX = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const v of verts) {
    if (v.co.x < minX) minX = v.co.x;
    if (v.co.x > maxX) maxX = v.co.x;
    if (v.co.y > maxY) maxY = v.co.y;
  }
  return { width: maxX - minX, topY: maxY };
}

/**
 * Set an HTML plane's page extent (UR7-2 B): store the new pageW/pageH on the
 * payload AND regenerate the plane mesh so its bottom edge extends downward.
 * ONE undo entry restores both the geometry AND the payload numbers (grep the
 * properties-tab numeric commit pattern — apply, then push). No-op for a
 * non-HTML object.
 */
class SetHtmlPageExtentCommand implements Command {
  readonly name = 'Set Page Extent';
  private readonly beforeW: number;
  private readonly beforeH: number;
  private readonly beforeMesh: EditableMesh;
  private readonly afterMesh: EditableMesh;

  constructor(
    private readonly obj: SceneObject,
    private readonly afterW: number,
    private readonly afterH: number,
  ) {
    const html = obj.html!;
    this.beforeW = html.pageW;
    this.beforeH = html.pageH;
    this.beforeMesh = obj.mesh.clone();
    // Apply: keep the as-built width + top edge, rebuild for the new extent.
    const ext = htmlPlaneExtent(obj.mesh) ?? { width: 2, topY: 1 };
    html.pageW = afterW;
    html.pageH = afterH;
    obj.mesh.copyFrom(makeHtmlPlaneMesh(ext.width, ext.topY, afterW, afterH));
    this.afterMesh = obj.mesh.clone();
  }

  undo(): void {
    this.obj.html!.pageW = this.beforeW;
    this.obj.html!.pageH = this.beforeH;
    this.obj.mesh.copyFrom(this.beforeMesh);
  }

  redo(): void {
    this.obj.html!.pageW = this.afterW;
    this.obj.html!.pageH = this.afterH;
    this.obj.mesh.copyFrom(this.afterMesh);
  }
}

/**
 * Commit a page-extent edit on `obj` (an HTML plane): pushes ONE undoable
 * {@link SetHtmlPageExtentCommand} that regenerates the plane geometry. No-op if
 * the values are non-finite or unchanged, or the object has no html payload.
 */
export function setHtmlPageExtent(obj: SceneObject, undo: UndoStack, pageW: number, pageH: number): void {
  if (!obj.html) return;
  if (!Number.isFinite(pageW) || !Number.isFinite(pageH) || pageW <= 0 || pageH <= 0) return;
  if (obj.html.pageW === pageW && obj.html.pageH === pageH) return;
  undo.push(new SetHtmlPageExtentCommand(obj, pageW, pageH));
}

/**
 * Open a native file picker for an .html file and, once chosen, rasterize it
 * onto a plane via {@link addHtmlPlaneFromText}. Cancelling does nothing.
 * Browser only. Works in every browser (snapshot semantics — read once).
 */
export function pickHtmlSnapshot(
  scene: Scene,
  undo: UndoStack,
  setStatus?: (text: string) => void,
  opts?: { transparent?: boolean; autoCrop?: boolean },
): void {
  if (typeof document === 'undefined') return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.html,.htm,text/html';
  input.style.display = 'none';
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    input.remove();
    if (!file) return; // cancelled → nothing happens
    file
      .text()
      .then((text) => addHtmlPlaneFromText(scene, undo, text, basename(file.name), setStatus, false, opts))
      .catch(() => setStatus?.('Could not read HTML file'));
  });
  document.body.appendChild(input);
  input.click();
}

// ─── Live planes (File System Access API + poller) ───────────────────────────

interface LiveEntry {
  obj: SceneObject;
  scene: Scene;
  mat: Material;
  handle: FileSystemFileHandle;
  lastModified: number;
  /** UR8-3 A: re-rasterize the live file with the same transparent/crop opts. */
  transparent: boolean;
  autoCrop: boolean;
}

/**
 * Live planes currently being polled. Iterable (a WeakMap isn't) so the single
 * poller can visit every entry; self-pruned when an object leaves the scene.
 */
const liveEntries = new Set<LiveEntry>();

/**
 * NON-serialized runtime store of the file handle per object (spec: file
 * handles can't go in sceneJson). WeakMap so a GC'd object drops its handle.
 */
const handleByObject = new WeakMap<SceneObject, FileSystemFileHandle>();

/** The one module-level poller interval, live only while planes exist. */
let pollTimer: ReturnType<typeof setInterval> | null = null;

function ensurePoller(): void {
  if (pollTimer === null && liveEntries.size > 0) {
    pollTimer = setInterval(() => { void pollLivePlanes(); }, POLL_MS);
  }
}

function stopPollerIfIdle(): void {
  if (pollTimer !== null && liveEntries.size === 0) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * Visit every live plane: drop any whose object has left the scene (deleted, or
 * the add was undone) — which also stops the poller when the last one goes —
 * and re-rasterize any whose file changed on disk since the last poll.
 */
async function pollLivePlanes(): Promise<void> {
  for (const entry of [...liveEntries]) {
    // Deleted or add-undone → stop polling this plane.
    if (!entry.scene.objects.includes(entry.obj)) {
      liveEntries.delete(entry);
      handleByObject.delete(entry.obj);
      continue;
    }
    try {
      const file = await entry.handle.getFile();
      if (file.lastModified === entry.lastModified) continue;
      entry.lastModified = file.lastModified;
      const text = await file.text();
      const { dataUrl } = await rasterizeHtml(text, RASTER_W, RASTER_H,
        { transparent: entry.transparent, autoCrop: entry.autoCrop });
      // Swap the SAME material's texture in place. Renderer.materialTexture
      // re-uploads on a url change (its cache is keyed by material id + url),
      // so this is the invalidation path — no explicit cache poke needed.
      entry.mat.texDataUrl = dataUrl;
      updateTracerImage(entry.mat, dataUrl);
    } catch {
      /* file moved / permission revoked → keep the last good frame */
    }
  }
  stopPollerIfIdle();
}

/**
 * Live-add an HTML plane via the File System Access API. Where
 * `showOpenFilePicker` is unavailable (Firefox / headless), falls back to
 * snapshot behaviour with a status note. Session-only liveness.
 */
export async function pickHtmlLive(
  scene: Scene,
  undo: UndoStack,
  setStatus?: (text: string) => void,
  rasterOpts?: { transparent?: boolean; autoCrop?: boolean },
): Promise<void> {
  const picker = (window as unknown as {
    showOpenFilePicker?: (opts?: unknown) => Promise<FileSystemFileHandle[]>;
  }).showOpenFilePicker;

  if (typeof picker !== 'function') {
    setStatus?.('Live HTML unavailable — added snapshot');
    pickHtmlSnapshot(scene, undo, setStatus, rasterOpts);
    return;
  }

  let handle: FileSystemFileHandle;
  try {
    [handle] = await picker({
      types: [{ description: 'HTML', accept: { 'text/html': ['.html', '.htm'] } }],
      multiple: false,
    });
  } catch {
    return; // user cancelled the picker → nothing happens
  }
  if (!handle) return;

  try {
    const file = await handle.getFile();
    const text = await file.text();
    const name = basename(file.name);
    const bare = isBareFragment(text);
    const transparent = rasterOpts?.transparent ?? bare;
    const autoCrop = rasterOpts?.autoCrop ?? bare;
    const { obj } = await addHtmlPlaneFromText(scene, undo, text, name, setStatus, true, { transparent, autoCrop });
    const mat = scene.getMaterial(obj.materialId ?? -1);
    if (!mat) return;
    const entry: LiveEntry = { obj, scene, mat, handle, lastModified: file.lastModified, transparent, autoCrop };
    liveEntries.add(entry);
    handleByObject.set(obj, handle);
    ensurePoller();
    setStatus?.(
      `Added live HTML plane "${name}" — polling for changes ` +
        '(self-contained HTML only; no scripts/external resources)',
    );
  } catch {
    setStatus?.('Could not read HTML file');
  }
}

/** Number of planes currently being polled (test/debug hook). */
export function liveHtmlPlaneCount(): number {
  return liveEntries.size;
}

// ─── Tracer texture refresh (best-effort, mirrors imagePlane.decodeTexImage) ──

/**
 * Re-decode a data URL into the material's linear-light `texImage` so the F12
 * path tracer picks up a live edit too. Best-effort and browser only — the
 * Rendered viewport updates from `texDataUrl` alone and never needs this.
 */
function updateTracerImage(mat: Material, dataUrl: string): void {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return;
  const img = new Image();
  img.onload = () => {
    try {
      if (mat.texDataUrl !== dataUrl) return; // superseded by a newer edit
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
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
      mat.texImage = { width: w, height: h, pixels, alpha };
    } catch {
      /* leave the previous tracer image */
    }
  };
  img.src = dataUrl;
}
