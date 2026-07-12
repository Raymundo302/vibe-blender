/**
 * Orientation gizmo (UR14-4, UI-REVIEW item 14) — a mini axis widget in the
 * top-right corner of the viewport. Three colored axis lines with balls (±X/±Y/
 * ±Z) that track the camera every frame; CLICK a ball to snap the view to that
 * axis (front/right/top + negatives), animated over ~150 ms.
 *
 * Lives inside #viewport-wrap. The gizmo <canvas> is the ONLY interactive part
 * (pointer-events: auto) — a small corner box, Blender-style; everything else in
 * the wrap keeps its own pointer handling.
 *
 * The view-snap animator (`viewSnap`) is a module-level singleton because this
 * app has exactly one orbit camera — the same pattern as pageModeState /
 * textEditState. InputManager's numpad branch drives it too (Numpad 1/3/7/9 +
 * Ctrl variants); the gizmo's update() advances the tween each frame.
 */

import { Vec3 } from '../core/math/vec3';
import type { OrbitCamera } from '../camera/OrbitCamera';

/** Pitch can't reach the pole (lookAt would degenerate) — mirror OrbitCamera. */
const PITCH_LIMIT = Math.PI / 2 - 0.001;
const SNAP_MS = 150;

/**
 * Solve yaw/pitch so the camera's eye-side direction equals `axis` (a unit
 * world axis). OrbitCamera's eye-side direction is
 *   (sin(yaw)·cos(pitch), −cos(yaw)·cos(pitch), sin(pitch))
 * so pitch = asin(z) and yaw = atan2(x, −y). For the ±Z poles the yaw is
 * undetermined (cos(pitch)→0) — keep the current yaw so the roll doesn't jump.
 */
export function axisToYawPitch(
  axis: Vec3,
  currentYaw: number,
): { yaw: number; pitch: number } {
  const pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, Math.asin(axis.z)));
  const horiz = Math.hypot(axis.x, axis.y);
  const yaw = horiz < 1e-6 ? currentYaw : Math.atan2(axis.x, -axis.y);
  return { yaw, pitch };
}

/** Wrap an angle delta into [−π, π] so the tween takes the short way round. */
function shortestDelta(d: number): number {
  return Math.atan2(Math.sin(d), Math.cos(d));
}

/**
 * Module-level view-snap animator. Tweens the camera's yaw/pitch to a target
 * over SNAP_MS with a smoothstep ease. Only yaw/pitch move — target/distance are
 * untouched, so a snap reads as a turntable rotation, not a jump-cut.
 */
class ViewSnap {
  private active = false;
  private t0 = 0;
  private fromYaw = 0;
  private fromPitch = 0;
  private toYaw = 0;
  private toPitch = 0;

  /** True while a snap tween is in flight (exposed for e2e). */
  get animating(): boolean {
    return this.active;
  }

  private begin(camera: OrbitCamera, yaw: number, pitch: number): void {
    this.fromYaw = camera.yaw;
    this.fromPitch = camera.pitch;
    this.toYaw = camera.yaw + shortestDelta(yaw - camera.yaw);
    this.toPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
    this.t0 = performance.now();
    this.active = true;
  }

  /** Snap so the camera looks from `axis` (a unit world axis) toward the target. */
  requestAxis(camera: OrbitCamera, axis: Vec3): void {
    const { yaw, pitch } = axisToYawPitch(axis, camera.yaw);
    this.begin(camera, yaw, pitch);
  }

  /** Snap to the diametrically opposite view (Numpad 9). */
  requestOpposite(camera: OrbitCamera): void {
    this.begin(camera, camera.yaw + Math.PI, -camera.pitch);
  }

  /** Advance the tween; call once per frame. No-op when idle. */
  tick(camera: OrbitCamera): void {
    if (!this.active) return;
    const t = Math.min(1, (performance.now() - this.t0) / SNAP_MS);
    const e = t * t * (3 - 2 * t); // smoothstep
    camera.yaw = this.fromYaw + (this.toYaw - this.fromYaw) * e;
    camera.pitch = this.fromPitch + (this.toPitch - this.fromPitch) * e;
    if (t >= 1) {
      camera.yaw = this.toYaw;
      camera.pitch = this.toPitch;
      this.active = false;
    }
  }
}

export const viewSnap = new ViewSnap();

interface AxisDef {
  key: string;
  dir: Vec3;
  color: string;
  /** Positive axes carry the letter + a solid ball; negatives are hollow rings. */
  label: string;
}

const AXES: readonly AxisDef[] = [
  { key: '+X', dir: Vec3.X, color: '#e5484d', label: 'X' },
  { key: '-X', dir: Vec3.X.negate(), color: '#e5484d', label: '' },
  { key: '+Y', dir: Vec3.Y, color: '#3fb950', label: 'Y' },
  { key: '-Y', dir: Vec3.Y.negate(), color: '#3fb950', label: '' },
  { key: '+Z', dir: Vec3.Z, color: '#4c8dff', label: 'Z' },
  { key: '-Z', dir: Vec3.Z.negate(), color: '#4c8dff', label: '' },
];

