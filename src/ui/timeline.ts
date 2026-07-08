/**
 * Timeline editor (P15-1) — a short horizontal workspace pane that scrubs,
 * plays back, and shows keyframe diamonds for the selected objects.
 *
 * Header row: ⏮ (jump to frameStart), ▶/⏸ play toggle, an editable frame
 * number input, Start/End inputs, and the fps as static text. Below it a
 * canvas draws a frame ruler (ticks + numbers), a playhead line at
 * frameCurrent, and ONE row per SELECTED object: its name plus a diamond per
 * keyed frame (union of that object's fcurves' key frames — filled when EVERY
 * LocRotScale channel is keyed there, hollow otherwise).
 *
 * Scrubbing (drag on the ruler or track area) sets scene.frameCurrent
 * (rounded, clamped to [start, end]) and runs the sampler — NOT undoable, like
 * Blender. Playback advances a fractional playhead in update() from
 * performance.now() deltas × scene.fps, looping start↔end, applying the
 * sampler each tick. ▶/⏸ and the Spacebar (InputManager) flip scene.playing.
 *
 * The frame↔pixel math + tick-step + clamp helpers are pure and exported for
 * unit tests (timeline.test.ts); they carry no DOM dependency.
 */
import type { Scene, SceneObject } from '../core/scene/Scene';
import { applyAnimation } from '../core/anim/sampler';
import { findCurve } from '../core/anim/fcurve';
import { LOC_ROT_SCALE } from '../core/anim/animCommands';
import './timeline.css';

/** Left gutter (object-name label column) + right margin, in CSS px. */
export const PAD_LEFT = 96;
export const PAD_RIGHT = 12;

/** Pixel X of a (possibly fractional) frame across the plotted range. */
export function frameToX(
  frame: number,
  frameStart: number,
  frameEnd: number,
  width: number,
): number {
  const plotW = Math.max(1, width - PAD_LEFT - PAD_RIGHT);
  const span = Math.max(1, frameEnd - frameStart);
  return PAD_LEFT + ((frame - frameStart) / span) * plotW;
}

/** Inverse of frameToX: pixel X → (fractional) frame. */
export function xToFrame(
  x: number,
  frameStart: number,
  frameEnd: number,
  width: number,
): number {
  const plotW = Math.max(1, width - PAD_LEFT - PAD_RIGHT);
  const span = Math.max(1, frameEnd - frameStart);
  return frameStart + ((x - PAD_LEFT) / plotW) * span;
}

/** Tick spacing (frames) — 5 when frames are roomy, 10 when cramped. */
export function tickStep(frameStart: number, frameEnd: number, width: number): number {
  const plotW = Math.max(1, width - PAD_LEFT - PAD_RIGHT);
  const span = Math.max(1, frameEnd - frameStart);
  const pxPerFrame = plotW / span;
  return pxPerFrame >= 8 ? 5 : 10;
}

/** Round + clamp a (fractional) frame into [start, end]. */
export function clampFrame(frame: number, start: number, end: number): number {
  return Math.max(start, Math.min(end, Math.round(frame)));
}

export interface TimelineDeps {
  scene: Scene;
}

/** One diamond drawn on a track row (exposed for e2e via keyFramesShown). */
export interface DiamondInfo {
  objectId: number;
  name: string;
  frame: number;
  filled: boolean;
}

interface Row {
  object: SceneObject;
  diamonds: { frame: number; filled: boolean }[];
}

const ROW_H = 22;
const RULER_H = 24;

export class TimelinePane {
  readonly element: HTMLElement;
  private readonly scene: Scene;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx2d: CanvasRenderingContext2D;

  private readonly playBtn: HTMLButtonElement;
  private readonly frameInput: HTMLInputElement;
  private readonly startInput: HTMLInputElement;
  private readonly endInput: HTMLInputElement;
  private readonly fpsLabel: HTMLElement;

  private cssW = 0;
  private cssH = 0;

  // Playback: fractional playhead + last tick timestamp.
  private wasPlaying = false;
  private playPos = 0;
  private lastTick = 0;

  // Scrub drag state.
  private scrubbing = false;

