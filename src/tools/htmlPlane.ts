import { srgbToLinear } from '../core/scene/worldData';
import type { Scene, SceneObject } from '../core/scene/Scene';
import type { Material } from '../core/scene/objectData';
import type { UndoStack } from '../core/undo/UndoStack';
import { basename, createImagePlane } from './imagePlane';

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
export function wrapXhtml(bodyFragment: string, headFragment = ''): string {
  return (
    '<html xmlns="http://www.w3.org/1999/xhtml"><head>' +
    '<style>html,body{margin:0;padding:0;width:100%;height:100%;' +
    'box-sizing:border-box;background:#ffffff;}</style>' +
    headFragment +
    `</head><body>${bodyFragment}</body></html>`
  );
}

/**
 * Build the full SVG document string that embeds `source` as XHTML inside a
 * `<foreignObject>`, sized `w × h`. `source` may be a full HTML document or a
 * bare body fragment — {@link extractParts} normalizes it.
 */
export function buildSvgDocument(source: string, w = RASTER_W, h = RASTER_H): string {
  const { head, body } = extractParts(source);
  return buildSvgFromParts(head, body, w, h);
}

/** Same SVG construction from already-normalized head/body fragments. */
export function buildSvgFromParts(head: string, body: string, w = RASTER_W, h = RASTER_H): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    '<foreignObject x="0" y="0" width="100%" height="100%">' +
    wrapXhtml(body, head) +
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
function svgToPng(svg: string, w: number, h: number): Promise<string> {
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
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/png'));
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
): Promise<RasterResult> {
  try {
    const { head, body } = sanitizeToXhtml(source);
    const dataUrl = await svgToPng(buildSvgFromParts(head, body, w, h), w, h);
    return { dataUrl, ok: true };
  } catch {
    // Parse/draw failed → rasterize an error card instead of throwing.
    try {
      const errSvg = buildSvgDocument(errorCardFragment(), w, h);
      const dataUrl = await svgToPng(errSvg, w, h);
      return { dataUrl, ok: false };
    } catch {
      return { dataUrl: fallbackErrorCanvas(w, h), ok: false };
    }
  }
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
): Promise<{ obj: SceneObject; ok: boolean }> {
  const { dataUrl, ok } = await rasterizeHtml(text);
  const obj = createImagePlane(scene, undo, {
    dataUrl,
    name,
    w: RASTER_W,
    h: RASTER_H,
    mode: 'emit',
  });
  if (!quiet) {
    setStatus?.(
      ok
        ? `Added HTML plane "${name}" (${RASTER_W}×${RASTER_H}; self-contained HTML only — no scripts or external images/fonts/CSS)`
        : `Added HTML plane "${name}" — ${PARSE_FAILURE_MESSAGE} (self-contained HTML only — no scripts/external resources)`,
    );
  }
  return { obj, ok };
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
      .then((text) => addHtmlPlaneFromText(scene, undo, text, basename(file.name), setStatus))
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
      const { dataUrl } = await rasterizeHtml(text);
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
): Promise<void> {
  const picker = (window as unknown as {
    showOpenFilePicker?: (opts?: unknown) => Promise<FileSystemFileHandle[]>;
  }).showOpenFilePicker;

  if (typeof picker !== 'function') {
    setStatus?.('Live HTML unavailable — added snapshot');
    pickHtmlSnapshot(scene, undo, setStatus);
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
    const { obj } = await addHtmlPlaneFromText(scene, undo, text, name, setStatus, true);
    const mat = scene.getMaterial(obj.materialId ?? -1);
    if (!mat) return;
    const entry: LiveEntry = { obj, scene, mat, handle, lastModified: file.lastModified };
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
      for (let p = 0, q = 0; p < rgba.length; p += 4, q += 3) {
        pixels[q] = srgbToLinear(rgba[p] / 255);
        pixels[q + 1] = srgbToLinear(rgba[p + 1] / 255);
        pixels[q + 2] = srgbToLinear(rgba[p + 2] / 255);
      }
      mat.texImage = { width: w, height: h, pixels };
    } catch {
      /* leave the previous tracer image */
    }
  };
  img.src = dataUrl;
}
