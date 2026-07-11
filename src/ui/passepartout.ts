import type { Renderer } from '../render/Renderer';
import type { Scene } from '../core/scene/Scene';
import { viewPrefs } from '../render/viewPrefs';
import './passepartout.css';

/**
 * Passepartout overlay (P10-2, UR5-5) — Blender's darkened border shown ONLY
 * while looking through a camera (Numpad0). A DOM overlay inside #viewport-wrap
 * dims everything outside the render frame: the largest scene-aspect rect (the
 * scene's REAL output resolution, scene.renderSettings) that fits centered in
 * the viewport. Four absolutely-positioned mask panes cover the letterbox
 * margins; a 1px rect outlines the frame. What lands inside the frame is exactly
 * what F12 renders (Renderer letterboxes the through-camera projection to the
 * same aspect).
 *
 * Purely a viewport read-out: it owns no state, computes the frame from the live
 * canvas size + scene render aspect + renderer.cameraViewId every update(), and
 * is pointer-events:none so it never eats viewport input (clicks select straight
 * through the frame). main.ts drives update() from the frame loop (the panels'
 * pattern), so it recomputes on resize, resolution change and camera-view
 * enter/exit automatically.
 */

/** Fallback aspect when no scene is supplied (kept for the frameRect default). */
const FRAME_ASPECT = 16 / 9;

/**
 * The largest `aspect` rect centered in a w×h viewport, in CSS px. Pure so the
 * letterbox math is trivially reasoned about (and reusable by e2e).
 */
export function frameRect(w: number, h: number, aspect = FRAME_ASPECT): { x: number; y: number; w: number; h: number } {
  if (w <= 0 || h <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  let fw = w;
  let fh = w / aspect;
  if (fh > h) { fh = h; fw = h * aspect; } // taller than the frame → pillarbox
  const x = (w - fw) / 2;
  const y = (h - fh) / 2;
  return { x, y, w: fw, h: fh };
}

export class Passepartout {
  private readonly root: HTMLDivElement;
  private readonly top: HTMLDivElement;
  private readonly bottom: HTMLDivElement;
  private readonly left: HTMLDivElement;
  private readonly right: HTMLDivElement;
  private readonly frame: HTMLDivElement;

  constructor(
    host: HTMLElement,
    private readonly renderer: Renderer,
    private readonly canvas: HTMLElement,
    private readonly scene: Scene,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'passepartout';
    this.root.style.display = 'none';
    this.top = this.pane('passepartout-mask');
    this.bottom = this.pane('passepartout-mask');
    this.left = this.pane('passepartout-mask');
    this.right = this.pane('passepartout-mask');
    this.frame = this.pane('passepartout-frame');
    host.append(this.root);
  }

  private pane(cls: string): HTMLDivElement {
    const el = document.createElement('div');
    el.className = cls;
    this.root.append(el);
    return el;
  }

  /** Show + lay out the masks while in camera view; hide otherwise. */
  update(): void {
    if (this.renderer.cameraViewId === null || !viewPrefs.passepartout) {
      if (this.root.style.display !== 'none') this.root.style.display = 'none';
      return;
    }
    // Use the canvas's on-screen CSS size; the overlay shares #viewport-wrap's
    // origin with the canvas, so 0,0 aligns with the canvas's top-left.
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const rs = this.scene.renderSettings;
    const aspect = rs.height > 0 ? rs.width / rs.height : FRAME_ASPECT;
    const r = frameRect(w, h, aspect);
    this.root.style.display = '';

    // Four margin panes around the frame (any zero-size pane simply collapses).
    place(this.top, 0, 0, w, r.y);
    place(this.bottom, 0, r.y + r.h, w, h - (r.y + r.h));
    place(this.left, 0, r.y, r.x, r.h);
    place(this.right, r.x + r.w, r.y, w - (r.x + r.w), r.h);
    place(this.frame, r.x, r.y, r.w, r.h);
  }
}

function place(el: HTMLElement, x: number, y: number, w: number, h: number): void {
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.width = `${Math.max(0, w)}px`;
  el.style.height = `${Math.max(0, h)}px`;
}