  private rows: Row[] = [];

  private readonly onPointerDown: (e: PointerEvent) => void;
  private readonly onPointerMove: (e: PointerEvent) => void;
  private readonly onPointerUp: (e: PointerEvent) => void;

  private accent = '#fe730f';
  private accentTick = 0;

  constructor(deps: TimelineDeps) {
    this.scene = deps.scene;

    this.element = document.createElement('div');
    this.element.className = 'timeline';

    // --- Header row ---
    const header = document.createElement('div');
    header.className = 'timeline-header';

    const toStartBtn = document.createElement('button');
    toStartBtn.className = 'timeline-btn';
    toStartBtn.textContent = '⏮';
    toStartBtn.title = 'Jump to start frame';
    toStartBtn.addEventListener('click', () => this.jumpToStart());

    this.playBtn = document.createElement('button');
    this.playBtn.className = 'timeline-btn timeline-play';
    this.playBtn.textContent = '▶';
    this.playBtn.title = 'Play / Pause (Spacebar)';
    this.playBtn.addEventListener('click', () => this.togglePlay());

    const frameWrap = this.labeledInput('Frame', 'timeline-frame');
    this.frameInput = frameWrap.input;
    this.frameInput.addEventListener('change', () => {
      this.scrubTo(parseFloat(this.frameInput.value));
    });

    const startWrap = this.labeledInput('Start', 'timeline-start');
    this.startInput = startWrap.input;
    this.startInput.addEventListener('change', () => this.commitStart());

    const endWrap = this.labeledInput('End', 'timeline-end');
    this.endInput = endWrap.input;
    this.endInput.addEventListener('change', () => this.commitEnd());

    this.fpsLabel = document.createElement('span');
    this.fpsLabel.className = 'timeline-fps';

    header.append(
      toStartBtn, this.playBtn, frameWrap.wrap,
      startWrap.wrap, endWrap.wrap, this.fpsLabel,
    );

    // --- Canvas (ruler + tracks) ---
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'timeline-canvas';
    this.ctx2d = this.canvas.getContext('2d')!;

    this.element.append(header, this.canvas);

    // Scrub interactions on the canvas (NOT InputManager).
    this.onPointerDown = (e) => this.handlePointerDown(e);
    this.onPointerMove = (e) => this.handlePointerMove(e);
    this.onPointerUp = () => { this.scrubbing = false; };
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);

