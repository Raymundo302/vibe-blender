import type { Operator, OperatorContext, PointerState } from '../core/operator/Operator';
import type { Renderer } from '../render/Renderer';
import type { Scene } from '../core/scene/Scene';
import { TranslateOperator } from '../tools/translate';
import { RotateOperator } from '../tools/rotate';
import { ScaleOperator } from '../tools/scale';
import { EditTranslateOperator, EditRotateOperator, EditScaleOperator, EditTransformBase, proportional } from '../tools/editTransform';
import { ExtrudeOperator } from '../tools/extrude';
import { InsetOperator } from '../tools/inset';
import { BoxSelectOperator, invertSelection } from '../tools/boxSelect';
import { LoopCutOperator } from '../tools/loopCut';
import { BevelOperator } from '../tools/bevel';
import { bridgeLoops } from '../core/mesh/ops/bridge';
import { fillVerts, fillEdges } from '../core/mesh/ops/fill';
import { subdivideFaces } from '../core/mesh/ops/subdivide';
import { frameSelection } from '../tools/frame';
import { MeshEditCommand } from '../core/undo/meshCommands';
import { AddMenu } from '../ui/addMenu';
import { DeleteMenu, mergeAtCenter } from '../ui/deleteMenu';
import { AddObjectsCommand, DeleteObjectsCommand } from '../core/undo/objectCommands';
import { JoinObjectsCommand } from '../core/undo/joinCommand';
import { SeparateCommand } from '../core/undo/separateCommand';

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
  private addMenu: AddMenu | null = null;
  private deleteMenu: DeleteMenu | null = null;

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
  }

  private toLocal(e: PointerEvent): PointerState {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  startOperator(op: Operator): void {
    if (this.activeOp) return;
    if (op.start(this.ctx, this.pointer)) {
      this.activeOp = op;
      this.renderer.gizmoVisible = false; // hide the gizmo while a tool is modal
    }
  }

  private endOperator(confirm: boolean): void {
    if (!this.activeOp) return;
    if (confirm) this.activeOp.confirm(this.ctx);
    else this.activeOp.cancel(this.ctx);
    this.activeOp = null;
    this.boxSelectOp = null;
    this.renderer.gizmoVisible = true;
  }

  private onPointerDown(e: PointerEvent): void {
    this.pointer = this.toLocal(e);

    if (this.activeOp) {
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

    if (e.button === 1) {
      // MMB: orbit, Shift+MMB: pan
      if (e.shiftKey) this.panning = true;
      else this.orbiting = true;
      this.canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }

    if (e.button === 0) {
      // Edit mode: click-select the vert/edge/face under the cursor for the
      // current element mode. Shift toggles; a miss (no Shift) clears all.
      if (this.ctx.scene.editMode) {
        this.pickElementAt(e.shiftKey);
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
        this.startOperator(new TranslateOperator(hit.axis));
        if (this.activeOp) this.gizmoDrag = true;
        else if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
      } else if (e.shiftKey) {
        this.ctx.scene.toggleSelect(hit.id);
      } else {
        this.ctx.scene.selectOnly(hit.id);
      }
    }
  }

  private onPointerMove(e: PointerEvent): void {
    const prev = this.pointer;
    this.pointer = this.toLocal(e);

    if (this.activeOp) {
      this.activeOp.onPointerMove(this.ctx, this.pointer);
      return;
    }
    const dx = this.pointer.x - prev.x;
    const dy = this.pointer.y - prev.y;
    if (this.orbiting) this.ctx.camera.orbit(dx, dy);
    else if (this.panning) this.ctx.camera.pan(dx, dy, this.ctx.viewportSize().height);
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
      else if (this.activeOp.onKey(this.ctx, e.key)) e.preventDefault();
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

    // Tab: toggle Edit Mode on the active object. preventDefault keeps the
    // browser from moving focus out of the canvas.
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      const scene = this.ctx.scene;
      if (scene.editMode) {
        scene.exitEditMode();
        this.ctx.setStatus('');
      } else if (scene.enterEditMode()) {
        this.ctx.setStatus('Edit Mode — 1/2/3: vert/edge/face select, Tab: back to Object Mode');
      }
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

    if (this.ctx.scene.editMode) {
      this.onEditModeKey(e, key);
      return; // object-mode keys (G/R/S on objects, X, Shift-A/D) don't apply here
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
      const scene = this.ctx.scene;
      const selected = scene.selectedObjects;
      if (selected.length === 0) return;
      const dups = selected.map((obj) => {
        const dup = scene.add(nextDupName(scene, obj.name), obj.mesh.clone());
        dup.transform = obj.transform; // Transform is immutable — sharing the copy is safe.
        dup.visible = obj.visible;
        return dup;
      });
      scene.selection.clear();
      for (const d of dups) scene.selection.add(d.id);
      scene.activeId = dups.at(-1)?.id ?? null;
      this.ctx.undo.push(new AddObjectsCommand('Duplicate', scene, dups));
      this.ctx.setStatus(`Duplicated ${dups.length} object(s)`);
      this.startOperator(new TranslateOperator());
      return;
    }
    // Ctrl+J: join every selected mesh into the active object (Blender semantics).
    // Object mode only — the edit-mode branch above already returned.
    if (key === 'j' && e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      const scene = this.ctx.scene;
      if (scene.selection.size < 2) {
        this.ctx.setStatus('Join needs 2 or more selected objects');
        return;
      }
      const count = scene.selection.size;
      const cmd = JoinObjectsCommand.perform('Join', scene);
      if (!cmd) {
        this.ctx.setStatus('Join needs the active object to be selected');
        return;
      }
      this.ctx.undo.push(cmd);
      this.ctx.setStatus(`Joined ${count} objects`);
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
      this.startOperator(new BevelOperator());
      return;
    }
    // B: box select. Starts a modal operator whose next LMB drag draws the rect;
    // inside elements are added to (Shift at release: removed from) the selection.
    if (key === 'b' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      const op = new BoxSelectOperator(this.canvas.parentElement as HTMLElement);
      this.startOperator(op);
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
      this.startOperator(new LoopCutOperator(this.renderer));
      return;
    }
    // G/R/S: modal move/rotate/scale of the selected elements' verts.
    if (key === 'g' && !e.ctrlKey && !e.altKey) {
      this.startOperator(new EditTranslateOperator(this.renderer));
      return;
    }
    if (key === 'r' && !e.ctrlKey && !e.altKey) {
      this.startOperator(new EditRotateOperator(this.renderer));
      return;
    }
    if (key === 's' && !e.ctrlKey && !e.altKey) {
      this.startOperator(new EditScaleOperator(this.renderer));
      return;
    }
    // Ctrl+E: bridge two selected edge loops into a ring of quads. Edge mode
    // only; the op reports its own error (mismatched/too-many loops) with no
    // mutation. Placed before plain-E extrude (which guards !e.ctrlKey).
    if (key === 'e' && e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      if (edit.elementMode !== 'edge') {
        this.ctx.setStatus('Bridge Edge Loops: edge mode only');
        return;
      }
      const edgeKeys = new Set(edit.edges);
      let result!: { newFaceIds: number[] } | { error: string };
      const cmd = MeshEditCommand.capture('Bridge Edge Loops', mesh, () => {
        result = bridgeLoops(mesh, edgeKeys);
      });
      if ('error' in result) {
        this.ctx.setStatus(`Bridge: ${result.error}`);
        return; // nothing mutated — drop the no-op command
      }
      this.ctx.undo.push(cmd);
      edit.prune(mesh);
      edit.touch();
      this.ctx.setStatus(`Bridged loops — ${result.newFaceIds.length} faces`);
      return;
    }
    // E: extrude. Face mode rides the region along its average normal; vert/edge
    // mode is not supported in v1 (just tell the user).
    if (key === 'e' && !e.ctrlKey && !e.altKey) {
      if (edit.elementMode !== 'face') {
        this.ctx.setStatus('Extrude: face mode only (v1)');
        return;
      }
      this.startOperator(new ExtrudeOperator());
      return;
    }
    // I: inset each selected face individually. Face mode only.
    if (key === 'i' && !e.ctrlKey && !e.altKey) {
      if (edit.elementMode !== 'face') {
        this.ctx.setStatus('Inset: face mode only');
        return;
      }
      this.startOperator(new InsetOperator());
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
