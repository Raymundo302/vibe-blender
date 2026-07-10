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
import { findCurve, INTERP_MODES, EASING_MODES, EASED_INTERPS } from '../core/anim/fcurve';
import { InsertKeysCommand, DeleteKeysCommand, LOC_ROT_SCALE } from '../core/anim/animCommands';
import { MoveKeysCommand, SetKeyInterpCommand, SetKeyEasingCommand, type KeyMove, type KeyInterpTarget } from '../core/anim/keyEditCommands';
import type { Interp, Easing, Keyframe } from '../core/anim/fcurve';
import { TransformCommand } from '../core/undo/commands';
import './timeline.css';

/**
 * Auto-key runtime flag (P15-3). Module-level state — NOT on Scene, NOT saved.
 * The topbar ⏺ button flips `enabled`; the Timeline pane polls the undo stack
 * in its update() and, when this is on, inserts LocRotScale keys for the
 * selected objects at frameCurrent whenever a fresh TransformCommand lands.
 */
export const autoKeyState = { enabled: false };

/**
 * Single playback clock (punch-list fix). The default Layout docks a Timeline
 * pane AND a user can switch another area to a second Timeline — two panes each
 * running advancePlayback() would advance scene.frameCurrent twice per rAF,
 * doubling playback speed. Module-scoped ownership: exactly ONE pane advances
 * the clock while playing; the other panes still REFLECT frameCurrent (their
 * ruler cursor reads the shared scene state each draw). A pane claims ownership
 * when playback is running and no one owns it, and releases it when playback
 * stops or the pane is destroyed.
 */
let playbackOwner: TimelinePane | null = null;

/**
 * Selection identity for a diamond (P16-3).
 * Object-row diamond (all channels at a frame): `${objectId}:${frame}`.
 * Channel sub-row diamond (one fcurve): `${objectId}:${frame}:${channelPath}`.
 * channelPaths never contain ':', so a plain split disambiguates.
 */
