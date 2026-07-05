import type { Operator, OperatorContext, PointerState } from '../core/operator/Operator';
import type { Renderer } from '../render/Renderer';
import { TranslateOperator } from '../tools/translate';

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
    if (key === 'a' && e.altKey) {
      e.preventDefault();
      this.ctx.scene.deselectAll();
    }
  }
}
