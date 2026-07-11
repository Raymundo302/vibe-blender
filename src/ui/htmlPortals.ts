import type { Scene, SceneObject } from '../core/scene/Scene';
import type { OrbitCamera } from '../camera/OrbitCamera';
import type { Renderer } from '../render/Renderer';
import type { Material } from '../core/scene/objectData';
import type { Mat4 } from '../core/math/mat4';
import { screenMatrixForPlane, pxToPlaneLocalMatrix, cssMatrix3d, clipW } from '../render/cssMatrix';
import { rasterizeHtml, decodeTexImageLinear } from '../tools/htmlPlane';
import { hostOf, rasterizePausedCard } from '../tools/urlPlane';
import { pageModeState } from '../tools/pageMode';
import './htmlPortals.css';

/**
 * HTML web-portal overlay (UR7-3) — the LIVE side of a URL plane. A cross-origin
 * website can't be drawn into WebGL (canvas tainting), so instead of a texture we
 * overlay a real `<iframe>` on the viewport and transform-match it to the plane
 * every frame (classic CSS3D sync — see render/cssMatrix.ts). One iframe per URL
 * plane lives in a `#html-portal-layer` overlay inside #viewport-wrap; update()
 * runs from the frame loop (like passepartout / originDots).
 *
 * ── KNOWN LIMITS (documented; also surfaced in the Properties "Web Page" hint) ─
 *  • **No occlusion.** The portal is a DOM layer ABOVE the WebGL canvas, so it
 *    draws OVER the 3D scene — geometry in front of the plane cannot cover it.
 *  • **Invisible in renders.** F12 / Ctrl+F12 path-traced renders and viewport
 *    screenshots capture the GL framebuffer only; the iframe is never in it. Pause
 *    the portal to bake a snapshot onto the plane's texture (which DOES render).
 *  • **X-Frame-Options.** Sites that refuse framing show an empty portal; there is
 *    no reliable cross-origin way to detect this — pause to fall back to a raster
 *    (same-origin/CORS-fetchable) or the neutral card.
 *
 * ── PLAY / PAUSE ─────────────────────────────────────────────────────────────
 * Portal visible ⇔ `obj.html.playing` (the keyable channel; during playback this
 * holds the sampled value — a portal blinking on at frame N is acceptable v1) AND
 * the object is visible AND the whole plane is in front of the camera. When PAUSED
 * the iframe hides and the plane's own texture shows instead: a CORS-fetched
 * raster of the page when fetchable, else the neutral "Paused web portal — <host>"
 * card (urlPlane.ts).
 *
 * ── INTERACTION ──────────────────────────────────────────────────────────────
 * The layer is `pointer-events: none` so viewport input passes through — EXCEPT in
 * Page Mode (UR7-2 Tab) on this plane, when the iframe gets `pointer-events: auto`
 * so hover / scroll / click work FOR REAL inside the site. Tab out → input returns
 * to the viewport.
 */

interface PortalEntry {
  iframe: HTMLIFrameElement;
  /** The address currently loaded into the iframe (avoid reloading each frame). */
  loadedSrc: string | null;
}

interface PauseState {
  /** Address whose PAUSED texture (raster or card) is committed to the material. */
  pausedFor: string | null;
  /** A paused-texture commit is in flight (fetch/raster) — don't start another. */
  committing: boolean;
}

const EPS = 1e-4;

export class HtmlPortals {
  private readonly layer: HTMLDivElement;
  /** Iframe per URL plane — created LAZILY the first time its portal is shown, so
   *  a paused plane (e.g. freshly loaded) has NO iframe until ▶. */
  private readonly entries = new Map<number, PortalEntry>();
  /** Paused-texture bookkeeping per URL plane (no iframe needed). */
  private readonly pauseStates = new Map<number, PauseState>();
  /** URL planes that have been LIVE (played) at least once this session. A plane
   *  loaded from a file starts paused and NOT in this set, so we keep its
   *  serialized card/raster instead of hitting the network on open ("no surprise
   *  network on file open"). Pausing a plane that WAS live re-commits a fresh
   *  snapshot (CORS raster / card). */
  private readonly everPlayed = new Set<number>();

