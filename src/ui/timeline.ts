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
import type { UndoStack } from '../core/undo/UndoStack';
import { applyAnimation } from '../core/anim/sampler';
import { findCurve } from '../core/anim/fcurve';
import { InsertKeysCommand, DeleteKeysCommand, LOC_ROT_SCALE } from '../core/anim/animCommands';
import { MoveKeysCommand, type KeyMove } from '../core/anim/keyEditCommands';
import { TransformCommand } from '../core/undo/commands';
import './timeline.css';

/**
 * Auto-key runtime flag (P15-3). Module-level state — NOT on Scene, NOT saved.
 * The topbar ⏺ button flips `enabled`; the Timeline pane polls the undo stack
 * in its update() and, when this is on, inserts LocRotScale keys for the
 * selected objects at frameCurrent whenever a fresh TransformCommand lands.
 */
export const autoKeyState = { enabled: false };

/** `${objectId}:${frame}` identity for a selected diamond. */
function keyOf(objectId: number, frame: number): string {
  return `${objectId}:${frame}`;
}

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

  // Keyframe selection + drag-move state (P15-3).
  private selection = new Set<string>(); // keyOf(objectId, frame)
  private dragging = false;
  private dragMoved = false;
  private dragAnchorFrame = 0; // frame of the grabbed diamond
  private dragDelta = 0; // snapped integer frame offset applied to all selected
  private hovered = false; // pointer is over this pane (gates X/Delete)
  private lastPushCount = -1; // undo-stack push counter last seen (auto-key)

  private rows: Row[] = [];

  private readonly onPointerDown: (e: PointerEvent) => void;
  private readonly onPointerMove: (e: PointerEvent) => void;
  private readonly onPointerUp: (e: PointerEvent) => void;
  private readonly onKeyDownCapture: (e: KeyboardEvent) => void;
  private readonly onEnter: () => void;
  private readonly onLeave: () => void;

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

    // Delete-selected-keys button — a discoverable alias for X / Delete.
    const delKeyBtn = document.createElement('button');
    delKeyBtn.className = 'timeline-btn timeline-delkey';
    delKeyBtn.textContent = '🔑 −';
    delKeyBtn.title = 'Delete selected keyframes (X)';
    delKeyBtn.addEventListener('click', () => this.deleteSelectedKeys());

    header.append(
      toStartBtn, this.playBtn, frameWrap.wrap,
      startWrap.wrap, endWrap.wrap, this.fpsLabel, delKeyBtn,
    );

    // --- Canvas (ruler + tracks) ---
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'timeline-canvas';
    this.ctx2d = this.canvas.getContext('2d')!;

    this.element.append(header, this.canvas);

    // Scrub / select / drag interactions on the canvas (NOT InputManager).
    this.onPointerDown = (e) => this.handlePointerDown(e);
    this.onPointerMove = (e) => this.handlePointerMove(e);
    this.onPointerUp = () => this.handlePointerUp();
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);

    // Hover gate for X / Delete so the timeline only eats those keys when the
    // pointer is over it (otherwise object-mode X still deletes objects).
    this.onEnter = () => { this.hovered = true; };
    this.onLeave = () => { this.hovered = false; };
    this.element.addEventListener('pointerenter', this.onEnter);
    this.element.addEventListener('pointerleave', this.onLeave);

    // X / Delete deletes selected keyframes. Capture phase + stopPropagation so
    // it wins over InputManager's window (bubble-phase) object-delete handler.
    this.onKeyDownCapture = (e) => this.handleKeyDown(e);
    window.addEventListener('keydown', this.onKeyDownCapture, true);

    // Debug handle for e2e (harmless in production).
    (window as unknown as Record<string, unknown>).__timeline = {
      keyFramesShown: (): DiamondInfo[] => this.keyFramesShown(),
      rowCount: (): number => this.rows.length,
      canvas: this.canvas,
      frameToX: (f: number) => frameToX(f, this.scene.frameStart, this.scene.frameEnd, this.cssW),
      selectedKeys: (): { objectId: number; frame: number }[] => this.selectedKeys(),
      diamondXY: (objectId: number, frame: number) => this.diamondXY(objectId, frame),
      autoKey: autoKeyState,
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
    window.removeEventListener('keydown', this.onKeyDownCapture, true);
    this.element.removeEventListener('pointerenter', this.onEnter);
    this.element.removeEventListener('pointerleave', this.onLeave);
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

  private localY(e: { clientY: number }): number {
    return e.clientY - this.canvas.getBoundingClientRect().top;
  }

  private handlePointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const x = this.localX(e);
    const y = this.localY(e);
    const hit = this.hitTest(x, y);
    if (hit) {
      // --- Select a diamond (shift extends/toggles) ---
      const id = keyOf(hit.objectId, hit.frame);
      if (e.shiftKey) {
        if (this.selection.has(id)) this.selection.delete(id);
        else this.selection.add(id);
      } else if (!this.selection.has(id)) {
        this.selection.clear();
        this.selection.add(id);
      }
      // Begin a potential drag of the whole selection.
      this.dragging = this.selection.has(id);
      this.dragMoved = false;
      this.dragAnchorFrame = hit.frame;
      this.dragDelta = 0;
      return;
    }
    // Empty ruler / track → scrub (clears selection unless shift-adding).
    if (!e.shiftKey) this.selection.clear();
    this.scrubbing = true;
    this.scrubTo(xToFrame(x, this.scene.frameStart, this.scene.frameEnd, this.cssW));
  }

  private handlePointerMove(e: PointerEvent): void {
    if (this.dragging) {
      const targetAnchor = clampFrame(
        xToFrame(this.localX(e), this.scene.frameStart, this.scene.frameEnd, this.cssW),
        // Keys may live outside [start,end]; allow the anchor anywhere ≥ 0.
        0, Number.MAX_SAFE_INTEGER,
      );
      const delta = targetAnchor - this.dragAnchorFrame;
      if (delta !== this.dragDelta) {
        this.dragDelta = delta;
        if (delta !== 0) this.dragMoved = true;
      }
      return;
    }
    if (!this.scrubbing) return;
    this.scrubTo(xToFrame(this.localX(e), this.scene.frameStart, this.scene.frameEnd, this.cssW));
  }

  private handlePointerUp(): void {
    if (this.dragging) {
      this.dragging = false;
      if (this.dragMoved && this.dragDelta !== 0) this.commitMove(this.dragDelta);
      this.dragDelta = 0;
      this.dragMoved = false;
    }
    this.scrubbing = false;
  }

  /** The diamond under (x, y) in canvas-local px, or null. */
  private hitTest(x: number, y: number): { objectId: number; frame: number } | null {
    if (y <= RULER_H) return null;
    const rowIndex = Math.floor((y - RULER_H) / ROW_H);
    if (rowIndex < 0 || rowIndex >= this.rows.length) return null;
    const row = this.rows[rowIndex];
    const cy = RULER_H + rowIndex * ROW_H + ROW_H / 2;
    if (Math.abs(y - cy) > 8) return null;
    for (const d of row.diamonds) {
      const dx = frameToX(d.frame, this.scene.frameStart, this.scene.frameEnd, this.cssW);
      if (Math.abs(x - dx) <= 6) return { objectId: row.object.id, frame: d.frame };
    }
    return null;
  }

  /** Canvas-local center of a committed diamond (e2e helper), or null. */
  private diamondXY(objectId: number, frame: number): { x: number; y: number } | null {
    const rowIndex = this.rows.findIndex((r) => r.object.id === objectId);
    if (rowIndex < 0) return null;
    const row = this.rows[rowIndex];
    if (!row.diamonds.some((d) => d.frame === frame)) return null;
    return {
      x: frameToX(frame, this.scene.frameStart, this.scene.frameEnd, this.cssW),
      y: RULER_H + rowIndex * ROW_H + ROW_H / 2,
    };
  }

  private selectedKeys(): { objectId: number; frame: number }[] {
    return [...this.selection].map((id) => {
      const [objectId, frame] = id.split(':').map(Number);
      return { objectId, frame };
    });
  }

  private getUndo(): UndoStack | null {
    const app = (window as unknown as { __app?: { undo?: UndoStack } }).__app;
    return app?.undo ?? null;
  }

  /** Resolve selected object ids → SceneObject via the currently drawn rows. */
  private objectById(id: number): SceneObject | undefined {
    return this.rows.find((r) => r.object.id === id)?.object
      ?? this.scene.objects.find((o) => o.id === id);
  }

  /** Commit a horizontal drag of all selected diamonds as ONE MoveKeysCommand. */
  private commitMove(delta: number): void {
    const moves: KeyMove[] = [];
    for (const { objectId, frame } of this.selectedKeys()) {
      const object = this.objectById(objectId);
      if (object) moves.push({ object, fromFrame: frame, toFrame: frame + delta });
    }
    const cmd = MoveKeysCommand.perform('Move Keyframes', moves);
    if (!cmd) return;
    this.getUndo()?.push(cmd);
    // Selection follows the keys to their new frames.
    const moved = new Set<string>();
    for (const { objectId, frame } of this.selectedKeys()) moved.add(keyOf(objectId, frame + delta));
    this.selection = moved;
    applyAnimation(this.scene, this.scene.frameCurrent);
  }

  /** Delete every channel keyed at each selected diamond's frame (undoable). */
  private deleteSelectedKeys(): void {
    if (this.selection.size === 0) return;
    const targets: { object: SceneObject; channelPath: string; frame: number }[] = [];
    for (const { objectId, frame } of this.selectedKeys()) {
      const object = this.objectById(objectId);
      if (!object || !object.anim) continue;
      for (const c of object.anim.fcurves) {
        if (c.keys.some((k) => k.frame === frame)) targets.push({ object, channelPath: c.channelPath, frame });
      }
    }
    const cmd = DeleteKeysCommand.perform('Delete Keyframes', this.scene, targets);
    if (cmd) this.getUndo()?.push(cmd);
    this.selection.clear();
    applyAnimation(this.scene, this.scene.frameCurrent);
  }

  private handleKeyDown(e: KeyboardEvent): void {
    // Only claim X / Delete when the pane is hovered AND has a key selection,
    // and no form field is focused — otherwise let it fall through to the app.
    const isDelete = e.key === 'x' || e.key === 'X' || e.key === 'Delete';
    if (!isDelete || e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
    if (!this.hovered || this.selection.size === 0) return;
    const a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
    e.preventDefault();
    e.stopPropagation();
    this.deleteSelectedKeys();
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
    this.pollAutoKey();
    this.syncHeader();
    this.rows = this.computeRows();
    this.draw();
  }

  /**
   * Auto-key (P15-3). Watches the undo stack's monotonic push counter; when a
   * NEW command lands and it's a TransformCommand (a confirmed G/R/S in Object
   * Mode) while auto-key is on, insert LocRotScale keys for the selected
   * objects at frameCurrent — pushed as its own InsertKeysCommand so it's
   * undoable. pushCount (not peek identity) is used so undo/redo revealing an
   * older TransformCommand never re-fires. This is the whole wiring: no hooks
   * in the operators or InputManager.
   */
  private pollAutoKey(): void {
    const undo = this.getUndo();
    if (!undo) return;
    const pc = undo.pushCount;
    if (this.lastPushCount === -1) { this.lastPushCount = pc; return; } // prime, don't key history
    if (pc === this.lastPushCount) return;
    const top = undo.peek();
    if (autoKeyState.enabled && !this.scene.editMode && top instanceof TransformCommand) {
      const objects = this.scene.selectedObjects;
      if (objects.length) {
        const cmd = InsertKeysCommand.perform('Auto Keyframe', this.scene, objects, LOC_ROT_SCALE, this.scene.frameCurrent);
        if (cmd) undo.push(cmd);
      }
    }
    this.lastPushCount = undo.pushCount; // re-read: covers our own insert push
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
      // Diamonds (selected ones ride the live drag offset while dragging).
      const cy = y + ROW_H / 2;
      for (const d of row.diamonds) {
        const selected = this.selection.has(keyOf(row.object.id, d.frame));
        const drawFrame = selected && this.dragging ? d.frame + this.dragDelta : d.frame;
        const x = frameToX(drawFrame, frameStart, frameEnd, W);
        this.drawDiamond(x, cy, d.filled, selected);
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

  private drawDiamond(x: number, y: number, filled: boolean, selected = false): void {
    const c = this.ctx2d;
    const r = selected ? 5.5 : 4.5;
    c.beginPath();
    c.moveTo(x, y - r);
    c.lineTo(x + r, y);
    c.lineTo(x, y + r);
    c.lineTo(x - r, y);
    c.closePath();
    if (selected) {
      c.fillStyle = filled ? '#ffffff' : '#333';
      c.fill();
      c.strokeStyle = '#ffffff';
      c.lineWidth = 1.5;
      c.stroke();
    } else {
      c.fillStyle = filled ? '#e6b400' : '#1c1c1c';
      c.fill();
      c.strokeStyle = '#e6b400';
      c.lineWidth = 1;
      c.stroke();
    }
  }
}