const BOX = 72; // CSS px, square
const CENTER = BOX / 2;
const AXIS_LEN = 26; // ball distance from center
const BALL_R = 7;
const HIT_R = 12;

export class AxisGizmo {
  readonly canvas: HTMLCanvasElement;
  private readonly gtx: CanvasRenderingContext2D;
  /** Last-drawn ball centers in canvas-local CSS px, keyed by axis (for e2e). */
  private readonly ballPos = new Map<string, { x: number; y: number }>();

  constructor(
    parent: HTMLElement,
    private readonly camera: OrbitCamera,
  ) {
    const c = document.createElement('canvas');
    c.id = 'axis-gizmo';
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    c.width = Math.round(BOX * dpr);
    c.height = Math.round(BOX * dpr);
    c.style.width = `${BOX}px`;
    c.style.height = `${BOX}px`;
    parent.appendChild(c);
    this.canvas = c;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('axis gizmo: 2D context unavailable');
    ctx.scale(dpr, dpr);
    this.gtx = ctx;

    c.addEventListener('pointerdown', (e) => this.onPointerDown(e));
  }

  private onPointerDown(e: PointerEvent): void {
    // Gizmo interactions never fall through to the viewport (orbit/select).
    e.stopPropagation();
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const hit = this.hitTest(px, py);
    if (hit) viewSnap.requestAxis(this.camera, hit.dir);
  }

  /** Nearest ball within HIT_R of (px,py), preferring the front-most. Uses the
   *  positions from the last draw (kept fresh every frame by update()). */
  private hitTest(px: number, py: number): AxisDef | null {
    let best: AxisDef | null = null;
    let bestScore = Infinity;
    for (const a of AXES) {
      const p = this.ballPos.get(a.key);
      if (!p) continue;
      const d = Math.hypot(px - p.x, py - p.y);
      if (d <= HIT_R && d < bestScore) {
        bestScore = d;
        best = a;
      }
    }
    return best;
  }

  /** Advance the snap tween and redraw the gizmo for the current camera. */
  update(): void {
    viewSnap.tick(this.camera);
    this.draw();
  }

  private draw(): void {
    const g = this.gtx;
    g.clearRect(0, 0, BOX, BOX);

    // Project each world axis into view space; view basis is [right, up,
    // toward-viewer] (OrbitCamera lookAt z = eye−target), so vd.z>0 = front ball.
    const view = this.camera.viewMatrix();
    const proj = AXES.map((a) => {
      const vd = view.transformDir(a.dir);
      return {
        a,
        x: CENTER + vd.x * AXIS_LEN,
        y: CENTER - vd.y * AXIS_LEN,
        depth: vd.z,
      };
    });
    // Record positions for hit-testing this frame.
    this.ballPos.clear();
    for (const p of proj) this.ballPos.set(p.a.key, { x: p.x, y: p.y });

    // Back-to-front so nearer balls overdraw farther ones.
    proj.sort((u, v) => u.depth - v.depth);

    for (const p of proj) {
      const front = p.depth >= 0;
      const alpha = 0.4 + 0.6 * (p.depth * 0.5 + 0.5);
      g.globalAlpha = alpha;

      // Positive axes draw a stalk from the center; negatives are bare balls.
      if (p.a.label) {
        g.strokeStyle = p.a.color;
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(CENTER, CENTER);
        g.lineTo(p.x, p.y);
        g.stroke();
      }

      g.beginPath();
      g.arc(p.x, p.y, BALL_R, 0, Math.PI * 2);
      if (front || p.a.label) {
        g.fillStyle = p.a.color;
        g.fill();
      } else {
        // Far negative ball: hollow ring so it reads as "behind".
        g.fillStyle = 'rgba(30,30,30,0.85)';
        g.fill();
        g.lineWidth = 1.5;
        g.strokeStyle = p.a.color;
        g.stroke();
      }

      if (p.a.label) {
        g.globalAlpha = alpha;
        g.fillStyle = front ? '#111' : 'rgba(255,255,255,0.9)';
        g.font = '700 9px system-ui, sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(p.a.label, p.x, p.y + 0.5);
      }
    }
    g.globalAlpha = 1;
  }

  /** Client-space center of an axis ball (for e2e clicks); null if unknown. */
  ballClientPos(key: string): { x: number; y: number } | null {
    const local = this.ballPos.get(key);
    if (!local) return null;
    const rect = this.canvas.getBoundingClientRect();
    return { x: rect.left + local.x, y: rect.top + local.y };
  }
}
