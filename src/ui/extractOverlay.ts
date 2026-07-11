import type { Scene, SceneObject } from '../core/scene/Scene';
import type { OrbitCamera } from '../camera/OrbitCamera';
import type { Renderer } from '../render/Renderer';
import type { UndoStack } from '../core/undo/UndoStack';
import { Vec3 } from '../core/math/vec3';
import { rayPlane } from '../core/math/ray';
import { sanitizeToXhtml, wrapXhtml } from '../tools/htmlPlane';
import {
  extractElements,
  planeExtent,
  planeLocalToPagePx,
  pagePxToPlaneLocal,
  extractState,
  type ExtractController,
  type PickedElement,
} from '../tools/extractElement';
import './extractOverlay.css';

/**
 * UR8-4 — the Extract Element CONTROLLER (the DOM-mirror + hover overlay side).
 *
 * Started by InputManager while in Page Mode on an HTML plane. It:
 *  1. renders a hidden, off-screen LIVE MIRROR of the source page (a same-origin
 *     sandboxed iframe at pageW×pageH) so getBoundingClientRect / elementFromPoint
 *     / getComputedStyle all work,
 *  2. maps the viewport pointer → the plane's world quad → page px → the mirror's
 *     `elementFromPoint`, and draws an SVG highlight polygon over the viewport at
 *     the hovered element's projected corners (no per-hover re-raster),
 *  3. on click, injects a `data-vibe-extract` attribute + a
 *     `visibility:hidden !important` rule into the mirror (which becomes the
 *     source's new text) and calls {@link extractElements} to pull the element out
 *     onto its own transparent plane — ONE undo entry.
 *
 * Shift+click accumulates several picks (highlighted persistently); Enter commits
 * them all in one activation; Esc / leaving Page Mode cancels with no undo entry.
 */

const NS = 'http://www.w3.org/2000/svg';

export class ExtractElementController implements ExtractController {
  private readonly iframe: HTMLIFrameElement;
  private readonly svg: SVGSVGElement;
  private loaded = false;
  private disposed = false;
  /** Element currently under the pointer (single-pick hover target). */
  private hovered: HTMLElement | null = null;
  /** Shift-accumulated picks awaiting Enter (multi-extract). */
  private readonly staged: HTMLElement[] = [];
  private nextIndex = 1;

  constructor(
    private readonly scene: Scene,
    private readonly source: SceneObject,
    private readonly camera: OrbitCamera,
    private readonly renderer: Renderer,
    private readonly undo: UndoStack,
    private readonly canvas: HTMLElement,
    host: HTMLElement,
    private readonly setStatus: (s: string) => void,
  ) {
    const pageW = source.html!.pageW;
    const pageH = source.html!.pageH;

    // --- Live off-screen mirror (same-origin so we can read it; scripts blocked
    // by the sandbox and already stripped by sanitizeToXhtml). ----------------
    const { head, body } = sanitizeToXhtml(source.html!.source);
    this.iframe = document.createElement('iframe');
    this.iframe.className = 'extract-mirror';
    this.iframe.setAttribute('sandbox', 'allow-same-origin');
    this.iframe.width = String(pageW);
    this.iframe.height = String(pageH);
    this.iframe.style.width = `${pageW}px`;
    this.iframe.style.height = `${pageH}px`;
    this.iframe.addEventListener('load', () => {
      this.loaded = true;
      // Match the plane's scroll so the visible page-px space aligns with the
      // raster (native scroll → getBoundingClientRect/elementFromPoint are in
      // viewport px, exactly the space the plane UV maps).
      try { this.iframe.contentWindow?.scrollTo(0, source.html!.scrollY || 0); } catch { /* ignore */ }
    });
    this.iframe.srcdoc = wrapXhtml(body, head);
    document.body.appendChild(this.iframe);

    // --- Highlight overlay (SVG over the viewport, like the knife preview). ---
    this.svg = document.createElementNS(NS, 'svg');
    this.svg.setAttribute('class', 'extract-highlight-layer');
    host.appendChild(this.svg);

    extractState.controller = this;
    this.setStatus('Extract Element — hover to highlight, click to extract, Shift+click multiple, Enter to finish, Esc to cancel');
  }

  ready(): boolean {
    return this.loaded && !this.disposed;
  }

  // ─── Hover mapping ──────────────────────────────────────────────────────────

  moveTo(x: number, y: number): void {
    if (!this.ready()) return;
    const doc = this.iframe.contentDocument;
    if (!doc || !doc.body) return;
    const page = this.pointerToPagePx(x, y);
    if (!page) {
      this.hovered = null;
      this.redraw();
      return;
    }
    const el = doc.elementFromPoint(page.x, page.y) as HTMLElement | null;
    // Ignore the page chrome itself (html/body) — extract real content only.
    this.hovered = el && el !== doc.body && el !== doc.documentElement ? el : null;
    this.redraw();
  }