  constructor(
    host: HTMLElement,
    private readonly scene: Scene,
    private readonly camera: OrbitCamera,
    private readonly renderer: Renderer,
    private readonly canvas: HTMLElement,
  ) {
    this.layer = document.createElement('div');
    this.layer.id = 'html-portal-layer';
    host.append(this.layer);
  }

  /** Frame-loop hook (main.ts): sync every URL plane's iframe to its plane. */
  update(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const urlPlanes = this.scene.objects.filter((o) => o.html?.kind === 'url');

    // Prune per-plane state for planes that left the scene (deleted / add undone).
    const alive = new Set(urlPlanes.map((o) => o.id));
    for (const [id, entry] of [...this.entries]) {
      if (!alive.has(id)) { entry.iframe.remove(); this.entries.delete(id); }
    }
    for (const id of [...this.pauseStates.keys()]) {
      if (!alive.has(id)) this.pauseStates.delete(id);
    }
    for (const id of [...this.everPlayed]) {
      if (!alive.has(id)) this.everPlayed.delete(id);
    }

    if (w <= 0 || h <= 0) return;
    const { view, proj } = this.renderer.viewProjForOverlay(this.scene, this.camera);

    for (const obj of urlPlanes) {
      const playing = obj.html!.playing;
      const objVisible = this.scene.effectiveVisible(obj);
      const world = this.scene.worldMatrix(obj);
      const ext = extentOf(obj);

      // Portal is hidden when paused, the object is hidden, the plane is
      // degenerate, or ANY corner is behind the camera (CSS would fold a
      // behind-camera corner into garbage — matches "hidden when behind camera").
      const pvw = proj.mul(view).mul(world);
      const inFront = ext !== null &&
        clipW(pvw, ext.minX, ext.maxY, 0) > EPS &&
        clipW(pvw, ext.maxX, ext.maxY, 0) > EPS &&
        clipW(pvw, ext.maxX, ext.minY, 0) > EPS &&
        clipW(pvw, ext.minX, ext.minY, 0) > EPS;
      const portalVisible = playing && objVisible && ext !== null && inFront;

      if (portalVisible) {
        // Create the iframe lazily the first time we actually show a portal.
        this.showPortal(obj, this.entryFor(obj), ext!, world, view, proj, w, h);
        this.everPlayed.add(obj.id);
        this.pauseStates.delete(obj.id); // re-pausing should re-commit a fresh snapshot
      } else {
        const existing = this.entries.get(obj.id);
        if (existing) this.hidePortal(existing);
        // Paused (but present + visible): make sure the plane texture shows the
        // raster/card. Skip while the object is hidden (nothing to show).
        if (!playing && objVisible) this.ensurePausedTexture(obj);
      }
    }
  }

  private showPortal(
    obj: SceneObject,
    entry: PortalEntry,
    ext: Extent,
    world: Mat4,
    view: Mat4,
    proj: Mat4,
    w: number,
    h: number,
  ): void {
    const { pageW, pageH, source } = obj.html!;
    const iframe = entry.iframe;

    // Load the address once (re-setting src reloads the site every frame).
    if (entry.loadedSrc !== source) {
      iframe.src = source;
      entry.loadedSrc = source;
    }

    // The iframe's CSS box is pageW×pageH; the matrix scales it onto the plane.
    iframe.style.width = `${pageW}px`;
    iframe.style.height = `${pageH}px`;

    // world · (iframe-px → plane-local) → screen matrix3d.
    const worldPx = world.mul(pxToPlaneLocalMatrix(ext.minX, ext.maxX, ext.minY, ext.maxY, pageW, pageH));
    const m = screenMatrixForPlane(worldPx, view, proj, { w, h });
    iframe.style.transform = cssMatrix3d(m);
    iframe.style.display = '';

    // Pointer events only in Page Mode on THIS plane (so the site is interactive);
    // otherwise the click passes through to the viewport (select/orbit).
    const interactive = pageModeState.object === obj;
    iframe.style.pointerEvents = interactive ? 'auto' : 'none';
    iframe.classList.toggle('interactive', interactive);
  }

