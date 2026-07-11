import type { Operator, OperatorContext, PointerState } from '../core/operator/Operator';
import { ModalPointer } from './modalPointer';
import type { Renderer } from '../render/Renderer';
import type { Scene, SceneObject } from '../core/scene/Scene';
import { TranslateOperator } from '../tools/translate';
import { RotateOperator } from '../tools/rotate';
import { ScaleOperator } from '../tools/scale';
import { EditTranslateOperator, EditRotateOperator, EditScaleOperator, EditTransformBase, proportional } from '../tools/editTransform';
import { EdgeSlideOperator } from '../tools/edgeSlide';
import { NormalMoveOperator } from '../tools/normalMove';
import { ExtrudeOperator } from '../tools/extrude';
import { InsetOperator } from '../tools/inset';
import { BoxSelectOperator, invertSelection } from '../tools/boxSelect';
import { LoopCutOperator } from '../tools/loopCut';
import { KnifeOperator } from '../tools/knife';
import { BevelOperator } from '../tools/bevel';
import { CreaseOperator } from '../tools/creaseOp';
import { fillVerts, fillEdges } from '../core/mesh/ops/fill';
import { subdivideFaces } from '../core/mesh/ops/subdivide';
import { duplicateFaces } from '../core/mesh/ops/duplicateFaces';
import { recalcNormals } from '../core/mesh/ops/recalcNormals';
import { edgeLoop, vertLoop, faceLoop } from '../core/mesh/ops/loopSelect';
import { EditableMesh } from '../core/mesh/EditableMesh';
import { frameSelection } from '../tools/frame';
import { cameraTransformFromView } from '../tools/cameraToView';
import { OrbitCamera } from '../camera/OrbitCamera';
import { objectForward } from '../core/scene/objectData';
import { Vec3 } from '../core/math/vec3';
import { Transform } from '../core/math/transform';
import type { Mat4 } from '../core/math/mat4';
import type { EditModeState } from '../core/scene/EditMode';
import { rayPlane } from '../core/math/ray';
import {
  sculptState,
  brushWeights,
  inflateDeltas,
  grabPositions,
  raycastMeshLocal,
  buildBrushCircle,
  type SculptTool,
} from '../tools/sculptBrushes';
import { MeshEditCommand } from '../core/undo/meshCommands';
import { AddMenu } from '../ui/addMenu';
import { PieMenu } from '../ui/pieMenu';
import { cursorToOrigin, cursorToSelected, cursorToGrid, selectionToCursor, selectionToGrid } from '../tools/snapOps';
import { CollectionMenu } from '../ui/collectionMenu';
import { KeyingMenu } from '../ui/keyingMenu';
import { DeleteMenu, mergeAtCenter } from '../ui/deleteMenu';
import { EdgeMenu } from '../ui/edgeMenu';
import { UvMenu } from '../ui/uvMenu';
import { AddObjectsCommand, DeleteObjectsCommand, SetParentCommand } from '../core/undo/objectCommands';
import { TransformCommand } from '../core/undo/commands';
import { snapState } from '../core/snap';
import { xrayState } from '../render/passes/elementPickPass';
import { JoinObjectsCommand } from '../core/undo/joinCommand';
import { SeparateCommand } from '../core/undo/separateCommand';

// --- Lock-Camera-to-View rig math (pure, unit-tested) ------------------------
//
// Blender's "Lock Camera to View" lets you fly the camera by navigating the
// viewport while looking through it. We model the interaction with a private
// turntable OrbitCamera "rig" seeded from the camera's pose, mutate the rig with
// the same orbit/pan/zoom math the main viewport uses, then write the rig pose
// back onto the camera object each nav event. These helpers are the pure seams:
// config-in / pose-out / change-detect, so the math is verifiable without DOM.

/**
 * Seed a fresh rig from a camera's world pose. eye = camera position; forward =
 * the camera's aim (local -Z); the orbit TARGET is placed forward by `d`, and
 * the rig's eye reconstructs EXACTLY back to the camera position for ANY d (the
 * pose is reproduced to epsilon — see the round-trip test), so the ONLY thing
 * `d` controls is the depth of the pivot the first orbit swings about.
 *
 * `preferredDistance` (the live viewport OrbitCamera's dolly distance) is used
 * when given so the locked fly continues at the SAME framing depth the user was
 * just navigating at — no lurch/teleport on the first orbit because the pivot
 * matches the view they came from. Without it (bare unit tests) we fall back to
 * the world-origin projection along the aim, clamped to 1..50, so a freshly
 * locked camera still turntables about roughly the scene centre. Either way the
 * result is clamped to a sane 0.1..500 band.
 */
export function configureRigFromCamera(rig: OrbitCamera, t: Transform, preferredDistance?: number): void {
  const eye = t.position;
  const forward = objectForward(t).normalize();
  let d: number;
  if (preferredDistance !== undefined && Number.isFinite(preferredDistance) && preferredDistance > 0) {
    d = Math.max(0.1, Math.min(500, preferredDistance));
  } else {
    // (origin - eye) · forward = how far ahead the origin is along the aim.
    const dRaw = Vec3.ZERO.sub(eye).dot(forward);
    d = Math.max(1, Math.min(50, dRaw));
  }
  rig.target = eye.add(forward.scale(d));
  rig.distance = d;
  // OrbitCamera reconstructs eye = target + dir(yaw,pitch)*distance, where the
  // offset direction is (eye - target)/d = -forward. Invert that to yaw/pitch.
  const n = forward.scale(-1);
  // Z-up: offset dir = (sin yaw·cosP, -cos yaw·cosP, sin pitch).
  rig.pitch = Math.asin(Math.max(-1, Math.min(1, n.z)));
  rig.yaw = Math.atan2(n.x, -n.y);
}

/** Write a rig's current pose back to a camera Transform (position + look-at). */
export function cameraPoseFromRig(rig: OrbitCamera): Transform {
  return cameraTransformFromView(rig.eye, rig.forward, Vec3.Z);
}

/** True if two poses differ in position or rotation beyond `eps` (quat double
 *  cover handled: q and -q are the same rotation). */
export function poseChanged(a: Transform, b: Transform, eps = 1e-6): boolean {
  if (a.position.distanceTo(b.position) > eps) return true;
  const qa = a.rotation, qb = b.rotation;
  const dot = qa.x * qb.x + qa.y * qb.y + qa.z * qb.z + qa.w * qb.w;
  return Math.abs(dot) < 1 - eps;
}

/**
 * Blender-style duplicate name: strip a trailing `.NNN`, then pick the lowest
 * unused 3-digit suffix across the whole scene (`Cube` → `Cube.001`).
 */
