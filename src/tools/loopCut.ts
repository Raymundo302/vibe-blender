import type { Operator, OperatorContext, PointerState } from '../core/operator/Operator';
import type { Renderer } from '../render/Renderer';
import { loopFromEdge, cutLoop, loopPreviewSegments, type EdgeLoop } from '../core/mesh/ops/loopcut';
import { MeshEditCommand } from '../core/undo/meshCommands';

/**
 * Ctrl+R — loop cut (P2-7). Hovering an edge previews the perpendicular edge
 * loop through its quad strip (yellow); LMB/Enter cuts at the midpoint and
 * selects the new loop in edge mode. RMB/Esc cancels.
 *
 * v1 scope: single cut at t=0.5, no edge slide after the cut.
 */
export class LoopCutOperator implements Operator {
  readonly name = 'Loop Cut';

  private loop: EdgeLoop | null = null;
  private hoverKey: string | null = null;

  constructor(private readonly renderer: Renderer) {}

  start(ctx: OperatorContext, pointer: PointerState): boolean {
    if (!ctx.scene.editMode || !ctx.scene.editObject) return false;
    this.updateHover(ctx, pointer);
    this.updateStatus(ctx);
    return true;
  }

  private updateHover(ctx: OperatorContext, pointer: PointerState): void {
    const hit = this.renderer.pickElement(ctx.scene, ctx.camera, pointer.x, pointer.y, 'edge');
    const key = hit?.kind === 'edge' ? hit.key : null;
    if (key === this.hoverKey) return;
    this.hoverKey = key;

    const mesh = ctx.scene.editObject!.mesh;
    this.loop = key ? loopFromEdge(mesh, key) : null;
    this.renderer.editPreviewLines =
      this.loop && this.loop.edgeKeys.length > 0 ? loopPreviewSegments(mesh, this.loop) : null;
  }

  onPointerMove(ctx: OperatorContext, pointer: PointerState): void {
    this.updateHover(ctx, pointer);
    this.updateStatus(ctx);
  }

  onKey(): boolean {
    return false; // no modal keys in v1 (segment count / slide are out of scope)
  }

  confirm(ctx: OperatorContext): void {
    const editObj = ctx.scene.editObject;
    const sel = ctx.scene.editMode;
    if (editObj && sel && this.loop) {
      const mesh = editObj.mesh;
      let newEdgeKeys: string[] = [];
      ctx.undo.push(
        MeshEditCommand.capture(this.name, mesh, () => {
          newEdgeKeys = cutLoop(mesh, this.loop!).newEdgeKeys;
        }),
      );
      // Blender selects the fresh loop in edge mode.
      sel.elementMode = 'edge';
      sel.clearSelection();
      for (const k of newEdgeKeys) sel.edges.add(k);
      sel.touch();
    }
    this.cleanup(ctx);
  }

  cancel(ctx: OperatorContext): void {
    this.cleanup(ctx);
  }

  private cleanup(ctx: OperatorContext): void {
    this.renderer.editPreviewLines = null;
    ctx.setStatus('');
  }

  private updateStatus(ctx: OperatorContext): void {
    ctx.setStatus(
      this.loop
        ? `Loop Cut  (${this.loop.edgeKeys.length} edges, ${this.loop.closed ? 'closed' : 'open'})  LMB/Enter: cut  RMB/Esc: cancel`
        : 'Loop Cut  hover an edge to preview  RMB/Esc: cancel',
    );
  }
}
