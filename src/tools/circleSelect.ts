import type { Operator, OperatorContext, PointerState } from '../core/operator/Operator';
import type { EditableMesh } from '../core/mesh/EditableMesh';
import type { ElementMode, EditModeState } from '../core/scene/EditMode';
import type { Mat4 } from '../core/math/mat4';
import type { Command } from '../core/undo/UndoStack';
import type { UndoStack } from '../core/undo/UndoStack';
import { elementIndexMaps } from '../core/mesh/editOverlayData';
import { projectToScreen } from './boxSelect';

/**
 * UR5-4 — the persistent app-level *select mode*. Box select was the only area
 * select; Circle + Lasso join it and W cycles between the three. The mode is
 * module-level state (the same pattern as `xrayState` in elementPickPass.ts and
 * `sculptState` in sculptBrushes.ts) and is session-only — NOT persisted, just
 * like X-ray. B ("start area select") starts whatever shape this mode names.
 */
export type SelectMode = 'box' | 'circle' | 'lasso';

export const selectModeState: { mode: SelectMode } = { mode: 'box' };

/** Cycle Box → Circle → Lasso → Box and return the new mode. */
export function cycleSelectMode(): SelectMode {
  const order: SelectMode[] = ['box', 'circle', 'lasso'];
  const next = order[(order.indexOf(selectModeState.mode) + 1) % order.length];
  selectModeState.mode = next;
  return next;
}

/** Human label for the status line ("Select: Circle"). */
export function selectModeLabel(mode: SelectMode): string {
  return mode === 'box' ? 'Box' : mode === 'circle' ? 'Circle' : 'Lasso';
}

/**
 * Circle-select brush radius in CSS pixels. Module-level so it persists across
 * paint sessions (like Blender's C radius); the wheel adjusts it, clamped 5–200.
 */
export const circleSelectState: { radius: number } = { radius: 30 };
const RADIUS_MIN = 5;
const RADIUS_MAX = 200;

// --- Selection-snapshot undo command ---------------------------------------

/** A copy of one EditModeState's selected element ids, for undo. */
export interface SelectionSnapshot {
  verts: number[];
  edges: string[];
  faces: number[];
}

/** Snapshot the current selection sets (order-independent copy). */
export function captureSelection(sel: EditModeState): SelectionSnapshot {
  return { verts: [...sel.verts], edges: [...sel.edges], faces: [...sel.faces] };
}

function sameIds<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  for (const x of b) if (!set.has(x)) return false;
  return true;
}

/** True when two snapshots hold the same element ids (order-independent). */
export function selectionEquals(a: SelectionSnapshot, b: SelectionSnapshot): boolean {
  return sameIds(a.verts, b.verts) && sameIds(a.edges, b.edges) && sameIds(a.faces, b.faces);
}

/**
 * Undo entry for an area-select selection change (circle/lasso). Restores the
 * BEFORE snapshot on undo, the AFTER snapshot on redo — the selection sets are
 * the only state that changed, so this is a pure selection command.
 */
export class SelectionCommand implements Command {
  constructor(
    readonly name: string,
    private readonly sel: EditModeState,
    private readonly before: SelectionSnapshot,
    private readonly after: SelectionSnapshot,
  ) {}

  private restore(s: SelectionSnapshot): void {
    this.sel.verts.clear();
    this.sel.edges.clear();
    this.sel.faces.clear();
    for (const v of s.verts) this.sel.verts.add(v);
    for (const e of s.edges) this.sel.edges.add(e);
    for (const f of s.faces) this.sel.faces.add(f);
    this.sel.touch();
  }

  undo(): void { this.restore(this.before); }
  redo(): void { this.restore(this.after); }
}

/**
 * Push ONE undo entry for the selection change from `before` to the current
 * state, or nothing when unchanged. Returns true when an entry was pushed. This
 * is the "one undo entry / no entry when unchanged" contract circle + lasso
 * share.
 */
