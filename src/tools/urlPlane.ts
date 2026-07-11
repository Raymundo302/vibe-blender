import type { Scene, SceneObject } from '../core/scene/Scene';
import { defaultHtmlPlaneData } from '../core/scene/objectData';
import type { UndoStack } from '../core/undo/UndoStack';
import { createImagePlane } from './imagePlane';
import { RASTER_W, RASTER_H, rasterizeHtml, buildSvgDocument } from './htmlPlane';

/**
 * URL web planes (UR7-3) — the "website portal" object. Unlike a self-contained
 * HTML file (UR7-1), a cross-origin website CANNOT be drawn into WebGL (canvas
 * tainting), so a URL plane is a PORTAL: a real `<iframe>` overlaid on the
 * viewport, transform-matched to the plane each frame (see ui/htmlPortals.ts and
 * render/cssMatrix.ts). This module owns the OBJECT side — creating a URL plane
 * and its texture (the paused card) — plus the small pure helpers (host parse,
 * card markup) the portal reuses.
 *
 * A fresh URL plane is `playing: true` ("a website will be live unless I pause
 * it"): the portal shows the live site. When PAUSED the portal hides and the
 * plane's own texture shows instead — either a CORS-fetched raster of the page
 * (ui/htmlPortals.ts, when the URL is fetchable) or this neutral card. On SCENE
 * LOAD a URL plane starts PAUSED so opening a file never silently hits the
 * network (io/sceneJson.ts forces it; user presses ▶ to go live).
 */

/**
 * Best-effort host of an address for the card / plane name. Falls back to the
 * trimmed address when it isn't a parseable absolute URL (pure, unit-tested).
 */
export function hostOf(address: string): string {
  const s = (address ?? '').trim();
  try {
    return new URL(s).host || s;
  } catch {
    // Not absolute (or no scheme) — try prefixing https:// so bare hosts parse.
    try {
      return new URL('https://' + s).host || s;
    } catch {
      return s;
    }
  }
}

/**
 * The neutral "Paused web portal — <host>" card shown on a paused URL plane's
 * texture (errorCard-style but INFO-GREY, not red — this is a normal state, not
 * an error). Pure, XML-safe (host escaped), unit-tested.
 */
export function pausedCardFragment(host: string): string {
  const safe = (host ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return (
    '<div style="display:flex;flex-direction:column;align-items:center;' +
    'justify-content:center;width:100%;height:100%;background:#2b2f36;' +
    'color:#c6ccd4;font-family:sans-serif;text-align:center;padding:40px;' +
    'box-sizing:border-box;">' +
    '<div style="font-size:34px;opacity:0.7;letter-spacing:2px;">⏸ PAUSED WEB PORTAL</div>' +
    `<div style="font-size:52px;margin-top:24px;font-weight:600;word-break:break-all;">${safe}</div>` +
    '<div style="font-size:24px;margin-top:28px;opacity:0.55;">Press ▶ to go live</div>' +
    '</div>'
  );
}

/**
 * Rasterize the paused card for `host` to a PNG data URL (browser only). Never
 * throws — falls back to a blank raster on any draw failure.
 */
export async function rasterizePausedCard(host: string, w = RASTER_W, h = RASTER_H): Promise<string> {
  const { dataUrl } = await rasterizeHtml(`<html><body>${pausedCardFragment(host)}</body></html>`, w, h);
  return dataUrl;
}

/** SVG for the paused card (exported for tests — mirrors rasterizePausedCard). */
export function pausedCardSvg(host: string, w = RASTER_W, h = RASTER_H): string {
  return buildSvgDocument(`<html><body>${pausedCardFragment(host)}</body></html>`, w, h);
}

/**
 * Create a URL web plane (UR7-3 part B). Builds an emit (shadeless) plane whose
 * texture is the paused card, stamps the `html` payload (kind 'url', the address,
 * `playing: true`), and pushes the ONE "Add Image Plane" undo entry
 * {@link createImagePlane} provides. The live portal itself is managed by
 * ui/htmlPortals.ts from the frame loop. Returns the new object + host. Browser
 * only (rasterizes the card).
 */
export async function addUrlPlane(
  scene: Scene,
  undo: UndoStack,
  address: string,
  setStatus?: (text: string) => void,
): Promise<{ obj: SceneObject; host: string }> {
  const host = hostOf(address);
  const dataUrl = await rasterizePausedCard(host);
  const obj = createImagePlane(scene, undo, {
    dataUrl,
    name: host || 'Website',
    w: RASTER_W,
    h: RASTER_H,
    mode: 'emit',
  });
  obj.html = defaultHtmlPlaneData('url', address.trim());
  obj.html.playing = true; // "a website will be live unless I pause it"
  setStatus?.(
    `Added web portal "${host}" — live iframe overlaid on the plane. ` +
      'No occlusion (draws over the scene); invisible in F12/screenshots. Tab = browse, ⏸ = pause.',
  );
  return { obj, host };
}
