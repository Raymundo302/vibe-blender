import type { Operator, OperatorContext, PointerState } from '../core/operator/Operator';
import type { Renderer } from '../render/Renderer';
import type { Scene } from '../core/scene/Scene';
import { TranslateOperator } from '../tools/translate';
import { RotateOperator } from '../tools/rotate';
import { ScaleOperator } from '../tools/scale';
import { AddMenu } from '../ui/addMenu';
import { AddObjectsCommand, DeleteObjectsCommand } from '../core/undo/objectCommands';

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
  private addMenu: AddMenu | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly ctx: OperatorContext,
    private readonly renderer: Renderer,
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
    if (op.start(this.ctx, this.pointer)) this.activeOp = op;
  }

  private endOperator(confirm: boolean): void {
    if (!this.activeOp) return;
    if (confirm) this.activeOp.confirm(this.ctx);
    else this.activeOp.cancel(this.ctx);
    this.activeOp = null;
  }

  private onPointerDown(e: PointerEvent): void {
    this.pointer = this.toLocal(e);

    if (this.activeOp) {
      // LMB confirms, RMB cancels
      if (e.button === 0) this.endOperator(true);
      else if (e.button === 2) this.endOperator(false);
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
      const id = this.renderer.pick(this.ctx.scene, this.ctx.camera, this.pointer.x, this.pointer.y);
      if (id === null) {
        if (!e.shiftKey) this.ctx.scene.deselectAll();
      } else if (e.shiftKey) {
        this.ctx.scene.toggleSelect(id);
      } else {
        this.ctx.scene.selectOnly(id);
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
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    this.ctx.camera.zoom(e.deltaY);
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (this.activeOp) {
      if (e.key === 'Escape') this.endOperator(false);
      else if (e.key === 'Enter') this.endOperator(true);
      else if (this.activeOp.onKey(this.ctx, e.key)) e.preventDefault();
      return;
    }

    const key = e.key.toLowerCase();
    if (e.ctrlKey && key === 'z') {
      e.preventDefault();
      const name = e.shiftKey ? this.ctx.undo.redo() : this.ctx.undo.undo();
      this.ctx.setStatus(name ? `${e.shiftKey ? 'Redo' : 'Undo'}: ${name}` : 'Nothing to undo');
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
}