export function commitSelectionChange(
  undo: UndoStack,
  sel: EditModeState,
  before: SelectionSnapshot,
  name: string,
): boolean {
  const after = captureSelection(sel);
  if (selectionEquals(before, after)) return false;
  undo.push(new SelectionCommand(name, sel, before, after));
  return true;
}

// --- Circle membership (pure) ----------------------------------------------

/**
 * Pure inside-circle test for the current element mode. `mvp` = proj·view·model
 * so local vert coordinates project straight to CSS pixels. Membership mirrors
 * box select's SPIRIT with a circle instead of a rect: a vert counts when its
 * projected point is within `r` of the circle centre; an edge when EITHER
 * endpoint is inside; a face when ANY of its verts is inside. Like box select
 * this is a pure screen-projection test with NO depth/occlusion — it selects
 * through geometry exactly as box select does today.
 */
export function elementsInCircle(
  mesh: EditableMesh,
  mode: ElementMode,
  mvp: Mat4,
  width: number,
  height: number,
  cx: number,
  cy: number,
  r: number,
): { verts: number[]; edges: string[]; faces: number[] } {
  const maps = elementIndexMaps(mesh);
  const proj = new Map<number, { x: number; y: number } | null>();
  for (const [id, v] of mesh.verts) proj.set(id, projectToScreen(v.co, mvp, width, height));
  const r2 = r * r;
  const inside = (id: number): boolean => {
    const p = proj.get(id) ?? null;
    if (p === null) return false;
    const dx = p.x - cx;
    const dy = p.y - cy;
    return dx * dx + dy * dy <= r2;
  };

  const out = { verts: [] as number[], edges: [] as string[], faces: [] as number[] };
  if (mode === 'vert') {
    for (const id of maps.vertIds) if (inside(id)) out.verts.push(id);
  } else if (mode === 'edge') {
    const edges = mesh.edges();
    for (const key of maps.edgeKeys) {
      const e = edges.get(key);
      if (e && (inside(e.v0) || inside(e.v1))) out.edges.push(key);
    }
  } else {
    for (const fid of maps.faceIds) {
      const f = mesh.faces.get(fid);
      if (f && f.verts.some((v) => inside(v))) out.faces.push(fid);
    }
  }
  return out;
}

/**
 * C — circle (brush-paint) select, modal like Blender's C. A circle cursor of
 * radius r follows the pointer; LMB-drag paints elements inside the circle INTO
 * the selection, Ctrl-drag REMOVES them (Ctrl-drag is the one chosen deselect
 * gesture). The wheel adjusts r (5–200). Esc/Enter/RMB all END the tool — and
 * because a circle session commits its selection on exit, ending it any way
 * commits (there is no "cancel that restores"; that matches Blender's C, where
 * Esc leaves the tool keeping what you painted). The whole paint session is ONE
 * undo entry (before-state captured at start, compared on exit; no entry when
 * nothing changed).
 */
export class CircleSelectOperator implements Operator {
  readonly name = 'Circle Select';
  readonly continuousGrab = false;

  private cx = 0;
  private cy = 0;
  private painting = false;
  private subtract = false;
  private before: SelectionSnapshot | null = null;
  private svg: SVGSVGElement | null = null;

  constructor(private readonly parent: HTMLElement) {}

  start(ctx: OperatorContext, pointer: PointerState): boolean {
    const sel = ctx.scene.editMode;
    if (!sel || !ctx.scene.editObject) return false;
    this.cx = pointer.x;
    this.cy = pointer.y;
    this.before = captureSelection(sel);
    this.createOverlay();
    this.redraw();
    ctx.setStatus(
      'Circle select — LMB paint, Ctrl+LMB deselect, wheel: radius, Esc/Enter/RMB: end',
    );
    return true;
  }

  /** InputManager: LMB pressed → begin a paint stroke (Ctrl → deselect). */
  beginPaint(subtract: boolean): void {
    this.painting = true;
    this.subtract = subtract;
  }