function nextDupName(scene: Scene, name: string): string {
  const base = name.replace(/\.\d{3}$/, '');
  const used = new Set(scene.objects.map((o) => o.name));
  for (let n = 1; n < 1000; n++) {
    const candidate = `${base}.${String(n).padStart(3, '0')}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}.001`;
}

/**
 * Shift+D in edit mode (face select): copy the selected faces INSIDE the mesh
 * (seam-free island — every vert duplicated, verts shared between two selected
 * faces get a single shared copy), select the copies, then ride the pointer with
 * a Move — exactly like object-mode Shift+D starts a TranslateOperator.
 *
 * Reuses all of EditTranslateOperator's move behaviour (view-plane drag, X/Y/Z
 * axis lock, grid snapping) by subclassing it, but wraps the WHOLE gesture in
 * ONE undo command (modal-TOPOLOGY pattern): snapshot before the copy, push
 * `MeshEditCommand.fromSnapshots` on confirm. Cancel (Esc/RMB) removes the
 * duplicated geometry entirely — a documented v1 deviation from Blender (which
 * leaves the copy in place), chosen for a cleaner "no stray geometry" result.
 */
class DuplicateFacesOperator extends EditTranslateOperator {
  private snapshot: EditableMesh | null = null;

  start(ctx: OperatorContext, pointer: PointerState): boolean {
    const sel = ctx.scene.editMode;
    const obj = ctx.scene.editObject;
    if (!sel || !obj || sel.elementMode !== 'face') return false;
    const faceIds = [...sel.faces].filter((id) => obj.mesh.faces.has(id));
    if (faceIds.length === 0) return false;

    const snapshot = obj.mesh.clone();
    const { newFaceIds } = duplicateFaces(obj.mesh, faceIds);
    sel.faces.clear();
    for (const id of newFaceIds) sel.faces.add(id);
    sel.touch();

    // Base start captures the (now-duplicated) selection's verts as the move set.
    if (!super.start(ctx, pointer)) {
      obj.mesh.copyFrom(snapshot);
      sel.prune(obj.mesh);
      sel.touch();
      return false;
    }
    this.snapshot = snapshot;
    return true;
  }

  onKey(ctx: OperatorContext, key: string): boolean {
    // Swallow a second G: Shift+D then G stays a plain Move, never Edge Slide.
    if (key.toLowerCase() === 'g') return true;
    return super.onKey(ctx, key);
  }

  confirm(ctx: OperatorContext): void {
    // Label the ONE combined command 'Duplicate' regardless of the base's 'Move'.
    ctx.undo.push(MeshEditCommand.fromSnapshots('Duplicate', this.mesh, this.snapshot!, this.mesh.clone()));
    this.sel.touch();
    if (this.renderer && this.proportionalActive) this.renderer.editPreviewLines = null;
    ctx.setStatus('');
  }

  cancel(ctx: OperatorContext): void {
    this.mesh.copyFrom(this.snapshot!);
    this.sel.prune(this.mesh);
    this.sel.touch();
    if (this.renderer && this.proportionalActive) this.renderer.editPreviewLines = null;
    ctx.setStatus('');
  }
}

/**
 * Sculpt-lite brush stroke (P9-7). Unlike G/R/S this is NOT a keyboard modal:
 * an LMB press on the mesh starts it, dragging paints, and the release confirms
 * (the InputManager drives it through the `sculptStroke` flag, mirroring the
 * gizmo-drag path). ONE MeshEditCommand per stroke — the snapshot pattern used
 * by the modal topology tools.
 *
 * Inflate: each applied dab pushes verts within the brush radius along their own
 * vertex normal by strength × falloff (Ctrl at press → deflate). Dabs are spaced
 * along the drag so one gesture accumulates smoothly.
 *
 * Grab: the verts within the radius are captured at press with their falloffs,
 * then translated by the pointer's world delta on the view plane through the hit
 * point (the G-operator's screen-plane mapping) × each vert's falloff.
 */
class SculptStrokeOperator implements Operator {
  readonly name: string;

  private mesh!: EditableMesh;
  private sel!: EditModeState;
  private matrix!: Mat4;
  private invMatrix!: Mat4;
  private snapshot!: EditableMesh;

  // Grab state (captured at press).
  private grabWeights = new Map<number, number>();
  private grabStart = new Map<number, Vec3>();
  private grabStartHit = Vec3.ZERO; // world-space surface hit at stroke start
  // Inflate state.
  private lastDab: Vec3 | null = null; // world-space hit of the last applied dab

  constructor(
    private readonly renderer: Renderer,
    private readonly tool: 'inflate' | 'grab',
    private readonly invert: boolean,
  ) {
    this.name = tool === 'inflate' ? 'Inflate' : 'Grab';
  }

  start(ctx: OperatorContext, pointer: PointerState): boolean {
    const sel = ctx.scene.editMode;
    const obj = ctx.scene.editObject;
    if (!sel || !obj || obj.mesh.verts.size === 0) return false;
    this.sel = sel;
    this.mesh = obj.mesh;
    this.matrix = ctx.scene.worldMatrix(obj);
    this.invMatrix = this.matrix.invert();

    const hit = this.raycast(ctx, pointer);
    if (!hit) return false; // pressed off the surface — no stroke

    this.snapshot = this.mesh.clone();
    if (this.tool === 'grab') {
      this.grabWeights = brushWeights(this.mesh, hit.local, sculptState.radius);
      for (const id of this.grabWeights.keys()) this.grabStart.set(id, this.mesh.verts.get(id)!.co);
      this.grabStartHit = hit.world;
    } else {
      this.applyInflateDab(hit.local);
      this.lastDab = hit.world;
    }
    this.sel.touch();
    this.drawCircle(ctx, hit.local);
    return true;
  }

  /** Pointer ray → nearest surface hit, in both local and world space. */
  private raycast(ctx: OperatorContext, pointer: PointerState): { local: Vec3; world: Vec3 } | null {
    const { width, height } = ctx.viewportSize();
    const ray = ctx.camera.pointerRay(pointer.x, pointer.y, width, height);
    const oLocal = this.invMatrix.transformPoint(ray.origin);
    const dLocal = this.invMatrix.transformDir(ray.dir).normalize();
    const hit = raycastMeshLocal(this.mesh, oLocal, dLocal);
    if (!hit) return null;
    return { local: hit.point, world: this.matrix.transformPoint(hit.point) };
  }

  private applyInflateDab(centerLocal: Vec3): void {
    const weights = brushWeights(this.mesh, centerLocal, sculptState.radius);
    const deltas = inflateDeltas(this.mesh, weights, sculptState.strength, this.invert);
    for (const [id, d] of deltas) this.mesh.setVertCo(id, this.mesh.verts.get(id)!.co.add(d));
  }

  onPointerMove(ctx: OperatorContext, pointer: PointerState): void {
    if (this.tool === 'grab') {
      const { width, height } = ctx.viewportSize();
      const ray = ctx.camera.pointerRay(pointer.x, pointer.y, width, height);
      const hitWorld = rayPlane(ray, this.grabStartHit, ctx.camera.forward);
      if (!hitWorld) return;
      const deltaLocal = this.invMatrix.transformDir(hitWorld.sub(this.grabStartHit));
      const moved = grabPositions(this.grabStart, this.grabWeights, deltaLocal);
      for (const [id, co] of moved) this.mesh.setVertCo(id, co);
      this.sel.touch();
      this.drawCircle(ctx, this.invMatrix.transformPoint(hitWorld));
      return;
    }
    const hit = this.raycast(ctx, pointer);
    if (!hit) return;
    // Space dabs along the drag so the stroke does not over-apply at one spot.
    const spacing = sculptState.radius * 0.3;
    if (!this.lastDab || hit.world.distanceTo(this.lastDab) >= spacing) {
      this.applyInflateDab(hit.local);
      this.lastDab = hit.world;
      this.sel.touch();
    }
    this.drawCircle(ctx, hit.local);
  }

  private drawCircle(ctx: OperatorContext, centerLocal: Vec3): void {
    const fLocal = this.invMatrix.transformDir(ctx.camera.forward);
    this.renderer.editPreviewLines = buildBrushCircle(centerLocal, sculptState.radius, fLocal);
  }

  onKey(): boolean {
    return false;
  }

  confirm(ctx: OperatorContext): void {
    ctx.undo.push(MeshEditCommand.fromSnapshots(this.name, this.mesh, this.snapshot, this.mesh.clone()));
    this.sel.prune(this.mesh);
    this.sel.touch();
    this.renderer.editPreviewLines = null; // hover redraws the cursor on next move
    ctx.setStatus('');
  }

  cancel(ctx: OperatorContext): void {
    this.mesh.copyFrom(this.snapshot);
    this.sel.prune(this.mesh);
    this.sel.touch();
    this.renderer.editPreviewLines = null;
    ctx.setStatus('');
  }
}

/**
 * Routes raw canvas/window events. Priority order:
 *   1. Active modal operator (owns everything until confirm/cancel)
 *   2. Camera navigation (MMB orbit, Shift+MMB pan, wheel zoom)
 *   3. Global keymap (G, Ctrl+Z, ...) and click-select
 */
export class InputManager {
  private activeOp: Operator | null = null;
  private pointer: PointerState = { x: 0, y: 0 };
  private orbiting = false;
  private panning = false;
  /** True while an LMB drag on a gizmo handle owns the active operator. Unlike
   *  keyboard-G (click confirms), a gizmo drag confirms on pointer *release*. */
  private gizmoDrag = false;
  /** Non-null while a box-select operator is active; its LMB drag defines the
   *  rect, so pointerdown anchors (not confirms) and pointerup confirms. */
  private boxSelectOp: BoxSelectOperator | null = null;
  /** Non-null while the knife operator is active; its LMB clicks add polyline
   *  points (rather than confirming), and a double-click / Enter confirms. */
  private knifeOp: KnifeOperator | null = null;
  /** Timestamp (performance.now) of the last knife point placement, for the
   *  double-click-to-confirm gesture. */
  private lastKnifeClick = 0;
  /** True while an LMB sculpt brush stroke owns the active operator; like the
   *  gizmo drag it confirms on pointer *release* (see onPointerUp). */
  private sculptStroke = false;
  private addMenu: AddMenu | null = null;
  private pieMenu: PieMenu | null = null;
  private collectionMenu: CollectionMenu | null = null;
  private keyingMenu: KeyingMenu | null = null;
  private deleteMenu: DeleteMenu | null = null;
  private edgeMenu: EdgeMenu | null = null;
  private uvMenu: UvMenu | null = null;

  /** Lock-Camera-to-View session (P10-2). While in camera view with the viewed
   *  camera's lockToView on, MMB/wheel drive this rig instead of the main
   *  OrbitCamera, and each event writes the rig pose back onto the camera. The
   *  whole session collapses to ONE TransformCommand pushed on finalize. */
  private camRig: OrbitCamera | null = null;
  private camRigObj: SceneObject | null = null;
  private camRigBefore: Transform | null = null;

  // --- Continuous grab (UR4-1) ------------------------------------------------
  /** Virtual, unbounded pointer accumulated from raw movement deltas while a
   *  continuous-grab operator (G/R/S, edge slide, …) is active. */
  private readonly modalPointer = new ModalPointer();
  /** True while the active operator is driven by the virtual pointer (it opted
   *  into continuousGrab AND was started from the keyboard, not a mouse drag). */
  private continuousActive = false;
  /** True while the browser actually has the pointer locked to the canvas. In
   *  headless/e2e (no lock) this stays false and the accumulator is fed from
   *  real-event position deltas instead of movementX/Y. */
  private pointerLocked = false;
  /** Last real-event canvas-local position, for the fallback delta (no lock). */
  private lastFallbackPos: { x: number; y: number } | null = null;
  /** Software crosshair shown while pointer-locked (the OS cursor is hidden). */
  private modalCursorEl: HTMLDivElement | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly ctx: OperatorContext,
    private readonly renderer: Renderer,
    /** File shortcuts (Ctrl+S / Ctrl+O). DOM plumbing lives in main.ts. */
    private readonly fileActions: { save(): void; open(): void },
    /** Shortcut-overlay controller (F1). Structural type keeps InputManager
     *  decoupled from the HelpOverlay class. */
    private readonly help: { isOpen(): boolean; toggle(): void; close(): void },
    /** Viewport N-panel (N key). Structural type keeps this decoupled from NPanel. */
    private readonly nPanel: { toggle(): void },
  ) {
    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    // Forward key RELEASES to the active op only (narrow hook: MOVE operators
    // need Ctrl-up to un-invert grid snapping). No global keyup behaviour.
    window.addEventListener('keyup', (e) => this.onKeyUp(e));

    // Continuous grab (UR4-1): a WINDOW-level pointermove drives continuous-grab
    // operators via the virtual pointer, so movement keeps flowing even when the
    // cursor leaves the canvas (under pointer lock) or is dispatched beyond the
    // canvas rect (headless fallback). The canvas handler short-circuits for
    // continuous ops (see onPointerMove) so exactly one path feeds the operator.
    window.addEventListener('pointermove', (e) => this.onGlobalPointerMove(e));

    // Pointer Lock lifecycle. If lock is LOST while a continuous op is still
    // active and we did not end it ourselves, the browser swallowed an Escape
    // keydown to exit lock — treat that as cancel (keeps Esc = cancel).
    document.addEventListener('pointerlockchange', () => this.onPointerLockChange());
    // A lock request that fails (headless, no user gesture) simply drops us into
    // the real-event-delta fallback — nothing to do here but stay unlocked.
    document.addEventListener('pointerlockerror', () => { this.pointerLocked = false; });
  }

  /** Pointer Lock state changed. Track it, and cancel a still-running continuous
   *  op if the lock was lost out from under us (Escape under lock). */
  private onPointerLockChange(): void {
    const locked = document.pointerLockElement === this.canvas;
    this.pointerLocked = locked;
    if (locked) {
      this.showModalCursor();
    } else {
      this.hideModalCursor();
      // continuousActive is cleared by endOperator BEFORE it calls
      // exitPointerLock, so a self-initiated exit never reaches here as true.
      if (this.continuousActive && this.activeOp) this.endOperator(false);
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    this.activeOp?.onKeyUp?.(this.ctx, e.key);
  }

  private toLocal(e: PointerEvent): PointerState {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  /** Mirror the active operator's axis lock onto the renderer, so the locked
   *  axis keeps its gizmo arrow while the rest of the gizmo is hidden. */
  private syncAxisIndicator(): void {
    this.renderer.axisIndicator = this.activeOp?.axisIndicator?.() ?? null;
    this.renderer.guideSegments = this.activeOp?.guideSegments?.() ?? null;
  }

  /**
   * Start a modal operator. `continuous` (default true) allows the continuous-
   * grab flow (UR4-1) to engage when the op opts in via `continuousGrab`; the
   * mouse-drag starters (gizmo handle, box select, sculpt) pass false so they
   * keep the real, bounded cursor they were dragging with.
   */
  startOperator(op: Operator, continuous = true): void {
    if (this.activeOp) return;
    if (op.start(this.ctx, this.pointer)) {
      this.activeOp = op;
      this.renderer.gizmoVisible = false; // hide the gizmo while a tool is modal
      this.syncAxisIndicator(); // gizmo-handle drags start pre-locked
      if (continuous && op.continuousGrab) this.beginContinuousGrab();
    }
  }

  /**
   * Engage continuous-grab pointer handling for the just-started operator: seed
   * the virtual pointer at the current cursor, arm the fallback delta reference,
   * and request Pointer Lock (best-effort — a rejection just leaves us in the
   * real-event-delta fallback, which is all headless e2e ever gets).
   */
  private beginContinuousGrab(): void {
    this.continuousActive = true;
    this.modalPointer.begin(this.pointer.x, this.pointer.y);
    this.lastFallbackPos = { x: this.pointer.x, y: this.pointer.y };
    const req = (this.canvas as HTMLCanvasElement & {
      requestPointerLock?: (opts?: unknown) => Promise<void> | void;
    }).requestPointerLock;
    if (typeof req === 'function') {
      try {
        const r = req.call(this.canvas);
        // Newer browsers return a promise that rejects instead of throwing.
        if (r && typeof (r as Promise<void>).catch === 'function') {
          (r as Promise<void>).catch(() => { /* fallback path */ });
        }
      } catch { /* unsupported / no gesture — fallback path */ }
    }
  }

  /**
   * Continuous-grab movement (UR4-1). Feeds the active operator the VIRTUAL
   * pointer accumulated from raw deltas: under pointer lock from movementX/Y,
   * otherwise from the change in real canvas-local position (so precision + the
   * unbounded accumulator work headlessly even without lock). Shift = precision.
   */
  private onGlobalPointerMove(e: PointerEvent): void {
    if (!this.activeOp || !this.continuousActive) return;
    let dx: number;
    let dy: number;
    if (this.pointerLocked) {
      dx = e.movementX;
      dy = e.movementY;
    } else {
      const p = this.toLocal(e);
      if (this.lastFallbackPos) {
        dx = p.x - this.lastFallbackPos.x;
        dy = p.y - this.lastFallbackPos.y;
      } else {
        dx = 0;
        dy = 0;
      }
      this.lastFallbackPos = p;
      // Keep the real cursor tracked (menus / the GG→Edge-Slide handoff read
      // this.pointer); the operator itself is fed the virtual pointer below.
      this.pointer = p;
    }
    const virt = this.modalPointer.move(dx, dy, e.shiftKey);
    this.activeOp.onPointerMove(this.ctx, virt);
    if (this.pointerLocked) this.positionModalCursor(virt);
  }

  /** Tear down continuous-grab state and exit Pointer Lock (idempotent). Called
   *  from endOperator BEFORE confirm/cancel so the resulting pointerlockchange
   *  sees continuousActive already false and does not re-cancel. */
  private endContinuousGrab(): void {
    if (!this.continuousActive) return;
    this.continuousActive = false;
    this.lastFallbackPos = null;
    this.hideModalCursor();
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  // --- Software crosshair (shown only while the OS cursor is locked/hidden) ----
  private ensureModalCursor(): HTMLDivElement {
    if (!this.modalCursorEl) {
      const el = document.createElement('div');
      el.className = 'modal-cursor';
      // Self-contained styling so no CSS file dependency: a small crosshair.
      el.style.cssText =
        'position:absolute;width:15px;height:15px;margin:-8px 0 0 -8px;pointer-events:none;' +
        'z-index:40;display:none;background:' +
        "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='15' height='15'>" +
        "<line x1='7.5' y1='0' x2='7.5' y2='15' stroke='white' stroke-width='1'/>" +
        "<line x1='0' y1='7.5' x2='15' y2='7.5' stroke='white' stroke-width='1'/></svg>\") center/contain no-repeat;" +
        'mix-blend-mode:difference;';
      (this.canvas.parentElement as HTMLElement).appendChild(el);
      this.modalCursorEl = el;
    }
    return this.modalCursorEl;
  }

  private showModalCursor(): void {
    if (!this.continuousActive) return;
    this.ensureModalCursor().style.display = 'block';
    this.positionModalCursor(this.modalPointer.pos);
  }

  private hideModalCursor(): void {
    if (this.modalCursorEl) this.modalCursorEl.style.display = 'none';
  }

  /** Place the crosshair at the virtual position WRAPPED (modulo) into the canvas
   *  rect — Blender wraps the cursor back to the far edge when it runs off. */
  private positionModalCursor(virt: { x: number; y: number }): void {
    if (!this.modalCursorEl) return;
    const { width, height } = this.ctx.viewportSize();
    if (width <= 0 || height <= 0) return;
    const wrap = (v: number, m: number) => ((v % m) + m) % m;
    this.modalCursorEl.style.left = `${wrap(virt.x, width)}px`;
    this.modalCursorEl.style.top = `${wrap(virt.y, height)}px`;
  }

  /**
   * The name of the currently-active modal operator (its `Operator.name`), or
   * null when nothing is modal. Read-only accessor so UI (the tool palette,
   * UR3-1) can poll which tool is running to paint an "active" highlight.
   */
  get activeOperatorName(): string | null {
    return this.activeOp?.name ?? null;
  }

  // --- Public tool starters ----------------------------------------------------
  // The SAME code paths the keyboard shortcuts run, exposed so the viewport tool
  // palette (UR3-1) can trigger a tool exactly like pressing its key. The
  // keyboard handlers below delegate here rather than duplicating any setup.

  /** Object-mode Shift+D: duplicate the selection, then ride a Move. */
  duplicateSelected(): void {
    const scene = this.ctx.scene;
    const selected = scene.selectedObjects;
    if (selected.length === 0) return;
    const dups = selected.map((obj) => scene.duplicate(obj, nextDupName(scene, obj.name)));
    scene.selection.clear();
    for (const d of dups) scene.selection.add(d.id);
    scene.activeId = dups.at(-1)?.id ?? null;
    this.ctx.undo.push(new AddObjectsCommand('Duplicate', scene, dups));
    this.ctx.setStatus(`Duplicated ${dups.length} object(s)`);
    this.startOperator(new TranslateOperator());
  }

  /** Edit-mode G: modal move of the selected element verts. */
  startEditMove(): void {
    this.startOperator(new EditTranslateOperator(this.renderer));
  }

  /** Edit-mode R: modal rotate of the selected element verts. */
  startEditRotate(): void {
    this.startOperator(new EditRotateOperator(this.renderer));
  }

  /** Edit-mode S: modal scale of the selected element verts. */
  startEditScale(): void {
    this.startOperator(new EditScaleOperator(this.renderer));
  }

  /** Edit-mode E: extrude (face mode only, mirrors the keyboard guard). */
  startExtrude(): void {
    const edit = this.ctx.scene.editMode;
    if (!edit) return;
    if (edit.elementMode !== 'face') {
      this.ctx.setStatus('Extrude: face mode only (v1)');
      return;
    }
    this.startOperator(new ExtrudeOperator());
  }

  /** Edit-mode I: inset (face mode only, mirrors the keyboard guard). */
  startInset(): void {
    const edit = this.ctx.scene.editMode;
    if (!edit) return;
    if (edit.elementMode !== 'face') {
      this.ctx.setStatus('Inset: face mode only');
      return;
    }
    this.startOperator(new InsetOperator());
  }

  /** Edit-mode Ctrl+B: bevel the selection. */
  startBevel(): void {
    this.startOperator(new BevelOperator());
  }

  /** Edit-mode Ctrl+R: loop cut. */
  startLoopCut(): void {
    this.startOperator(new LoopCutOperator(this.renderer));
  }

  /** Edit-mode K: knife (with the same double-click-tracking setup the key does). */
  startKnife(): void {
    const op = new KnifeOperator(this.canvas.parentElement as HTMLElement);
    this.startOperator(op);
    if (this.activeOp === op) {
      this.knifeOp = op;
      this.lastKnifeClick = 0;
    }
  }

  /** Edit-mode GG / Edge Slide. */
  startEdgeSlide(): void {
    this.startOperator(new EdgeSlideOperator());
  }

  /** Edit-mode Normal Move (third op in the G cycle). */
  startNormalMove(): void {
    this.startOperator(new NormalMoveOperator());
  }

  /**
   * If the active op set its `cycleRequested` sentinel (a second G), cancel it
   * (restore, push nothing) and start the NEXT op in the edit-mode G cycle
   * Move → Edge Slide → Normal Move → Move, with the same selection. The Move
   * side is guarded to the edit-mode EditTranslateOperator (its
   * DuplicateFacesOperator subclass swallows G, so never sets the sentinel);
   * object-mode TranslateOperator has no sentinel and is untouched.
   */
  private maybeCycleOperator(): void {
    const op = this.activeOp;
    let next: (() => void) | null = null;
    if (op instanceof EditTranslateOperator && op.cycleRequested) next = () => this.startEdgeSlide();
    else if (op instanceof EdgeSlideOperator && op.cycleRequested) next = () => this.startNormalMove();
    else if (op instanceof NormalMoveOperator && op.cycleRequested) next = () => this.startEditMove();
    if (!next) return;
    op!.cancel(this.ctx);
    this.activeOp = null;
    next();
  }

  private endOperator(confirm: boolean): void {
    if (!this.activeOp) return;
    // Tear down continuous-grab (and exit Pointer Lock) BEFORE confirm/cancel so
    // the exitPointerLock-triggered pointerlockchange can't re-enter and cancel.
    this.endContinuousGrab();
    if (confirm) this.activeOp.confirm(this.ctx);
    else this.activeOp.cancel(this.ctx);
    this.activeOp = null;
    this.boxSelectOp = null;
    this.knifeOp = null;
    this.renderer.gizmoVisible = true;
    this.renderer.axisIndicator = null;
    this.renderer.guideSegments = null;
  }

  private onPointerDown(e: PointerEvent): void {
    this.pointer = this.toLocal(e);

    if (this.activeOp) {
      // Knife: LMB adds a polyline point; a rapid second click on the same spot
      // (double-click) with >=2 points confirms the cut (Enter also confirms).
      if (this.knifeOp && e.button === 0) {
        const now = performance.now();
        const lp = this.knifeOp.lastPoint;
        const near = lp !== null && Math.hypot(this.pointer.x - lp.x, this.pointer.y - lp.y) < 6;
        if (this.knifeOp.pointCount >= 2 && near && now - this.lastKnifeClick < 350) {
          this.endOperator(true);
        } else {
          this.knifeOp.addPoint(this.pointer);
          this.lastKnifeClick = now;
        }
        e.preventDefault();
        return;
      }
      // Box select's LMB press anchors the rect (a drag, not a click-confirm).
      if (this.boxSelectOp && e.button === 0 && !this.boxSelectOp.anchored) {
        this.boxSelectOp.anchor(this.pointer);
        this.canvas.setPointerCapture(e.pointerId);
      } else if (e.button === 0) {
        this.endOperator(true);
      } else if (e.button === 2) {
        if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
        this.endOperator(false);
      }
      e.preventDefault();
      return;
    }

    // Shift+RightClick: place the 3D cursor (P12) — on the surface under the
    // pointer when there is one, else on the view-facing plane through the
    // cursor's current position (Blender's fallback).
    if (e.button === 2 && e.shiftKey) {
      e.preventDefault();
      this.placeCursor3d();
      return;
    }

    if (e.button === 1) {
      // MMB: orbit, Shift+MMB: pan.
      // Locked camera view: navigation MOVES the camera (rig) instead of exiting.
      if (this.ensureCamRig()) {
        if (e.shiftKey) this.panning = true;
        else this.orbiting = true;
        this.canvas.setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
      }
      // Unlocked (or user camera): navigating exits camera-view first. Commit any
      // pending rig session (e.g. lock was just turned off) before leaving.
      this.finalizeCamRig();
      this.renderer.cameraViewId = null;
      if (e.shiftKey) this.panning = true;
      else this.orbiting = true;
      this.canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }

    if (e.button === 0) {
      // Edit mode: click-select the vert/edge/face under the cursor for the
      // current element mode. Alt = loop select; Shift toggles/extends; a miss
      // (no Shift) clears all.
      if (this.ctx.scene.editMode) {
        // Sculpt brush active: LMB (no Alt) paints instead of selecting. The
        // stroke owns the pointer and confirms on release (sculptStroke).
        if (sculptState.tool !== 'none' && !e.altKey) {
          this.canvas.setPointerCapture(e.pointerId);
          this.startOperator(new SculptStrokeOperator(this.renderer, sculptState.tool, e.ctrlKey), false);
          if (this.activeOp) this.sculptStroke = true;
          else if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
          return;
        }
        if (e.altKey) this.loopSelectAt(e.shiftKey);
        else this.pickElementAt(e.shiftKey);
        return;
      }
      const hit = this.renderer.pick(this.ctx.scene, this.ctx.camera, this.pointer.x, this.pointer.y);
      if (hit === null) {
        if (!e.shiftKey) this.ctx.scene.deselectAll();
      } else if (hit.kind === 'gizmo') {
        // Grab a handle: keep the selection, start an axis-locked Move that
        // confirms on release (see gizmoDrag). Capture the pointer so we still
        // get the move/up events if the cursor leaves the canvas.
        this.canvas.setPointerCapture(e.pointerId);
        this.startOperator(new TranslateOperator(hit.axis), false);
        if (this.activeOp) this.gizmoDrag = true;
        else if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
      } else if (e.shiftKey) {
        this.ctx.scene.toggleSelect(hit.id);
      } else {
        this.ctx.scene.selectOnly(hit.id);
      }
    }
  }

  /** Shift+RightClick (P12): move the 3D cursor. Surface-snaps via a CPU
   *  raycast against the picked object's evaluated mesh in world space. */
  private placeCursor3d(): void {
    const scene = this.ctx.scene;
    const { width, height } = this.ctx.viewportSize();
    const ray = this.ctx.camera.pointerRay(this.pointer.x, this.pointer.y, width, height);
    let placed = null as Vec3 | null;
    const hit = this.renderer.pick(scene, this.ctx.camera, this.pointer.x, this.pointer.y);
    if (hit && hit.kind === 'object') {
      const obj = scene.get(hit.id);
      if (obj && obj.kind === 'mesh') {
        const m = scene.worldMatrix(obj);
        const inv = m.invert();
        const local = raycastMeshLocal(
          obj.evaluatedMesh(scene.modifierContext(obj)),
          inv.transformPoint(ray.origin),
          inv.transformDir(ray.dir).normalize(),
        );
        if (local) placed = m.transformPoint(local.point);
      }
    }
    if (!placed) placed = rayPlane(ray, scene.cursor, this.ctx.camera.forward);
    if (!placed) return;
    scene.cursor = placed;
    this.ctx.setStatus(`Cursor  (${placed.x.toFixed(2)}, ${placed.y.toFixed(2)}, ${placed.z.toFixed(2)})`);
  }

  private onPointerMove(e: PointerEvent): void {
    // Continuous-grab operators are driven exclusively by the window-level
    // handler (onGlobalPointerMove) reading the virtual pointer, so skip here to
    // avoid double-feeding. This canvas listener fires first (target phase), the
    // window listener after (bubble) — see the constructor.
    if (this.activeOp && this.continuousActive) return;

    const prev = this.pointer;
    this.pointer = this.toLocal(e);

    if (this.activeOp) {
      this.activeOp.onPointerMove(this.ctx, this.pointer);
      return;
    }
    const dx = this.pointer.x - prev.x;
    const dy = this.pointer.y - prev.y;
    // Locked camera view: MMB drag flies the camera via the rig.
    if ((this.orbiting || this.panning) && this.camRig) {
      if (this.orbiting) this.camRig.orbit(dx, dy);
      else this.camRig.pan(dx, dy, this.ctx.viewportSize().height);
      this.writeCamRig();
      return;
    }
    if (this.orbiting) this.ctx.camera.orbit(dx, dy);
    else if (this.panning) this.ctx.camera.pan(dx, dy, this.ctx.viewportSize().height);
    else if (this.ctx.scene.editMode && sculptState.tool !== 'none') this.updateBrushCursor();
  }

  /**
   * Draw the sculpt brush cursor (a circle on the surface under the pointer) via
   * the shared editPreviewLines hook, or clear it on a miss. Called on hover
   * while a sculpt brush is active and no stroke is running.
   */
  private updateBrushCursor(): void {
    const obj = this.ctx.scene.editObject;
    if (!obj || obj.mesh.verts.size === 0) { this.renderer.editPreviewLines = null; return; }
    const inv = this.ctx.scene.worldMatrix(obj).invert();
    const { width, height } = this.ctx.viewportSize();
    const ray = this.ctx.camera.pointerRay(this.pointer.x, this.pointer.y, width, height);
    const oLocal = inv.transformPoint(ray.origin);
    const dLocal = inv.transformDir(ray.dir).normalize();
    const hit = raycastMeshLocal(obj.mesh, oLocal, dLocal);
    if (!hit) { this.renderer.editPreviewLines = null; return; }
    const fLocal = inv.transformDir(this.ctx.camera.forward);
    this.renderer.editPreviewLines = buildBrushCircle(hit.point, sculptState.radius, fLocal);
  }

  /** Toggle a sculpt brush on/off (same key again → off); reset draws the cursor. */
  private setSculptTool(tool: SculptTool): void {
    if (sculptState.tool === tool) {
      sculptState.tool = 'none';
      this.renderer.editPreviewLines = null;
      this.ctx.setStatus('Sculpt: off');
      return;
    }
    sculptState.tool = tool;
    this.updateBrushCursor();
    const hint = tool === 'inflate' ? 'Ctrl: deflate' : 'drag to pull';
    this.ctx.setStatus(`Sculpt: ${tool} — LMB drag to brush, [ / ] radius, ${hint}`);
  }

  /** Turn any active sculpt brush off and clear its cursor (mode exit). */
  private clearSculptTool(): void {
    if (sculptState.tool !== 'none') {
      sculptState.tool = 'none';
      this.renderer.editPreviewLines = null;
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (e.button === 1) {
      this.orbiting = false;
      this.panning = false;
      if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    }
    if (e.button === 0) {
      // Releasing a gizmo drag confirms the move. endOperator is a no-op if the
      // op was already cancelled (Esc/RMB) mid-drag, so this is safe either way.
      if (this.gizmoDrag) {
        this.gizmoDrag = false;
        this.endOperator(true);
      } else if (this.sculptStroke) {
        // Releasing a sculpt stroke confirms it (one undo entry per stroke).
        this.sculptStroke = false;
        this.endOperator(true);
      } else if (this.boxSelectOp && this.boxSelectOp.anchored) {
        // Releasing the box-select drag applies the selection (Shift → remove).
        this.boxSelectOp.setSubtract(e.shiftKey);
        this.endOperator(true);
      }
      if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    // While a proportional-editing G/R/S modal is running, the wheel adjusts the
    // falloff radius instead of zooming the camera (narrow, guarded hook — any
    // other state falls through to the normal camera zoom).
    if (this.activeOp instanceof EditTransformBase && this.activeOp.proportionalActive) {
      this.activeOp.adjustRadius(this.ctx, e.deltaY);
      return;
    }
    // Locked camera view: the wheel dollies the camera via the rig.
    if (this.ensureCamRig()) {
      this.camRig!.zoom(e.deltaY);
      this.writeCamRig();
      return;
    }
    this.finalizeCamRig();
    this.renderer.cameraViewId = null; // zooming exits camera-view
    this.ctx.camera.zoom(e.deltaY);
  }

  private onKeyDown(e: KeyboardEvent): void {
    // Help overlay owns the keyboard while open: swallow EVERY key so nothing
    // leaks to the viewport (a modal G must not start a move). F1 or Escape
    // closes it. This sits before the activeOp branch so Escape closes the
    // overlay before it would cancel any modal tool.
    if (this.help.isOpen()) {
      if (e.key === 'F1' || e.key === 'Escape') this.help.close()
      e.preventDefault();
      return;
    }
    // F1 opens the overlay in both object and edit mode; preventDefault stops
    // the browser's own help.
    if (e.key === 'F1') {
      e.preventDefault();
      this.help.toggle();
      return;
    }

    if (this.activeOp) {
      if (e.key === 'Escape') this.endOperator(false);
      else if (e.key === 'Enter') this.endOperator(true);
      else if (this.activeOp.onKey(this.ctx, e.key)) {
        e.preventDefault();
        this.syncAxisIndicator(); // X/Y/Z may have toggled an axis lock
        // G cycle (UR4-2): a second G during an edit-mode Move/Edge Slide/Normal
        // Move cancels the current op (restore, push nothing) and starts the next
        // in Move → Edge Slide → Normal Move → Move, handing over the SAME
        // selection. Object-mode Move (TranslateOperator) has no such sentinel.
        this.maybeCycleOperator();
      }
      return;
    }

    // The Delete key aliases X everywhere X acts (users kept pressing Delete and
    // concluding delete didn't exist): object-mode object delete AND the
    // edit-mode Delete menu. Normalise it to 'x' before any key dispatch.
    const key = e.key === 'Delete' ? 'x' : e.key.toLowerCase();
    if (e.ctrlKey && key === 'z') {
      e.preventDefault();
      const name = e.shiftKey ? this.ctx.undo.redo() : this.ctx.undo.undo();
      this.ctx.setStatus(name ? `${e.shiftKey ? 'Redo' : 'Undo'}: ${name}` : 'Nothing to undo');
      return;
    }

    // Ctrl+S save / Ctrl+O open — work in both object and edit mode (handled
    // above the edit-mode branch below). preventDefault stops the browser's own
    // save/open dialogs. The load path (main.ts) exits edit mode before applying.
    if (e.ctrlKey && key === 's' && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      this.fileActions.save();
      return;
    }
    if (e.ctrlKey && key === 'o' && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      this.fileActions.open();
      return;
    }

    // Shift+Tab: toggle grid snapping (both modes). MUST come before the plain
    // Tab edit-mode toggle so the modifier form wins. preventDefault stops the
    // browser's reverse-focus traversal.
    if (e.key === 'Tab' && e.shiftKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      snapState.enabled = !snapState.enabled;
      this.ctx.setStatus(`Snapping: ${snapState.enabled ? 'on' : 'off'}`);
      return;
    }

    // Tab: toggle Edit Mode on the active object. preventDefault keeps the
    // browser from moving focus out of the canvas.
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      const scene = this.ctx.scene;
      if (scene.editMode) {
        this.clearSculptTool(); // leaving edit mode ends any sculpt brush
        scene.exitEditMode();
        this.ctx.setStatus('');
      } else if (scene.enterEditMode()) {
        this.ctx.setStatus('Edit Mode — 1/2/3: vert/edge/face select, Tab: back to Object Mode');
      }
      return;
    }

    // Alt+Z: toggle X-ray / select-through (both modes). Guarded so it never
    // collides with plain-Z shading (below, !altKey) or Ctrl+Z undo (above).
    if (key === 'z' && e.altKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      xrayState.enabled = !xrayState.enabled;
      this.ctx.setStatus(`X-ray: ${xrayState.enabled ? 'on' : 'off'}`);
      return;
    }

    // Z: cycle viewport shading (matcap → wireframe → studio). Works in both
    // object and edit mode; placed before the edit-mode branch so it applies to
    // both. Plain Z only — Ctrl+Z (undo) is handled above and already returned.
    if (key === 'z' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      const mode = this.renderer.cycleShadingMode();
      this.ctx.setStatus(`Shading: ${mode}`);
      return;
    }

    // Shift+C (P12): return the 3D cursor to the world origin and frame
    // everything (Blender's "Center Cursor and Frame All").
    if (key === 'c' && e.shiftKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const scene = this.ctx.scene;
      scene.cursor = Vec3.ZERO;
      // Frame ALL objects: select everything for the framing call, then restore.
      const hadSelection = [...scene.selection];
      scene.selection.clear();
      for (const o of scene.objects) if (scene.effectiveVisible(o)) scene.selection.add(o.id);
      frameSelection(this.ctx);
      scene.selection.clear();
      for (const id of hadSelection) scene.selection.add(id);
      this.ctx.setStatus('Cursor to origin');
      return;
    }

    // Shift+S (P12): open the Snap pie at the pointer. Works in both object and
    // edit mode (placed before the edit-mode branch, like Shift+C). Re-press
    // closes it. The Selection wedges are inert in edit mode and when nothing is
    // selected (they only move whole objects). Cursor moves are not undoable.
    if (key === 's' && e.shiftKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (this.pieMenu) { this.pieMenu.close(); return; }
      const scene = this.ctx.scene;
      const undo = this.ctx.undo;
      const status = (t: string) => this.ctx.setStatus(t);
      const noSel = scene.editMode !== null || scene.selectedObjects.length === 0;
      this.pieMenu = new PieMenu({
        parent: this.canvas.parentElement as HTMLElement,
        x: this.pointer.x,
        y: this.pointer.y,
        title: 'Snap',
        items: [
          { label: 'Cursor to World Origin', action: () => status(cursorToOrigin(scene)) },
          { label: 'Cursor to Selected', action: () => status(cursorToSelected(scene)) },
          { label: 'Cursor to Grid', action: () => status(cursorToGrid(scene)) },
          { label: 'Selection to Cursor', disabled: noSel, action: () => status(selectionToCursor(scene, undo)) },
          { label: 'Selection to Grid', disabled: noSel, action: () => status(selectionToGrid(scene, undo)) },
        ],
        onClose: () => { this.pieMenu = null; },
      });
      return;
    }

    // Period: frame the selection. Works in both object and edit mode; placed
    // before the edit-mode branch so it applies to both.
    if (key === '.' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      frameSelection(this.ctx);
      this.ctx.setStatus('Framed selection');
      return;
    }

    // N: toggle the viewport N-panel (Item sidebar). Works in both object and
    // edit mode; placed before the edit-mode branch so it applies to both. A
    // modal op (G/R/S/...) already consumed this key in the activeOp branch
    // above and returned, so N never toggles the panel mid-operator.
    if (key === 'n' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      e.preventDefault();
      this.nPanel.toggle();
      return;
    }

    // Ctrl+Alt+Numpad0: snap the active camera to the current view (create one
    // Blender-style if the scene has none). Placed before the plain Numpad0
    // toggle. Works in both modes.
    if (e.code === 'Numpad0' && e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey) {
      e.preventDefault();
      this.snapCameraToView();
      return;
    }

    // Numpad0: toggle looking through the scene's active camera. Works in both
    // modes (placed before the edit-mode branch); no modifiers. Uses e.code so
    // the top-row 0 is untouched. A modal op already consumed keys and returned.
    if (e.code === 'Numpad0' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      e.preventDefault();
      const scene = this.ctx.scene;
      if (this.renderer.cameraViewId !== null) {
        // Leaving camera view commits any lock-to-view fly as one undo step.
        this.finalizeCamRig();
        this.renderer.cameraViewId = null;
        this.ctx.setStatus('View: User');
      } else if (scene.activeCameraId !== null) {
        this.renderer.cameraViewId = scene.activeCameraId;
        this.ctx.setStatus('View: Camera');
      } else {
        this.ctx.setStatus('No active camera');
      }
      return;
    }

    if (this.ctx.scene.editMode) {
      this.onEditModeKey(e, key);
      return; // object-mode keys (G/R/S on objects, X, Shift-A/D) don't apply here
    }

    // Spacebar (P15-1, object mode, no modifiers): play/pause the timeline.
    // Plain Space is otherwise unbound (Ctrl+Space = area fullscreen, handled
    // in workspace.ts). Skip while a form field is focused so timeline frame
    // inputs keep working.
    if (e.code === 'Space' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      if (e.repeat) return; // held Space must not machine-gun the toggle
      const a = document.activeElement;
      if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
      e.preventDefault();
      this.ctx.scene.playing = !this.ctx.scene.playing;
      this.ctx.setStatus(this.ctx.scene.playing ? 'Playing' : 'Paused');
      return;
    }

    if (key === 'g' && !e.ctrlKey && !e.altKey) {
      this.startOperator(new TranslateOperator());
      return;
    }
    if (key === 'r' && !e.ctrlKey && !e.altKey) {
      this.startOperator(new RotateOperator());
      return;
    }
    if (key === 's' && !e.ctrlKey && !e.altKey) {
      this.startOperator(new ScaleOperator());
      return;
    }
    if (key === 'a' && e.altKey) {
      e.preventDefault();
      this.ctx.scene.deselectAll();
      return;
    }
    // Shift+A: toggle the Add menu at the pointer (inside #viewport-wrap).
    if (key === 'a' && e.shiftKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (this.addMenu) { this.addMenu.close(); return; }
      this.addMenu = new AddMenu({
        parent: this.canvas.parentElement as HTMLElement,
        x: this.pointer.x,
        y: this.pointer.y,
        scene: this.ctx.scene,
        undo: this.ctx.undo,
        setStatus: (t) => this.ctx.setStatus(t),
        onClose: () => { this.addMenu = null; },
      });
      return;
    }
    // Shift+D: duplicate the selection, then ride the pointer with a Move.
    if (key === 'd' && e.shiftKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      this.duplicateSelected();
      return;
    }
    // Ctrl+J: join every selected mesh into the active object (Blender semantics).
    // Object mode only — the edit-mode branch above already returned.
    if (key === 'j' && e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      const scene = this.ctx.scene;
      // Join pivots on the active mesh: a light/camera can't receive geometry.
      if (scene.activeObject && scene.activeObject.kind !== 'mesh') {
        this.ctx.setStatus('Join needs a mesh active object');
        return;
      }
      // Non-mesh selected objects are skipped by JoinObjectsCommand (they
      // survive, selection untouched) — count only the meshes here.
      const count = scene.selectedObjects.filter((o) => o.kind === 'mesh').length;
      if (count < 2) {
        this.ctx.setStatus('Join needs 2 or more selected mesh objects');
        return;
      }
      const cmd = JoinObjectsCommand.perform('Join', scene);
      if (!cmd) {
        this.ctx.setStatus('Join needs the active object to be selected');
        return;
      }
      this.ctx.undo.push(cmd);
      this.ctx.setStatus(`Joined ${count} objects`);
      return;
    }
    // Ctrl+P: parent every other selected object to the ACTIVE one, keeping
    // world transforms (Blender's Object > Parent > Keep Transform). Alt+P
    // clears the parent, also keeping the world transform. Object mode only.
    if (key === 'p' && e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      const scene = this.ctx.scene;
      const parent = scene.activeObject;
      const children = scene.selectedObjects.filter((o) => o.id !== parent?.id);
      if (!parent || children.length === 0) {
        this.ctx.setStatus('Ctrl+P: select children, then the parent (active) last');
        return;
      }
      const cmd = SetParentCommand.perform('Parent', scene, children, parent);
      if (!cmd) { this.ctx.setStatus('Parent: would create a cycle'); return; }
      this.ctx.undo.push(cmd);
      this.ctx.setStatus(`Parented ${children.length} object(s) to ${parent.name}`);
      return;
    }
    if (key === 'p' && e.altKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      const scene = this.ctx.scene;
      const targets = scene.selectedObjects.filter((o) => o.parentId !== null);
      if (targets.length === 0) { this.ctx.setStatus('Alt+P: no parented objects selected'); return; }
      const cmd = SetParentCommand.perform('Clear Parent', scene, targets, null);
      if (!cmd) return;
      this.ctx.undo.push(cmd);
      this.ctx.setStatus(`Cleared parent on ${targets.length} object(s)`);
      return;
    }
    // I (P15, object mode): open the keying menu (Location / Rotation / Scale /
    // LocRotScale) at the pointer. LocRotScale is the highlighted default, so a
    // second I (I,I) keys all nine channels like the old plain-I did. (Edit-mode
    // I = inset — that branch returned above.)
    if (key === 'i' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      if (this.keyingMenu) { this.keyingMenu.close(); return; }
      const scene = this.ctx.scene;
      const targets = scene.selectedObjects;
      if (targets.length === 0) { this.ctx.setStatus('I: select objects first'); return; }
      this.keyingMenu = new KeyingMenu({
        parent: this.canvas.parentElement as HTMLElement,
        x: this.pointer.x,
        y: this.pointer.y,
        scene,
        undo: this.ctx.undo,
        objects: targets,
        setStatus: (t) => this.ctx.setStatus(t),
        onClose: () => { this.keyingMenu = null; },
      });
      return;
    }
    // M: Move to Collection (object mode). Opens a popup at the pointer listing
    // collections + New Collection + Scene Root; each assigns every selected
    // object's collectionId through the undo stack. (Edit-mode M merges — the
    // edit branch returned above, so this only fires in object mode.)
    if (key === 'm' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      if (this.collectionMenu) { this.collectionMenu.close(); return; }
      const ids = [...this.ctx.scene.selection];
      if (ids.length === 0) { this.ctx.setStatus('M: select objects first'); return; }
      this.collectionMenu = new CollectionMenu({
        parent: this.canvas.parentElement as HTMLElement,
        x: this.pointer.x,
        y: this.pointer.y,
        scene: this.ctx.scene,
        undo: this.ctx.undo,
        objectIds: ids,
        setStatus: (t) => this.ctx.setStatus(t),
        onClose: () => { this.collectionMenu = null; },
      });
      return;
    }
    // X: delete the selection (no confirmation, no modifiers).
    if (key === 'x' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      const ids = [...this.ctx.scene.selection];
      if (ids.length === 0) return;
      e.preventDefault();
      this.ctx.undo.push(DeleteObjectsCommand.perform('Delete', this.ctx.scene, ids));
      this.ctx.setStatus(`Deleted ${ids.length} object(s)`);
      return;
    }
  }

  /**
   * Edit-mode click-select: pick the element under the cursor and update the
   * current mode's selection set. Plain click replaces that set with the hit;
   * Shift toggles the hit; a miss without Shift clears the whole selection.
   */
  private pickElementAt(shift: boolean): void {
    const sel = this.ctx.scene.editMode;
    if (!sel || !this.ctx.scene.editObject) return;
    const hit = this.renderer.pickElement(this.ctx.scene, this.ctx.camera, this.pointer.x, this.pointer.y);
    if (hit === null) {
      if (!shift) sel.clearSelection();
      return;
    }
    if (hit.kind === 'vert') {
      if (shift) { if (!sel.verts.delete(hit.id)) sel.verts.add(hit.id); }
      else { sel.verts.clear(); sel.verts.add(hit.id); }
    } else if (hit.kind === 'edge') {
      if (shift) { if (!sel.edges.delete(hit.key)) sel.edges.add(hit.key); }
      else { sel.edges.clear(); sel.edges.add(hit.key); }
    } else {
      if (shift) { if (!sel.faces.delete(hit.id)) sel.faces.add(hit.id); }
      else { sel.faces.clear(); sel.faces.add(hit.id); }
    }
    sel.touch();
  }

  /**
   * Alt+click loop select. Edge/vert modes walk the edge loop through the edge
   * nearest the cursor (vert mode selects that loop's verts); face mode walks a
   * quad face loop, entered through the picked face's edge nearest the cursor.
   * Plain Alt replaces the selection; Shift+Alt adds another loop.
   */
  private loopSelectAt(add: boolean): void {
    const sel = this.ctx.scene.editMode;
    const obj = this.ctx.scene.editObject;
    if (!sel || !obj) return;
    const mesh = obj.mesh;
    const { x, y } = this.pointer;

    if (sel.elementMode === 'face') {
      const hit = this.renderer.pickElement(this.ctx.scene, this.ctx.camera, x, y, 'face');
      if (!hit || hit.kind !== 'face') return;
      const entry = this.nearestFaceEdge(obj, hit.id);
      if (!entry) return;
      if (!add) sel.clearSelection();
      for (const fid of faceLoop(mesh, hit.id, entry)) sel.faces.add(fid);
    } else {
      // Vert + edge modes both ride an edge loop; pick the nearest edge as entry.
      const hit = this.renderer.pickElement(this.ctx.scene, this.ctx.camera, x, y, 'edge');
      if (!hit || hit.kind !== 'edge') return;
      if (!add) sel.clearSelection();
      if (sel.elementMode === 'edge') {
        for (const k of edgeLoop(mesh, hit.key)) sel.edges.add(k);
      } else {
        for (const v of vertLoop(mesh, hit.key)) sel.verts.add(v);
      }
    }
    sel.touch();
  }

  /** The picked face's edge whose projected midpoint is nearest the cursor. */
  private nearestFaceEdge(obj: SceneObject, faceId: number): string | null {
    const f = obj.mesh.faces.get(faceId);
    if (!f) return null;
    const { width, height } = this.ctx.viewportSize();
    const mvp = this.ctx.camera.projMatrix(width / height).mul(this.ctx.camera.viewMatrix()).mul(this.ctx.scene.worldMatrix(obj));
    let best: string | null = null;
    let bestD = Infinity;
    const vs = f.verts;
    for (let i = 0; i < vs.length; i++) {
      const a = obj.mesh.verts.get(vs[i])!.co;
      const b = obj.mesh.verts.get(vs[(i + 1) % vs.length])!.co;
      const ndc = mvp.transformPoint(a.add(b).scale(0.5));
      const sx = ((ndc.x + 1) / 2) * width;
      const sy = ((1 - ndc.y) / 2) * height;
      const d = (sx - this.pointer.x) ** 2 + (sy - this.pointer.y) ** 2;
      if (d < bestD) { bestD = d; best = EditableMesh.edgeKey(vs[i], vs[(i + 1) % vs.length]); }
    }
    return best;
  }

  /**
   * Ctrl+Alt+Numpad0 — set the active camera's transform to the current view
   * (position = eye, rotation from the view basis). If the scene has no camera,
   * create one at the view and register it (Blender creates + aligns a camera).
   * Undoable: a transform command for an existing camera, an add command for a
   * freshly created one.
   */
  private snapCameraToView(): void {
    const scene = this.ctx.scene;
    const cam = this.ctx.camera;
    const pose = cameraTransformFromView(cam.eye, cam.forward, Vec3.Z);
    let camObj = scene.activeCamera;
    if (!camObj) {
      camObj = scene.addCamera('Camera');
      camObj.transform = pose;
      scene.selectOnly(camObj.id);
      this.ctx.undo.push(new AddObjectsCommand('Camera to View', scene, [camObj]));
    } else {
      const before = camObj.transform;
      camObj.transform = pose;
      this.ctx.undo.push(new TransformCommand('Camera to View', [{ object: camObj, before, after: pose }]));
    }
    this.ctx.setStatus('Camera set to view');
  }

  // --- Lock-Camera-to-View rig session ---------------------------------------

  /** The camera object being looked through with lockToView ON, else null. */
  private lockedViewCamera(): SceneObject | null {
    const id = this.renderer.cameraViewId;
    if (id === null) return null;
    const obj = this.ctx.scene.get(id);
    if (!obj || obj.kind !== 'camera' || !obj.camera || !obj.camera.lockToView) return null;
    return obj;
  }

  /**
   * Ensure a rig session is running for the currently locked view camera,
   * seeding it lazily from the live camera pose on the first nav event (this
   * covers both "entered camera view with lock on" and "checkbox turned on while
   * in camera view" without any cross-wiring). Returns the rig's camera object,
   * or null when we are NOT in a locked camera view.
   */
  private ensureCamRig(): SceneObject | null {
    const obj = this.lockedViewCamera();
    if (!obj) return null;
    if (!this.camRig || this.camRigObj !== obj) {
      this.finalizeCamRig(); // commit any stale session before retargeting
      this.camRig = new OrbitCamera();
      // Seed the pivot depth from the live viewport distance so the locked fly
      // continues at the framing the user was just navigating at (no teleport).
      configureRigFromCamera(this.camRig, obj.transform, this.ctx.camera.distance);
      this.camRigObj = obj;
      this.camRigBefore = obj.transform;
    }
    return obj;
  }

  /** Write the rig's current pose onto the camera object (live, no undo yet). */
  private writeCamRig(): void {
    if (this.camRig && this.camRigObj) {
      this.camRigObj.transform = cameraPoseFromRig(this.camRig);
    }
  }

  /**
   * End the rig session: if the camera actually moved, push ONE TransformCommand
   * so the whole continuous fly collapses to a single undo step (Blender-ish —
   * navigation never spams the stack). Idempotent / safe to call when idle.
   */
  private finalizeCamRig(): void {
    if (this.camRig && this.camRigObj && this.camRigBefore) {
      const after = this.camRigObj.transform;
      if (poseChanged(this.camRigBefore, after)) {
        this.ctx.undo.push(new TransformCommand('Camera Nav', [
          { object: this.camRigObj, before: this.camRigBefore, after },
        ]));
      }
    }
    this.camRig = null;
    this.camRigObj = null;
    this.camRigBefore = null;
  }

  /** Edit-mode keymap. Element tools (G/R/S, E, I, X, ...) arrive with P2-3..P2-6. */
  private onEditModeKey(e: KeyboardEvent, key: string): void {
    const scene = this.ctx.scene;
    const edit = scene.editMode!;
    const mesh = scene.editObject?.mesh;
    if (!mesh) return;

    if (key === '1' || key === '2' || key === '3') {
      e.preventDefault();
      const mode = key === '1' ? 'vert' : key === '2' ? 'edge' : 'face';
      edit.setElementMode(mode, mesh);
      this.ctx.setStatus(`Select mode: ${mode}`);
      return;
    }
    // Sculpt-lite brush toggles (edit-mode tool overlay): Shift+I inflate,
    // Shift+G grab; the same key again turns the brush off. MUST precede plain-I
    // (inset) and plain-G (move), which don't guard Shift. While a brush is on,
    // LMB drag paints instead of selecting; [ / ] resize the brush.
    if (key === 'i' && e.shiftKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      this.setSculptTool('inflate');
      return;
    }
    if (key === 'g' && e.shiftKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      this.setSculptTool('grab');
      return;
    }
    if ((key === '[' || key === ']') && sculptState.tool !== 'none' && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const factor = key === ']' ? 1.15 : 1 / 1.15;
      sculptState.radius = Math.min(50, Math.max(0.02, sculptState.radius * factor));
      this.updateBrushCursor();
      this.ctx.setStatus(`Brush radius: ${sculptState.radius.toFixed(2)}`);
      return;
    }
    if (key === 'a' && e.altKey) {
      e.preventDefault();
      edit.clearSelection();
      return;
    }
    if (key === 'a' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      edit.selectAll(mesh);
      return;
    }
    // O: toggle proportional editing. When on, G/R/S also drag nearby unselected
    // verts with a smooth falloff; the wheel adjusts the radius during the modal.
    // (Ctrl+O — file open — is handled earlier, before the edit-mode branch.)
    if (key === 'o' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      proportional.enabled = !proportional.enabled;
      this.ctx.setStatus(`Proportional editing: ${proportional.enabled ? 'on' : 'off'}`);
      return;
    }
    // Ctrl+B: bevel the selected edges (edge mode). Modal width drag; the op
    // reports its own error for unsupported selections. Must precede plain-B box
    // select (which guards !e.ctrlKey) and preventDefault the browser bookmark.
    if (key === 'b' && e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      this.startBevel();
      return;
    }
    // B: box select. Starts a modal operator whose next LMB drag draws the rect;
    // inside elements are added to (Shift at release: removed from) the selection.
    if (key === 'b' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      const op = new BoxSelectOperator(this.canvas.parentElement as HTMLElement);
      this.startOperator(op, false);
      if (this.activeOp === op) this.boxSelectOp = op;
      return;
    }
    // Ctrl+I: invert the current-mode selection.
    if (key === 'i' && e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      invertSelection(edit, mesh);
      this.ctx.setStatus('Inverted selection');
      return;
    }
    // Ctrl+R: loop cut. Must precede the plain-R rotate check, and must
    // preventDefault so the browser doesn't reload the page.
    if (key === 'r' && e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      this.startLoopCut();
      return;
    }
    // K: knife. Click to lay a screen-space polyline over the mesh, Enter or
    // double-click cuts, Esc/RMB cancels. The operator owns its own SVG overlay.
    if (key === 'k' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      this.startKnife();
      return;
    }
    // G/R/S: modal move/rotate/scale of the selected elements' verts.
    if (key === 'g' && !e.ctrlKey && !e.altKey) {
      this.startEditMove();
      return;
    }
    if (key === 'r' && !e.ctrlKey && !e.altKey) {
      this.startEditRotate();
      return;
    }
    if (key === 's' && !e.ctrlKey && !e.altKey) {
      this.startEditScale();
      return;
    }
    // Shift+N: recalculate normals — make winding consistent + orient outward.
    // Operates on the selected faces (all faces when nothing is selected). Must
    // precede nothing special (plain N toggles the panel in the general branch,
    // guarded !shiftKey, so it never reaches here).
    if (key === 'n' && e.shiftKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const selFaces = [...edit.faces].filter((id) => mesh.faces.has(id));
      const faceIds = selFaces.length > 0 ? selFaces : [...mesh.faces.keys()];
      if (faceIds.length === 0) {
        this.ctx.setStatus('Recalculate Normals: no faces');
        return;
      }
      const cmd = MeshEditCommand.capture('Recalculate Normals', mesh, () => {
        recalcNormals(mesh, faceIds);
      });
      this.ctx.undo.push(cmd);
      edit.touch();
      this.ctx.setStatus('Recalculated normals');
      return;
    }
    // Shift+E: crease the selected edges (modal weight drag). Edge mode only.
    // Must precede plain-E extrude (which guards only !e.ctrlKey && !e.altKey,
    // NOT shift) and the Ctrl+E bridge.
    if (key === 'e' && e.shiftKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (edit.elementMode !== 'edge') {
        this.ctx.setStatus('Crease: edge mode only');
        return;
      }
      if ([...edit.edges].filter((k) => mesh.edges().has(k)).length === 0) {
        this.ctx.setStatus('Crease: select one or more edges');
        return;
      }
      this.startOperator(new CreaseOperator());
      return;
    }
    // Ctrl+E: open the Edge menu at the pointer (Mark Seam / Clear Seam / Bridge
    // Edge Loops) — Blender's Ctrl+E menu (P11-1). Replaces the old direct
    // Ctrl+E→bridge binding; bridge is now a menu item (see edgeMenu.ts). Placed
    // before plain-E extrude (which guards !e.ctrlKey).
    if (key === 'e' && e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      if (this.edgeMenu) { this.edgeMenu.close(); return; }
      this.edgeMenu = new EdgeMenu({
        parent: this.canvas.parentElement as HTMLElement,
        x: this.pointer.x,
        y: this.pointer.y,
        sel: edit,
        mesh,
        undo: this.ctx.undo,
        setStatus: (t) => this.ctx.setStatus(t),
        onClose: () => { this.edgeMenu = null; },
      });
      return;
    }
    // U: open the UV Mapping menu (Unwrap / Smart UV Project / Project From
    // View) at the pointer (P11-1). Each op runs on the selected faces, or all
    // faces when none are selected (documented in uvMenu.ts).
    if (key === 'u' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      e.preventDefault();
      if (this.uvMenu) { this.uvMenu.close(); return; }
      const obj = scene.editObject;
      if (!obj) return;
      this.uvMenu = new UvMenu({
        parent: this.canvas.parentElement as HTMLElement,
        x: this.pointer.x,
        y: this.pointer.y,
        scene,
        obj,
        sel: edit,
        undo: this.ctx.undo,
        camera: this.ctx.camera,
        viewportSize: () => this.ctx.viewportSize(),
        setStatus: (t) => this.ctx.setStatus(t),
        onClose: () => { this.uvMenu = null; },
      });
      return;
    }
    // E: extrude. Face mode rides the region along its average normal; vert/edge
    // mode is not supported in v1 (just tell the user).
    if (key === 'e' && !e.ctrlKey && !e.altKey) {
      this.startExtrude();
      return;
    }
    // I: inset each selected face individually. Face mode only.
    if (key === 'i' && !e.ctrlKey && !e.altKey) {
      this.startInset();
      return;
    }
    // X: open the Delete menu at the pointer (Verts/Edges/Faces/Merge). An empty
    // element selection early-returns — no menu, and never touches the object.
    if (key === 'x' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      if (this.deleteMenu) { this.deleteMenu.close(); return; }
      if (edit.selectedVertIds(mesh).size === 0) return;
      this.deleteMenu = new DeleteMenu({
        parent: this.canvas.parentElement as HTMLElement,
        x: this.pointer.x,
        y: this.pointer.y,
        sel: edit,
        mesh,
        undo: this.ctx.undo,
        setStatus: (t) => this.ctx.setStatus(t),
        onClose: () => { this.deleteMenu = null; },
      });
      return;
    }
    // F: fill a face from the selection (vert chain / edge chain). The op reports
    // its own error (too few verts, not a single chain, ...) with no mutation.
    if (key === 'f' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      let result!: { faceId: number } | { error: string };
      const cmd = MeshEditCommand.capture('Fill', mesh, () => {
        result = edit.elementMode === 'edge'
          ? fillEdges(mesh, edit.edges)
          : fillVerts(mesh, edit.verts);
      });
      if ('error' in result) {
        this.ctx.setStatus(`Fill: ${result.error}`);
        return; // nothing mutated — drop the no-op command
      }
      this.ctx.undo.push(cmd);
      edit.prune(mesh);
      edit.touch(); // keep the current selection (spec: select nothing new)
      this.ctx.setStatus('Filled face');
      return;
    }
    // Ctrl+D: subdivide the fully-selected faces (each quad → 4 quads, tri → 4
    // tris; shared edge midpoints are created once). Must precede any plain-D.
    if (key === 'd' && e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      const vids = edit.selectedVertIds(mesh);
      const faceIds = [...mesh.faces.values()]
        .filter((f) => f.verts.length > 0 && f.verts.every((v) => vids.has(v)))
        .map((f) => f.id);
      if (faceIds.length === 0) {
        this.ctx.setStatus('Subdivide: select one or more whole faces');
        return;
      }
      let res!: { newFaceIds: number[] };
      const cmd = MeshEditCommand.capture('Subdivide', mesh, () => {
        res = subdivideFaces(mesh, faceIds);
      });
      this.ctx.undo.push(cmd);
      edit.setElementMode('face', mesh);
      edit.clearSelection();
      for (const fid of res.newFaceIds) edit.faces.add(fid);
      edit.touch();
      this.ctx.setStatus(`Subdivided ${faceIds.length} face(s)`);
      return;
    }
    // Shift+D: duplicate the selected faces inside the mesh, then ride a Move
    // (the operator does the copy + reselect on start). Face mode only in v1; the
    // whole gesture is ONE undo step. Must precede any plain-D handling and win
    // over Ctrl+D (guarded !e.ctrlKey).
    if (key === 'd' && e.shiftKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (edit.elementMode !== 'face') {
        this.ctx.setStatus('Duplicate: face mode only (v1)');
        return;
      }
      const faceIds = [...edit.faces].filter((id) => mesh.faces.has(id));
      if (faceIds.length === 0) {
        this.ctx.setStatus('Duplicate: select one or more faces');
        return;
      }
      this.startOperator(new DuplicateFacesOperator(this.renderer));
      return;
    }
    // M: Merge at Center directly (Blender muscle memory).
    if (key === 'm' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      mergeAtCenter(edit, mesh, this.ctx.undo, (t) => this.ctx.setStatus(t));
      return;
    }
    // P: separate the selected faces into a new object (Blender's Separate →
    // Selection). Face mode only; an empty selection or the whole mesh is a
    // no-op with a status hint (the whole-mesh guard avoids an empty source).
    if (key === 'p' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      if (edit.elementMode !== 'face') {
        this.ctx.setStatus('Separate: face mode only');
        return;
      }
      const faceIds = [...edit.faces].filter((id) => mesh.faces.has(id));
      if (faceIds.length === 0) {
        this.ctx.setStatus('Separate: select one or more faces');
        return;
      }
      if (faceIds.length === mesh.faces.size) {
        this.ctx.setStatus("Separate: can't separate the whole mesh");
        return;
      }
      const cmd = SeparateCommand.perform('Separate', scene);
      if (!cmd) return; // guards above already covered the no-op cases
      this.ctx.undo.push(cmd);
      this.ctx.setStatus(`Separated ${faceIds.length} face(s) to a new object`);
      return;
    }
  }
}
