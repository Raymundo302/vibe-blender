import type { Scene } from '../core/scene/Scene';
import type { OrbitCamera } from '../camera/OrbitCamera';
import type { Renderer } from '../render/Renderer';
import './cursorOverlay.css';

/**
 * The 3D cursor's viewport marker (P12) — Blender's red/white dashed circle
 * with crosshair ticks. A DOM overlay inside #viewport-wrap (the passepartout
 * pattern): pointer-events:none, repositioned every frame by projecting
 * scene.cursor through the CURRENT view (orbit or camera-view — the renderer
 * resolves which). DOM instead of a GL pass keeps it always-on-top for free
 * and needs zero shader code; the cursor is a UI affordance, not scene content.
 */
export class CursorOverlay {
  private readonly root: HTMLDivElement;
  /** Overlay toggles (P12-2) flip this; hidden cursor still works as a pivot. */
  visible = true;

  constructor(
    host: HTMLElement,
    private readonly scene: Scene,
    private readonly camera: OrbitCamera,
    private readonly renderer: Renderer,
    private readonly canvas: HTMLElement,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'cursor3d';
    // Blender's marker: dashed red/white circle + 4 crosshair ticks.
    this.root.innerHTML = `
      <svg width="22" height="22" viewBox="0 0 22 22">
        <circle cx="11" cy="11" r="6" fill="none" stroke="#fff" stroke-width="1.6" stroke-dasharray="3.1 3.1"/>
        <circle cx="11" cy="11" r="6" fill="none" stroke="#d84040" stroke-width="1.6" stroke-dasharray="3.1 3.1" stroke-dashoffset="3.1"/>
        <line x1="11" y1="0" x2="11" y2="4" stroke="#0008" stroke-width="3"/>
        <line x1="11" y1="18" x2="11" y2="22" stroke="#0008" stroke-width="3"/>
        <line x1="0" y1="11" x2="4" y2="11" stroke="#0008" stroke-width="3"/>
        <line x1="18" y1="11" x2="22" y2="11" stroke="#0008" stroke-width="3"/>
        <line x1="11" y1="1" x2="11" y2="3.5" stroke="#eee" stroke-width="1.4"/>
        <line x1="11" y1="18.5" x2="11" y2="21" stroke="#eee" stroke-width="1.4"/>
        <line x1="1" y1="11" x2="3.5" y2="11" stroke="#eee" stroke-width="1.4"/>
        <line x1="18.5" y1="11" x2="21" y2="11" stroke="#eee" stroke-width="1.4"/>
      </svg>`;
    host.append(this.root);
  }

  /** Frame-loop hook (main.ts): project the cursor to CSS px, or hide it. */
  update(): void {
    if (!this.visible) { this.hide(); return; }
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w <= 0 || h <= 0) { this.hide(); return; }
    const vp = this.renderer.currentViewProj(this.scene, this.camera);
    const c = this.scene.cursor;
    // Clip-space w by hand — transformPoint hides its sign, and a cursor behind
    // the camera would otherwise project to a mirrored on-screen spot.
    const m = vp.m;
    const cw = m[3] * c.x + m[7] * c.y + m[11] * c.z + m[15];
    if (cw <= 1e-6) { this.hide(); return; }
    const ndc = vp.transformPoint(c);
    const x = ((ndc.x + 1) / 2) * w;
    const y = ((1 - ndc.y) / 2) * h;
    if (x < -22 || y < -22 || x > w + 22 || y > h + 22) { this.hide(); return; }
    this.root.style.display = '';
    this.root.style.transform = `translate(${x - 11}px, ${y - 11}px)`;
  }

  private hide(): void {
    if (this.root.style.display !== 'none') this.root.style.display = 'none';
  }
}