    // Debug handle for e2e (harmless in production).
    (window as unknown as Record<string, unknown>).__timeline = {
      keyFramesShown: (): DiamondInfo[] => this.keyFramesShown(),
      rowCount: (): number => this.rows.length,
      canvas: this.canvas,
      frameToX: (f: number) => frameToX(f, this.scene.frameStart, this.scene.frameEnd, this.cssW),
    };
  }

  private labeledInput(label: string, cls: string): { wrap: HTMLElement; input: HTMLInputElement } {
    const wrap = document.createElement('label');
    wrap.className = 'timeline-field';
    const span = document.createElement('span');
    span.textContent = label;
    const input = document.createElement('input');
    input.type = 'number';
    input.className = cls;
    wrap.append(span, input);
    return { wrap, input };
  }

  destroy(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    if ((window as unknown as Record<string, unknown>).__timeline &&
        ((window as unknown as { __timeline: { canvas: HTMLCanvasElement } }).__timeline.canvas === this.canvas)) {
      delete (window as unknown as Record<string, unknown>).__timeline;
    }
  }

  // --- Playback ------------------------------------------------------------

  private togglePlay(): void {
    this.scene.playing = !this.scene.playing;
  }

  private jumpToStart(): void {
    this.scene.frameCurrent = this.scene.frameStart;
    this.playPos = this.scene.frameStart;
    applyAnimation(this.scene, this.scene.frameCurrent);
  }

  // --- Scrubbing -----------------------------------------------------------

  private localX(e: { clientX: number }): number {
    return e.clientX - this.canvas.getBoundingClientRect().left;
  }

  private handlePointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    this.scrubbing = true;
    this.scrubTo(xToFrame(this.localX(e), this.scene.frameStart, this.scene.frameEnd, this.cssW));
  }

  private handlePointerMove(e: PointerEvent): void {
    if (!this.scrubbing) return;
    this.scrubTo(xToFrame(this.localX(e), this.scene.frameStart, this.scene.frameEnd, this.cssW));
  }

  /** Set frameCurrent (rounded, clamped) + run the sampler. NOT undoable. */
  private scrubTo(frame: number): void {
    if (!Number.isFinite(frame)) return;
    const f = clampFrame(frame, this.scene.frameStart, this.scene.frameEnd);
    this.scene.frameCurrent = f;
    this.playPos = f;
    applyAnimation(this.scene, f);
  }

  private commitStart(): void {
    const v = Math.max(0, Math.round(parseFloat(this.startInput.value)));
    if (!Number.isFinite(v)) return;
    this.scene.frameStart = v;
    if (this.scene.frameEnd <= v) this.scene.frameEnd = v + 1;
    this.reclampCurrent();
  }

  private commitEnd(): void {
    const v = Math.round(parseFloat(this.endInput.value));
    if (!Number.isFinite(v)) return;
    this.scene.frameEnd = Math.max(this.scene.frameStart + 1, v);
    this.reclampCurrent();
  }

  private reclampCurrent(): void {
    const f = clampFrame(this.scene.frameCurrent, this.scene.frameStart, this.scene.frameEnd);
    if (f !== this.scene.frameCurrent) {
      this.scene.frameCurrent = f;
      applyAnimation(this.scene, f);
    }
    this.playPos = this.scene.frameCurrent;
  }

  // --- Diamond data --------------------------------------------------------

  private computeRows(): Row[] {
    const rows: Row[] = [];
    for (const object of this.scene.selectedObjects) {
      const anim = object.anim;
      if (!anim || anim.fcurves.length === 0) continue;
      // Union of all key frames across this object's fcurves.
      const frames = new Set<number>();
      for (const c of anim.fcurves) for (const k of c.keys) frames.add(k.frame);
      const diamonds = [...frames].sort((a, b) => a - b).map((frame) => ({
        frame,
        filled: LOC_ROT_SCALE.every((path) => {
          const curve = findCurve(anim, path);
          return !!curve && curve.keys.some((k) => k.frame === frame);
        }),
      }));
      rows.push({ object, diamonds });
    }
    return rows;
  }

  /** Flat list of every diamond drawn (e2e handle). */
  keyFramesShown(): DiamondInfo[] {
    const out: DiamondInfo[] = [];
    for (const row of this.rows) {
      for (const d of row.diamonds) {
        out.push({ objectId: row.object.id, name: row.object.name, frame: d.frame, filled: d.filled });
      }
    }
    return out;
  }

  // --- Frame loop ----------------------------------------------------------

  update(): void {
    this.resize();
    if (this.accentTick-- <= 0) {
      this.accentTick = 60;
      const a = getComputedStyle(document.documentElement).getPropertyValue('--vb-accent').trim();
      if (a) this.accent = a;
    }
    this.advancePlayback();
    this.syncHeader();
    this.rows = this.computeRows();
    this.draw();
  }

  private advancePlayback(): void {
    const scene = this.scene;
    if (scene.playing) {
      const now = performance.now();
      if (!this.wasPlaying) {
        this.playPos = scene.frameCurrent;
        this.lastTick = now;
      }
      const dt = Math.max(0, (now - this.lastTick) / 1000);
      this.lastTick = now;
      const span = Math.max(1, scene.frameEnd - scene.frameStart);
      this.playPos += dt * scene.fps;
      // Loop start↔end.
      while (this.playPos > scene.frameEnd) this.playPos -= span;
      if (this.playPos < scene.frameStart) this.playPos = scene.frameStart;
      const f = Math.round(this.playPos);
      scene.frameCurrent = f;
      applyAnimation(scene, f);
    }
    this.wasPlaying = scene.playing;
  }

  private syncHeader(): void {
    this.playBtn.textContent = this.scene.playing ? '⏸' : '▶';
    this.playBtn.classList.toggle('is-playing', this.scene.playing);
    this.fpsLabel.textContent = `${this.scene.fps} fps`;
    if (document.activeElement !== this.frameInput) this.frameInput.value = String(this.scene.frameCurrent);
    if (document.activeElement !== this.startInput) this.startInput.value = String(this.scene.frameStart);
    if (document.activeElement !== this.endInput) this.endInput.value = String(this.scene.frameEnd);
  }

  private resize(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    const dpr = window.devicePixelRatio || 1;
    if (w !== this.cssW || h !== this.cssH || this.canvas.width !== Math.round(w * dpr)) {
      this.cssW = w;
      this.cssH = h;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  // --- Drawing -------------------------------------------------------------

  private draw(): void {
    const c = this.ctx2d;
    const W = this.cssW;
    const H = this.cssH;
    if (W === 0 || H === 0) return;
    const { frameStart, frameEnd } = this.scene;

    c.clearRect(0, 0, W, H);
    c.fillStyle = '#1c1c1c';
    c.fillRect(0, 0, W, H);

    // Ruler background.
    c.fillStyle = '#262626';
    c.fillRect(0, 0, W, RULER_H);

    // Ticks + numbers.
    const step = tickStep(frameStart, frameEnd, W);
    c.font = '10px monospace';
    c.textBaseline = 'middle';
    const first = Math.ceil(frameStart / step) * step;
    for (let f = first; f <= frameEnd; f += step) {
      const x = frameToX(f, frameStart, frameEnd, W);
      c.strokeStyle = '#3a3a3a';
      c.beginPath();
      c.moveTo(x + 0.5, RULER_H);
      c.lineTo(x + 0.5, H);
      c.stroke();
      c.strokeStyle = '#555';
      c.beginPath();
      c.moveTo(x + 0.5, RULER_H - 6);
      c.lineTo(x + 0.5, RULER_H);
      c.stroke();
      c.fillStyle = '#9a9a9a';
      c.textAlign = 'center';
      c.fillText(String(f), x, RULER_H / 2);
    }

    // Track rows: name label + diamonds.
    c.textAlign = 'left';
    this.rows.forEach((row, i) => {
      const y = RULER_H + i * ROW_H;
      if (y + ROW_H > H) return; // clip rows past the pane height
      if (i % 2 === 0) {
        c.fillStyle = 'rgba(255,255,255,0.03)';
        c.fillRect(0, y, W, ROW_H);
      }
      // Label gutter.
      c.fillStyle = '#c8c8c8';
      c.font = '11px sans-serif';
      const name = row.object.name.length > 12 ? row.object.name.slice(0, 11) + '…' : row.object.name;
      c.fillText(name, 6, y + ROW_H / 2);
      // Diamonds.
      const cy = y + ROW_H / 2;
      for (const d of row.diamonds) {
        const x = frameToX(d.frame, frameStart, frameEnd, W);
        this.drawDiamond(x, cy, d.filled);
      }
    });

    // Playhead.
    const px = frameToX(this.scene.frameCurrent, frameStart, frameEnd, W);
    c.strokeStyle = this.accent;
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(px + 0.5, 0);
    c.lineTo(px + 0.5, H);
    c.stroke();
    c.lineWidth = 1;
    // Playhead handle on the ruler.
    c.fillStyle = this.accent;
    c.beginPath();
    c.moveTo(px, RULER_H);
    c.lineTo(px - 5, RULER_H - 8);
    c.lineTo(px + 5, RULER_H - 8);
    c.closePath();
    c.fill();
  }

  private drawDiamond(x: number, y: number, filled: boolean): void {
    const c = this.ctx2d;
    const r = 4.5;
    c.beginPath();
    c.moveTo(x, y - r);
    c.lineTo(x + r, y);
    c.lineTo(x, y + r);
    c.lineTo(x - r, y);
    c.closePath();
    if (filled) {
      c.fillStyle = '#e6b400';
      c.fill();
    } else {
      c.fillStyle = '#1c1c1c';
      c.fill();
    }
    c.strokeStyle = '#e6b400';
    c.lineWidth = 1;
    c.stroke();
  }
}