  /** Viewport canvas px → page px on the source plane, or null if off the plane. */
  private pointerToPagePx(x: number, y: number): { x: number; y: number } | null {
    const ext = planeExtent(this.source.mesh);
    if (!ext) return null;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (width <= 0 || height <= 0) return null;
    const ray = this.camera.pointerRay(x, y, width, height);
    const world = this.scene.worldMatrix(this.source);
    const p0 = world.transformPoint(Vec3.ZERO);
    const normal = world.transformDir(new Vec3(0, 0, 1)).normalize();
    const hit = rayPlane(ray, p0, normal);
    if (!hit) return null;
    const local = world.invert().transformPoint(hit);
    const pageW = this.source.html!.pageW;
    const pageH = this.source.html!.pageH;
    const page = planeLocalToPagePx(local.x, local.y, ext, pageW, pageH);
    if (page.x < 0 || page.x > pageW || page.y < 0 || page.y > pageH) return null;
    return page;
  }

  /** Element's mirror viewport rect in page px (scroll-adjusted, native scroll). */
  private rectOf(el: HTMLElement): { left: number; top: number; width: number; height: number } {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  // ─── Highlight drawing ──────────────────────────────────────────────────────

  private redraw(): void {
    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);
    for (const el of this.staged) this.drawRect(el, 'extract-staged');
    if (this.hovered && !this.staged.includes(this.hovered)) this.drawRect(this.hovered, 'extract-hover');
  }

  /** Project an element's page rect onto the viewport and draw an SVG polygon. */
  private drawRect(el: HTMLElement, cls: string): void {
    const rect = this.rectOf(el);
    if (rect.width <= 0 || rect.height <= 0) return;
    const ext = planeExtent(this.source.mesh);
    if (!ext) return;
    const pageW = this.source.html!.pageW;
    const pageH = this.source.html!.pageH;
    const world = this.scene.worldMatrix(this.source);
    const vp = this.renderer.currentViewProj(this.scene, this.camera);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const corners: Array<[number, number]> = [
      [rect.left, rect.top],
      [rect.left + rect.width, rect.top],
      [rect.left + rect.width, rect.top + rect.height],
      [rect.left, rect.top + rect.height],
    ];
    const pts = corners.map(([px, py]) => {
      const local = pagePxToPlaneLocal(px, py, ext, pageW, pageH);
      const ndc = vp.transformPoint(world.transformPoint(local));
      const sx = (ndc.x * 0.5 + 0.5) * w;
      const sy = (0.5 - ndc.y * 0.5) * h;
      return `${sx.toFixed(1)},${sy.toFixed(1)}`;
    });
    const poly = document.createElementNS(NS, 'polygon');
    poly.setAttribute('points', pts.join(' '));
    poly.setAttribute('class', cls);
    this.svg.appendChild(poly);
  }

  // ─── Extraction ─────────────────────────────────────────────────────────────

  click(shift: boolean): void {
    if (!this.ready() || !this.hovered) return;
    if (shift) {
      // Accumulate: toggle the hovered element in/out of the staged set.
      const i = this.staged.indexOf(this.hovered);
      if (i >= 0) this.staged.splice(i, 1);
      else this.staged.push(this.hovered);
      this.setStatus(`Extract Element — ${this.staged.length} staged, Enter to finish, Esc to cancel`);
      this.redraw();
      return;
    }
    // Immediate single extract.
    void this.commit([this.hovered]);
  }

  finish(): void {
    if (!this.ready()) return;
    const picks = this.staged.length ? [...this.staged] : this.hovered ? [this.hovered] : [];
    if (picks.length === 0) { this.cancel(); return; }
    void this.commit(picks);
  }

  private async commit(elements: HTMLElement[]): Promise<void> {
    const doc = this.iframe.contentDocument;
    if (!doc) { this.dispose(); return; }
    // Inject the hide markers into the mirror (which becomes the new source), and
    // build the pick list (rects measured BEFORE dispose). visibility:hidden
    // keeps the layout hole — the parallax point.
    const picks: PickedElement[] = [];
    for (const el of elements) {
      const index = this.nextIndex++;
      el.setAttribute('data-vibe-extract', String(index));
      this.appendHideRule(doc, index);
      picks.push({ el, rect: this.rectOf(el), index });
    }
    const afterSource = '<!DOCTYPE html>' + doc.documentElement.outerHTML;
    try {
      const created = await extractElements(this.scene, this.undo, this.source, picks, this.iframe.contentWindow!, afterSource);
      this.setStatus(`Extracted ${created.length} element${created.length === 1 ? '' : 's'}`);
    } catch {
      this.setStatus('Extract failed');
    }
    this.dispose();
  }

  /** Append `[data-vibe-extract="N"]{visibility:hidden !important}` to the head. */
  private appendHideRule(doc: Document, index: number): void {
    const style = doc.createElement('style');
    style.textContent = `[data-vibe-extract="${index}"]{visibility:hidden !important}`;
    (doc.head ?? doc.documentElement).appendChild(style);
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  cancel(): void {
    this.setStatus('');
    this.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.iframe.remove();
    this.svg.remove();
    if (extractState.controller === this) extractState.controller = null;
  }
}
