import type { Scene } from '../core/scene/Scene';
import type { OrbitCamera } from '../camera/OrbitCamera';
import type { Renderer } from '../render/Renderer';
import { overlays } from '../render/overlayPrefs';
import './originDots.css';

/**
 * Origin dots (P12-2) — Blender draws a small dot at the world origin of every
 * SELECTED object. A DOM overlay inside #viewport-wrap (the same passepartout /
 * 3D-cursor pattern): pointer-events:none divs repositioned every frame by
 * projecting each object's world-space origin through the CURRENT view (orbit
 * or looked-through camera — the renderer resolves which).
 *
 * Only shown when `overlays.originPoints` is on. Reuses one pool of divs grown
 * on demand (selections are small); surplus dots are hidden, not removed.
 */
export class OriginDots {
  private readonly pool: HTMLDivElement[] = [];

  constructor(
    private readonly host: HTMLElement,
    private readonly scene: Scene,
    private readonly camera: OrbitCamera,
    private readonly renderer: Renderer,
    private readonly canvas: HTMLElement,
  ) {}

  /** Frame-loop hook (main.ts): position one dot per selected, visible object. */
  update(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!overlays.originPoints || w <= 0 || h <= 0) { this.hideFrom(0); return; }

    const vp = this.renderer.currentViewProj(this.scene, this.camera);
    const m = vp.m;
    let used = 0;
    for (const obj of this.scene.objects) {
      if (!this.scene.selection.has(obj.id)) continue;
      if (!this.scene.effectiveVisible(obj)) continue;
      const p = this.scene.worldTransformOf(obj).position;
      // Clip-space w by hand — a point behind the camera would otherwise project
      // to a mirrored on-screen spot (copied from cursorOverlay.ts).
      const cw = m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15];
      if (cw <= 1e-6) continue;
      const ndc = vp.transformPoint(p);
      const x = ((ndc.x + 1) / 2) * w;
      const y = ((1 - ndc.y) / 2) * h;
      if (x < -6 || y < -6 || x > w + 6 || y > h + 6) continue;
      const dot = this.dotAt(used++);
      dot.style.display = '';
      dot.style.transform = `translate(${x - 3}px, ${y - 3}px)`;
    }
    this.hideFrom(used);
  }

  /** Grow the pool as needed and return the div at index i. */
  private dotAt(i: number): HTMLDivElement {
    let dot = this.pool[i];
    if (!dot) {
      dot = document.createElement('div');
      dot.className = 'origin-dot';
      this.host.append(dot);
      this.pool[i] = dot;
    }
    return dot;
  }

  /** Hide every pooled dot from index `from` onward. */
  private hideFrom(from: number): void {
    for (let i = from; i < this.pool.length; i++) {
      if (this.pool[i].style.display !== 'none') this.pool[i].style.display = 'none';
    }
  }
}