  private hidePortal(entry: PortalEntry): void {
    if (entry.iframe.style.display !== 'none') entry.iframe.style.display = 'none';
    entry.iframe.style.pointerEvents = 'none';
  }

  /**
   * Ensure a paused URL plane's material shows a static texture: the CORS-fetched
   * raster of the page when fetchable, else the neutral card. Committed once per
   * address (cheap on subsequent frames); a play→pause round trip re-commits.
   */
  private ensurePausedTexture(obj: SceneObject): void {
    const address = obj.html!.source;
    let st = this.pauseStates.get(obj.id);
    if (!st) { st = { pausedFor: null, committing: false }; this.pauseStates.set(obj.id, st); }
    if (st.committing || st.pausedFor === address) return;
    const mat = this.materialFor(obj);
    if (!mat) return;
    // Loaded-paused (never live this session) + it already carries a serialized
    // card/raster → keep it, no network on open. (A plane that WAS live falls
    // through and re-commits a fresh CORS raster / card on pause.)
    if (!this.everPlayed.has(obj.id) && typeof mat.texDataUrl === 'string' && mat.texDataUrl.length > 0) {
      st.pausedFor = address;
      return;
    }
    st.committing = true;
    st.pausedFor = address; // optimistic: don't re-enter while this resolves
    void this.commitPausedTexture(obj, mat, address).finally(() => { st!.committing = false; });
  }

  private async commitPausedTexture(obj: SceneObject, mat: Material, address: string): Promise<void> {
    const { pageW, pageH } = obj.html!;
    let dataUrl: string;
    try {
      // (a) CORS-fetchable → rasterize the real page onto the plane. Cross-origin
      // sites without CORS throw here and fall through to the card.
      const res = await fetch(address);
      if (!res.ok) throw new Error(`http ${res.status}`);
      const text = await res.text();
      const raster = await rasterizeHtml(text, pageW, pageH);
      dataUrl = raster.dataUrl;
    } catch {
      // (b) not fetchable → the neutral "Paused web portal — <host>" card.
      dataUrl = await rasterizePausedCard(hostOf(address), pageW, pageH);
    }
    // The address changed / went live again while we were fetching → drop it.
    if (obj.html!.source !== address || obj.html!.playing) return;
    mat.texDataUrl = dataUrl;
    const tex = await decodeTexImageLinear(dataUrl);
    if (tex && mat.texDataUrl === dataUrl) mat.texImage = tex;
  }

  private materialFor(obj: SceneObject): Material | null {
    if (obj.materialId === null) return null;
    return this.scene.getMaterial(obj.materialId) ?? null;
  }

  private entryFor(obj: SceneObject): PortalEntry {
    let entry = this.entries.get(obj.id);
    if (!entry) {
      const iframe = document.createElement('iframe');
      iframe.className = 'html-portal';
      // Security niceties (spec): no top-navigation, no popups; no referrer.
      iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
      iframe.setAttribute('referrerpolicy', 'no-referrer');
      iframe.style.display = 'none';
      this.layer.append(iframe);
      entry = { iframe, loadedSrc: null };
      this.entries.set(obj.id, entry);
    }
    return entry;
  }
}

interface Extent { minX: number; maxX: number; minY: number; maxY: number; }

/** The plane quad's local XY extent (top = maxY), or null for an empty mesh. */
function extentOf(obj: SceneObject): Extent | null {
  const verts = [...obj.mesh.verts.values()];
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