function keyOf(objectId: number, frame: number, channelPath?: string): string {
  return channelPath === undefined ? `${objectId}:${frame}` : `${objectId}:${frame}:${channelPath}`;
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

/**
 * Adaptive MAJOR grid step (frames) from the 1-2-5×10ⁿ ladder restricted to
 * {1, 5, 10, 50, 100, 500, ...}, picked so major lines sit ≥ `minPx` apart.
 * Zoom out → the step climbs (5→10→50→100); zoom in → it descends toward 1.
 * Minor lines are always major/5 (so major/minor === 5), and none when major
 * is 1 (a per-frame grid needs no sub-divisions).
 */
export function majorGridStep(
  viewStart: number,
  viewEnd: number,
  width: number,
  minPx = 60,
): number {
  const plotW = Math.max(1, width - PAD_LEFT - PAD_RIGHT);
  const span = Math.max(1e-6, viewEnd - viewStart);
  const pxPerFrame = plotW / span;
  const mults = [5, 2]; // ×5, ×2 alternately → 1,5,10,50,100,500,…
  let major = 1;
  let i = 0;
  while (major * pxPerFrame < minPx && major < 1e9) {
    major *= mults[i % 2];
    i++;
  }
  return major;
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
  /** 'object' = header row (all-channels-at-frame); 'channel' = fcurve sub-row. */
  kind: 'object' | 'channel';
  object: SceneObject;
  /** Set on channel rows only. */
  channelPath?: string;
  diamonds: { frame: number; filled: boolean }[];
  /** Set on object rows only: is it currently expanded (twisty ▾)? */
  expanded?: boolean;
}

const ROW_H = 22;
const RULER_H = 24;
/** Twisty hit box (canvas-local px) in an object row's label gutter. */
const TWISTY_X0 = 2;
const TWISTY_X1 = 16;

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
  private readonly interpSelect: HTMLSelectElement;
  private readonly easingSelect: HTMLSelectElement;

  private cssW = 0;
  private cssH = 0;

  // Pane-local view window (float frames). ALL drawing + hit-testing map through
  // these — NOT scene.frameStart/End. The view NEVER auto-resets (editing the
  // Start/End header fields only moves the scene range, not the view); it changes
  // only via wheel zoom, MMB pan, and '.' zoom-to-selected.
  private viewStart = 0;
  private viewEnd = 1;

  // MMB pan drag state.
  private panning = false;
  private panLastX = 0;
  private panPointerId = -1;

  // Playback: fractional playhead + last tick timestamp.
  private wasPlaying = false;
  private playPos = 0;
  private lastTick = 0;

  // Scrub drag state.
  private scrubbing = false;

  // Keyframe selection + drag-move state (P15-3).
  private selection = new Set<string>(); // keyOf(objectId, frame[, channelPath])
  private expanded = new Set<number>(); // object ids whose channel sub-rows show
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
  private readonly onWheel: (e: WheelEvent) => void;
  private readonly onKeyDownCapture: (e: KeyboardEvent) => void;
  private readonly onEnter: () => void;
  private readonly onLeave: () => void;

  private accent = '#fe730f';
  private accentTick = 0;

  constructor(deps: TimelineDeps) {
    this.scene = deps.scene;

    // Initialise the view to the scene range padded ~2% (never auto-resets after).
    const span0 = Math.max(1, this.scene.frameEnd - this.scene.frameStart);
    const pad0 = span0 * 0.02;
    this.viewStart = this.scene.frameStart - pad0;
    this.viewEnd = this.scene.frameEnd + pad0;

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

    // Per-key interpolation picker (P16-3). Enabled only when keys are
    // selected; choosing a mode applies ONE SetKeyInterpCommand.
    const interpWrap = document.createElement('label');
    interpWrap.className = 'timeline-field timeline-interp-field';
    const interpSpan = document.createElement('span');
    interpSpan.textContent = 'Interp';
    this.interpSelect = document.createElement('select');
    this.interpSelect.className = 'timeline-interp';
    for (const { value, label } of INTERP_MODES) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      this.interpSelect.append(opt);
    }
    this.interpSelect.disabled = true;
    this.interpSelect.addEventListener('change', () => {
      this.applyInterp(this.interpSelect.value as Interp);
    });
    interpWrap.append(interpSpan, this.interpSelect);

    // Per-key easing-direction picker (the eased interp families). Enabled only
    // when keys are selected AND the selection's interp is an eased family;
    // greyed out otherwise (same disabled mechanism as the interp select).
    const easingWrap = document.createElement('label');
    easingWrap.className = 'timeline-field timeline-easing-field';
    const easingSpan = document.createElement('span');
    easingSpan.textContent = 'Easing';
    this.easingSelect = document.createElement('select');
    this.easingSelect.className = 'timeline-easing';
    for (const { value, label } of EASING_MODES) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      this.easingSelect.append(opt);
    }
    this.easingSelect.disabled = true;
    this.easingSelect.addEventListener('change', () => {
      this.applyEasing(this.easingSelect.value as Easing);
    });
    easingWrap.append(easingSpan, this.easingSelect);

    // Delete-selected-keys button — a discoverable alias for X / Delete.
    const delKeyBtn = document.createElement('button');
    delKeyBtn.className = 'timeline-btn timeline-delkey';
    delKeyBtn.textContent = '🔑 −';
    delKeyBtn.title = 'Delete selected keyframes (X)';
    delKeyBtn.addEventListener('click', () => this.deleteSelectedKeys());

    header.append(
      toStartBtn, this.playBtn, frameWrap.wrap,
      startWrap.wrap, endWrap.wrap, this.fpsLabel, interpWrap, easingWrap, delKeyBtn,
    );

    // --- Canvas (ruler + tracks) ---
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'timeline-canvas';
    this.ctx2d = this.canvas.getContext('2d')!;

    this.element.append(header, this.canvas);

    // Scrub / select / drag interactions on the canvas (NOT InputManager).
    this.onPointerDown = (e) => this.handlePointerDown(e);
    this.onPointerMove = (e) => this.handlePointerMove(e);
    this.onPointerUp = (e) => this.handlePointerUp(e);
    this.onWheel = (e) => this.handleWheel(e);
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });

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
      frameToX: (f: number) => this.xOf(f),
      selectedKeys: (): { objectId: number; frame: number; channelPath?: string }[] => this.selectedKeys(),
      diamondXY: (objectId: number, frame: number, channelPath?: string) => this.diamondXY(objectId, frame, channelPath),
      channelRows: (): { objectId: number; channelPath: string; frames: number[] }[] => this.channelRows(),
      toggleExpand: (objectId: number) => { this.toggleExpand(objectId); },
      view: (): { start: number; end: number } => ({ start: this.viewStart, end: this.viewEnd }),
      setView: (start: number, end: number) => { this.applyView(start, end); },
      gridSteps: (): { major: number; minor: number } => this.gridSteps(),
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
    if (playbackOwner === this) playbackOwner = null;
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
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

  // --- View transform ------------------------------------------------------

  /** Pixel X of a (fractional) frame through the current view window. */
  private xOf(frame: number): number {
    return frameToX(frame, this.viewStart, this.viewEnd, this.cssW);
  }

  /** Canvas-local pixel X → (fractional) frame through the current view. */
  private frameOf(x: number): number {
    return xToFrame(x, this.viewStart, this.viewEnd, this.cssW);
  }

  /**
   * Set the view window with a graceful degenerate guard: min span 0.25 frames,
   * max span 100× the scene range (clamped about the window centre).
   */
  private applyView(start: number, end: number): void {
    let s = start, e = end;
    if (!Number.isFinite(s) || !Number.isFinite(e)) return;
    if (e < s) [s, e] = [e, s];
    const span = e - s;
    const sceneSpan = Math.max(1, this.scene.frameEnd - this.scene.frameStart);
    const minSpan = 0.25;
    const maxSpan = sceneSpan * 100;
    if (span < minSpan) {
      const c = (s + e) / 2;
      s = c - minSpan / 2; e = c + minSpan / 2;
    } else if (span > maxSpan) {
      const c = (s + e) / 2;
      s = c - maxSpan / 2; e = c + maxSpan / 2;
    }
    this.viewStart = s;
    this.viewEnd = e;
  }

  /** Zoom about the frame under canvas-local px `x` (that frame stays put). */
  private zoomAt(x: number, factor: number): void {
    const fa = this.frameOf(x);
    this.applyView(fa + (this.viewStart - fa) * factor, fa + (this.viewEnd - fa) * factor);
  }

  /** Pan the view by a pixel delta (drag-right shows earlier frames). */
  private panByPx(dxPx: number): void {
    const plotW = Math.max(1, this.cssW - PAD_LEFT - PAD_RIGHT);
    const span = this.viewEnd - this.viewStart;
    const dFrame = -dxPx * (span / plotW);
    this.applyView(this.viewStart + dFrame, this.viewEnd + dFrame);
  }

  private handleWheel(e: WheelEvent): void {
    e.preventDefault();
    // ~1.15 per notch; scroll up (deltaY<0) zooms in (view span shrinks).
    const factor = e.deltaY < 0 ? 1 / 1.15 : 1.15;
    this.zoomAt(this.localX(e), factor);
  }

  /** Zoom the view to the selected keys (+10% margin); no selection → fit scene. */
  private zoomToSelected(): void {
    const frames = this.selectedKeys().map((k) => k.frame);
    if (frames.length === 0) {
      const pad = Math.max(1, this.scene.frameEnd - this.scene.frameStart) * 0.02;
      this.applyView(this.scene.frameStart - pad, this.scene.frameEnd + pad);
      return;
    }
    let min = Math.min(...frames);
    let max = Math.max(...frames);
    if (max - min < 1e-6) {
      // Single key/frame → a sensible ±5 frame window.
      min -= 5; max += 5;
    } else {
      const m = (max - min) * 0.1;
      min -= m; max += m;
    }
    this.applyView(min, max);
  }

  private gridSteps(): { major: number; minor: number } {
    const major = majorGridStep(this.viewStart, this.viewEnd, this.cssW);
    return { major, minor: major === 1 ? 0 : major / 5 };
  }

  private handlePointerDown(e: PointerEvent): void {
    // --- MMB → pan the view left/right ---
    if (e.button === 1) {
      e.preventDefault();
      this.panning = true;
      this.panLastX = e.clientX;
      this.panPointerId = e.pointerId;
      try { this.canvas.setPointerCapture(e.pointerId); } catch { /* no pointer id */ }
      this.canvas.classList.add('panning');
      return;
    }
    if (e.button !== 0) return;
    const x = this.localX(e);
    const y = this.localY(e);
    // --- Twisty toggle (object-row expand/collapse) takes priority ---
    const twisty = this.twistyHit(x, y);
    if (twisty !== null) {
      this.toggleExpand(twisty);
      return;
    }
    const hit = this.hitTest(x, y);
    if (hit) {
      // --- Select a diamond (shift extends/toggles) ---
      const id = keyOf(hit.objectId, hit.frame, hit.channelPath);
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
    this.scrubTo(this.frameOf(x));
  }

  private handlePointerMove(e: PointerEvent): void {
    if (this.panning) {
      const dx = e.clientX - this.panLastX;
      this.panLastX = e.clientX;
      this.panByPx(dx);
      return;
    }
    if (this.dragging) {
      const targetAnchor = clampFrame(
        this.frameOf(this.localX(e)),
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
    this.scrubTo(this.frameOf(this.localX(e)));
  }

  private handlePointerUp(e: PointerEvent): void {
    if (this.panning) {
      this.panning = false;
      this.canvas.classList.remove('panning');
      try { if (this.panPointerId >= 0) this.canvas.releasePointerCapture(this.panPointerId); } catch { /* already released */ }
      this.panPointerId = -1;
      return;
    }
    void e;
    if (this.dragging) {
      this.dragging = false;
      if (this.dragMoved && this.dragDelta !== 0) this.commitMove(this.dragDelta);
      this.dragDelta = 0;
      this.dragMoved = false;
    }
    this.scrubbing = false;
  }

  /** The object id whose twisty box is under (x, y), or null. */
  private twistyHit(x: number, y: number): number | null {
    if (y <= RULER_H || x < TWISTY_X0 || x > TWISTY_X1) return null;
    const rowIndex = Math.floor((y - RULER_H) / ROW_H);
    if (rowIndex < 0 || rowIndex >= this.rows.length) return null;
    const row = this.rows[rowIndex];
    return row.kind === 'object' ? row.object.id : null;
  }

  /** The diamond under (x, y) in canvas-local px, or null. */
  private hitTest(x: number, y: number): { objectId: number; frame: number; channelPath?: string } | null {
    if (y <= RULER_H) return null;
    const rowIndex = Math.floor((y - RULER_H) / ROW_H);
    if (rowIndex < 0 || rowIndex >= this.rows.length) return null;
    const row = this.rows[rowIndex];
    const cy = RULER_H + rowIndex * ROW_H + ROW_H / 2;
    if (Math.abs(y - cy) > 8) return null;
    for (const d of row.diamonds) {
      const dx = this.xOf(d.frame);
      if (Math.abs(x - dx) <= 6) return { objectId: row.object.id, frame: d.frame, channelPath: row.channelPath };
    }
    return null;
  }

  /**
   * Canvas-local center of a committed diamond (e2e helper), or null. Pass a
   * channelPath to target a channel sub-row diamond; omit for the object row.
   */
  private diamondXY(objectId: number, frame: number, channelPath?: string): { x: number; y: number } | null {
    const rowIndex = this.rows.findIndex((r) => r.object.id === objectId && r.channelPath === channelPath);
    if (rowIndex < 0) return null;
    const row = this.rows[rowIndex];
    if (!row.diamonds.some((d) => d.frame === frame)) return null;
    return {
      x: this.xOf(frame),
      y: RULER_H + rowIndex * ROW_H + ROW_H / 2,
    };
  }

  private selectedKeys(): { objectId: number; frame: number; channelPath?: string }[] {
    return [...this.selection].map((id) => {
      const parts = id.split(':');
      const objectId = Number(parts[0]);
      const frame = Number(parts[1]);
      const channelPath = parts.length > 2 ? parts.slice(2).join(':') : undefined;
      return { objectId, frame, channelPath };
    });
  }

  /** Channel sub-rows currently drawn (e2e handle). */
  private channelRows(): { objectId: number; channelPath: string; frames: number[] }[] {
    return this.rows
      .filter((r) => r.kind === 'channel')
      .map((r) => ({ objectId: r.object.id, channelPath: r.channelPath!, frames: r.diamonds.map((d) => d.frame) }));
  }

  /** Flip an object row between collapsed (object diamonds) and expanded. */
  private toggleExpand(objectId: number): void {
    if (this.expanded.has(objectId)) this.expanded.delete(objectId);
    else this.expanded.add(objectId);
    this.rows = this.computeRows();
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

  /**
   * Commit a horizontal drag of all selected diamonds as ONE MoveKeysCommand.
   * Grouped per (object, frame): a group of only channel sub-row diamonds moves
   * just those channels; if any object-row diamond is in the group it moves
   * every channel at the frame (channelPaths omitted).
   */
  private commitMove(delta: number): void {
    const moves: KeyMove[] = [];
    for (const g of this.groupSelection()) {
      const object = this.objectById(g.objectId);
      if (!object) continue;
      moves.push({ object, fromFrame: g.frame, toFrame: g.frame + delta, channelPaths: g.channelPaths });
    }
    const cmd = MoveKeysCommand.perform('Move Keyframes', moves);
    if (!cmd) return;
    this.getUndo()?.push(cmd);
    // Selection follows the keys to their new frames (identity preserved).
    const moved = new Set<string>();
    for (const { objectId, frame, channelPath } of this.selectedKeys()) {
      moved.add(keyOf(objectId, frame + delta, channelPath));
    }
    this.selection = moved;
    applyAnimation(this.scene, this.scene.frameCurrent);
  }

  /**
   * Resolve the current selection to concrete (object, channelPath, frame) key
   * targets. Channel sub-row diamonds → that one channel; object-row diamonds →
   * every channel keyed at the frame.
   */
  private resolveTargets(): { object: SceneObject; channelPath: string; frame: number }[] {
    const targets: { object: SceneObject; channelPath: string; frame: number }[] = [];
    for (const { objectId, frame, channelPath } of this.selectedKeys()) {
      const object = this.objectById(objectId);
      if (!object || !object.anim) continue;
      if (channelPath !== undefined) {
        const c = object.anim.fcurves.find((c) => c.channelPath === channelPath);
        if (c && c.keys.some((k) => k.frame === frame)) targets.push({ object, channelPath, frame });
      } else {
        for (const c of object.anim.fcurves) {
          if (c.keys.some((k) => k.frame === frame)) targets.push({ object, channelPath: c.channelPath, frame });
        }
      }
    }
    return targets;
  }

  /** Group the selection by (object, frame) with a channelPaths filter (undefined = all). */
  private groupSelection(): { objectId: number; frame: number; channelPaths?: string[] }[] {
    const map = new Map<string, { objectId: number; frame: number; channelPaths?: string[] }>();
    for (const { objectId, frame, channelPath } of this.selectedKeys()) {
      const key = `${objectId}:${frame}`;
      let g = map.get(key);
      if (!g) { g = { objectId, frame, channelPaths: [] }; map.set(key, g); }
      if (channelPath === undefined) g.channelPaths = undefined; // object row → all channels
      else if (g.channelPaths) g.channelPaths.push(channelPath);
    }
    return [...map.values()];
  }

  /** Delete the selected keys (channel sub-row = one channel; object row = all). */
  private deleteSelectedKeys(): void {
    if (this.selection.size === 0) return;
    const targets = this.resolveTargets();
    const cmd = DeleteKeysCommand.perform('Delete Keyframes', this.scene, targets);
    if (cmd) this.getUndo()?.push(cmd);
    this.selection.clear();
    applyAnimation(this.scene, this.scene.frameCurrent);
  }

  /** Apply an interpolation mode to the selected keys as ONE SetKeyInterpCommand. */
  private applyInterp(interp: Interp): void {
    if (this.selection.size === 0) return;
    const targets: KeyInterpTarget[] = this.resolveTargets();
    const cmd = SetKeyInterpCommand.perform('Set Key Interpolation', targets, interp);
    if (cmd) {
      this.getUndo()?.push(cmd);
      applyAnimation(this.scene, this.scene.frameCurrent);
    }
  }

  /** Apply an easing direction to the selected keys as ONE SetKeyEasingCommand. */
  private applyEasing(easing: Easing): void {
    if (this.selection.size === 0) return;
    const targets: KeyInterpTarget[] = this.resolveTargets();
    const cmd = SetKeyEasingCommand.perform('Set Key Easing', targets, easing);
    if (cmd) {
      this.getUndo()?.push(cmd);
      applyAnimation(this.scene, this.scene.frameCurrent);
    }
  }

  /** The concrete Keyframe objects currently targeted by the selection. */
  private selectedKeyframes(): Keyframe[] {
    const out: Keyframe[] = [];
    for (const t of this.resolveTargets()) {
      if (!t.object.anim) continue;
      const curve = findCurve(t.object.anim, t.channelPath);
      const key = curve?.keys.find((k) => k.frame === t.frame);
      if (key) out.push(key);
    }
    return out;
  }

  private handleKeyDown(e: KeyboardEvent): void {
    // '.' zooms the view to the selected keys — but ONLY when the pane is
    // hovered (the 3D viewport uses '.' for frame-selected; never swallow it
    // when the pointer isn't over the timeline).
    if (e.key === '.' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      if (!this.hovered) return;
      const af = document.activeElement;
      if (af && /^(INPUT|TEXTAREA|SELECT)$/.test(af.tagName)) return;
      e.preventDefault();
      e.stopPropagation();
      this.zoomToSelected();
      return;
    }
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
      // Union of all key frames across this object's fcurves (summary row).
      const frames = new Set<number>();
      for (const c of anim.fcurves) for (const k of c.keys) frames.add(k.frame);
      const expanded = this.expanded.has(object.id);
      const diamonds = [...frames].sort((a, b) => a - b).map((frame) => ({
        frame,
        filled: LOC_ROT_SCALE.every((path) => {
          const curve = findCurve(anim, path);
          return !!curve && curve.keys.some((k) => k.frame === frame);
        }),
      }));
      rows.push({ kind: 'object', object, diamonds, expanded });
      // When expanded: one sub-row per fcurve, with its own diamonds.
      if (expanded) {
        for (const c of anim.fcurves) {
          rows.push({
            kind: 'channel',
            object,
            channelPath: c.channelPath,
            diamonds: [...c.keys].sort((a, b) => a.frame - b.frame).map((k) => ({ frame: k.frame, filled: true })),
          });
        }
      }
    }
    return rows;
  }

  /** Flat list of every OBJECT-row diamond drawn (e2e handle; sub-rows excluded). */
  keyFramesShown(): DiamondInfo[] {
    const out: DiamondInfo[] = [];
    for (const row of this.rows) {
      if (row.kind !== 'object') continue;
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
      // Only ONE pane advances the shared clock (see playbackOwner). Others just
      // reflect scene.frameCurrent via draw(). Claim ownership if it is free.
      if (playbackOwner === null) playbackOwner = this;
      if (playbackOwner === this) {
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
    } else if (playbackOwner === this) {
      // Playback stopped (pause from any pane) — release the clock.
      playbackOwner = null;
    }
    this.wasPlaying = scene.playing;
  }

  private syncHeader(): void {
    this.playBtn.textContent = this.scene.playing ? '⏸' : '▶';
    this.playBtn.classList.toggle('is-playing', this.scene.playing);
    this.fpsLabel.textContent = `${this.scene.fps} fps`;
    // Interp picker is live only when keys are selected.
    if (document.activeElement !== this.interpSelect) this.interpSelect.disabled = this.selection.size === 0;
    // Easing picker: live only when keys are selected AND their interp is an
    // eased family; reflects the selection's easing when uniform, else Automatic.
    if (document.activeElement !== this.easingSelect) {
      const keys = this.selection.size > 0 ? this.selectedKeyframes() : [];
      const eased = keys.length > 0 && keys.every((k) => EASED_INTERPS.includes(k.interp));
      this.easingSelect.disabled = !eased;
      let uniform: Easing = 'auto';
      if (eased) {
        const first = keys[0].easing ?? 'auto';
        uniform = keys.every((k) => (k.easing ?? 'auto') === first) ? first : 'auto';
      }
      this.easingSelect.value = uniform;
    }
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

    // Frame-range band: a slightly lighter backdrop over [frameStart,frameEnd]
    // (Blender's in-range highlight). Behind everything but the base fill.
    {
      const bx0 = Math.max(0, this.xOf(frameStart));
      const bx1 = Math.min(W, this.xOf(frameEnd));
      if (bx1 > bx0) {
        c.fillStyle = 'rgba(255,255,255,0.035)';
        c.fillRect(bx0, 0, bx1 - bx0, H);
      }
    }

    // Ruler background.
    c.fillStyle = '#262626';
    c.fillRect(0, 0, W, RULER_H);

    // Adaptive recursive grid: major lines from the {1,5,10,50,…} ladder,
    // minor lines at major/5 (very subtle; none when the major step is 1).
    const major = majorGridStep(this.viewStart, this.viewEnd, W);
    const minor = major === 1 ? 0 : major / 5;
    c.font = '10px monospace';
    c.textBaseline = 'middle';

    // Minor lines first (drawn under the majors).
    if (minor > 0) {
      c.strokeStyle = 'rgba(255,255,255,0.045)';
      const firstMin = Math.ceil(this.viewStart / minor) * minor;
      for (let f = firstMin; f <= this.viewEnd; f += minor) {
        if (Math.abs(((f % major) + major) % major) < 1e-6) continue; // skip majors
        const x = this.xOf(f);
        c.beginPath();
        c.moveTo(x + 0.5, RULER_H);
        c.lineTo(x + 0.5, H);
        c.stroke();
      }
    }

    // Major lines + ruler ticks + frame numbers.
    const firstMaj = Math.ceil(this.viewStart / major) * major;
    for (let f = firstMaj; f <= this.viewEnd; f += major) {
      const x = this.xOf(f);
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
      c.fillText(String(Math.round(f)), x, RULER_H / 2);
    }

    // Track rows: label + diamonds.
    this.rows.forEach((row, i) => {
      const y = RULER_H + i * ROW_H;
      if (y + ROW_H > H) return; // clip rows past the pane height
      const cy = y + ROW_H / 2;
      if (i % 2 === 0) {
        c.fillStyle = 'rgba(255,255,255,0.03)';
        c.fillRect(0, y, W, ROW_H);
      }
      if (row.kind === 'object') {
        // Twisty glyph + object name.
        c.fillStyle = '#9a9a9a';
        c.font = '10px monospace';
        c.textAlign = 'left';
        c.fillText(row.expanded ? '▾' : '▸', TWISTY_X0 + 2, cy);
        c.fillStyle = '#c8c8c8';
        c.font = '11px sans-serif';
        const name = row.object.name.length > 10 ? row.object.name.slice(0, 9) + '…' : row.object.name;
        c.fillText(name, TWISTY_X1 + 2, cy);
      } else {
        // Channel sub-row: right-aligned small channelPath label in the gutter.
        c.fillStyle = '#8a8a8a';
        c.font = '9px monospace';
        c.textAlign = 'right';
        const label = row.channelPath ?? '';
        c.fillText(label, PAD_LEFT - 6, cy);
        c.textAlign = 'left';
      }
      // Diamonds (selected ones ride the live drag offset while dragging).
      for (const d of row.diamonds) {
        const selected = this.selection.has(keyOf(row.object.id, d.frame, row.channelPath));
        const drawFrame = selected && this.dragging ? d.frame + this.dragDelta : d.frame;
        const x = this.xOf(drawFrame);
        this.drawDiamond(x, cy, d.filled, selected);
      }
    });

    // Playhead.
    const px = this.xOf(this.scene.frameCurrent);
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