  /** InputManager: LMB released → end the current paint stroke (tool stays modal). */
  endPaint(): void {
    this.painting = false;
  }

  onPointerMove(ctx: OperatorContext, pointer: PointerState): void {
    this.cx = pointer.x;
    this.cy = pointer.y;
    if (this.painting) this.paint(ctx);
    this.redraw();
  }

  /** Wheel handler: grow/shrink the brush, clamped, and redraw. */
  adjustRadius(deltaY: number): void {
    const factor = deltaY < 0 ? 1.1 : 1 / 1.1;
    circleSelectState.radius = Math.min(
      RADIUS_MAX,
      Math.max(RADIUS_MIN, circleSelectState.radius * factor),
    );
    this.redraw();
  }

  onKey(): boolean {
    return false;
  }

  /** Paint the elements currently under the circle into (or out of) selection. */
  private paint(ctx: OperatorContext): void {
    const sel = ctx.scene.editMode;
    const obj = ctx.scene.editObject;
    if (!sel || !obj) return;
    const { width, height } = ctx.viewportSize();
    const mvp = ctx.camera
      .projMatrix(width / height)
      .mul(ctx.camera.viewMatrix())
      .mul(ctx.scene.worldMatrix(obj));
    const hits = elementsInCircle(
      obj.mesh,
      sel.elementMode,
      mvp,
      width,
      height,
      this.cx,
      this.cy,
      circleSelectState.radius,
    );
    let changed = false;
    if (sel.elementMode === 'vert') {
      for (const id of hits.verts) changed = (this.subtract ? sel.verts.delete(id) : add(sel.verts, id)) || changed;
    } else if (sel.elementMode === 'edge') {
      for (const key of hits.edges) changed = (this.subtract ? sel.edges.delete(key) : add(sel.edges, key)) || changed;
    } else {
      for (const id of hits.faces) changed = (this.subtract ? sel.faces.delete(id) : add(sel.faces, id)) || changed;
    }
    if (changed) sel.touch();
  }

  /** Commit the whole paint session as ONE undo entry (Esc/Enter/RMB all land here). */
  private commit(ctx: OperatorContext): void {
    const sel = ctx.scene.editMode;
    if (sel && this.before) commitSelectionChange(ctx.undo, sel, this.before, 'Circle Select');
    this.cleanup(ctx);
  }

  confirm(ctx: OperatorContext): void {
    this.commit(ctx);
  }

  cancel(ctx: OperatorContext): void {
    // Circle has no restoring cancel: ending the tool (Esc/RMB) commits the paint.
    this.commit(ctx);
  }

  // --- SVG overlay (mirrors knife's screen-space overlay) --------------------

  private createOverlay(): void {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'circle-select-overlay');
    Object.assign(svg.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      zIndex: '30',
    } as CSSStyleDeclaration);
    this.parent.appendChild(svg);
    this.svg = svg;
  }

  private redraw(): void {
    const svg = this.svg;
    if (!svg) return;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const NS = 'http://www.w3.org/2000/svg';
    const circle = document.createElementNS(NS, 'circle');
    circle.setAttribute('cx', String(this.cx));
    circle.setAttribute('cy', String(this.cy));
    circle.setAttribute('r', String(circleSelectState.radius));
    circle.setAttribute('fill', 'none');
    circle.setAttribute('stroke', '#ffffff');
    circle.setAttribute('stroke-width', '1.5');
    circle.setAttribute('stroke-dasharray', '4 4');
    svg.appendChild(circle);
  }

  private cleanup(ctx: OperatorContext): void {
    this.svg?.remove();
    this.svg = null;
    this.painting = false;
    this.before = null;
    ctx.setStatus('');
  }
}

function add<T>(set: Set<T>, x: T): boolean {
  if (set.has(x)) return false;
  set.add(x);
  return true;
}
