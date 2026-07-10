import type { Operator, OperatorContext, PointerState } from '../core/operator/Operator';
import type { Vec3 } from '../core/math/vec3';
import { projectToScreen } from './boxSelect';
import { knifeCut } from '../core/mesh/ops/knife';
import { MeshEditCommand } from '../core/undo/meshCommands';

/**
 * K — knife (edit mode). Click to lay a screen-space polyline over the mesh
 * (points + segments drawn yellow, like the loop-cut preview, plus a rubber-band
 * to the cursor). Enter or a double-click confirms the cut; Esc/RMB cancels.
 *
 * The geometry lives in `core/mesh/ops/knife.ts`; this operator only owns the
 * interaction: collecting clicks, drawing the SVG overlay, and — on confirm —
 * building the screen projector + camera-facing test and wrapping the whole cut
 * in ONE undo command (snapshot pattern, like the other modal topology tools).
 *
 * v1 scope notes (see the op's docstring for the full list): only camera-facing
 * faces are split, so there is no cut-through; no angle snapping; UVs drop on
 * modified faces.
 */
export class KnifeOperator implements Operator {
  readonly name = 'Knife';

  private points: PointerState[] = [];
  private cursor: PointerState = { x: 0, y: 0 };
  private svg: SVGSVGElement | null = null;

  constructor(private readonly parent: HTMLElement) {}

  start(ctx: OperatorContext, pointer: PointerState): boolean {
    if (!ctx.scene.editMode || !ctx.scene.editObject) return false;
    this.cursor = { x: pointer.x, y: pointer.y };
    this.createOverlay();
    this.redraw();
    this.updateStatus(ctx);
    return true;
  }

  /** Placed points so far (InputManager uses this for double-click confirm). */
  get pointCount(): number {
    return this.points.length;
  }

  /** The most recently placed point, or null. */
  get lastPoint(): PointerState | null {
    return this.points.at(-1) ?? null;
  }

  /** InputManager calls this on each LMB click to extend the polyline. */
  addPoint(pointer: PointerState): void {
    this.points.push({ x: pointer.x, y: pointer.y });
    this.cursor = { x: pointer.x, y: pointer.y };
    this.redraw();
  }

  onPointerMove(_ctx: OperatorContext, pointer: PointerState): void {
    this.cursor = { x: pointer.x, y: pointer.y };
    this.redraw();
  }

  onKey(): boolean {
    return false; // Enter/Esc are handled by InputManager; no modal keys in v1
  }

  confirm(ctx: OperatorContext): void {
    const obj = ctx.scene.editObject;
    const sel = ctx.scene.editMode;
    if (obj && sel && this.points.length >= 2) {
      const mesh = obj.mesh;
      const { width, height } = ctx.viewportSize();
      const world = ctx.scene.worldMatrix(obj);
      const mvp = ctx.camera.projMatrix(width / height).mul(ctx.camera.viewMatrix()).mul(world);
      const eye = ctx.camera.eye;

      const project = (co: Vec3): [number, number] | null => {
        const s = projectToScreen(co, mvp, width, height);
        return s ? [s.x, s.y] : null;
      };
      // Camera-facing test: transform the face's first 3 verts to world, take the
      // outward normal (verts are CCW-from-outside) and keep faces whose normal
      // opposes the eye→face direction.
      const frontFacing = (fid: number): boolean => {
        const f = mesh.faces.get(fid);
        if (!f || f.verts.length < 3) return false;
        const a = world.transformPoint(mesh.verts.get(f.verts[0])!.co);
        const b = world.transformPoint(mesh.verts.get(f.verts[1])!.co);
        const c = world.transformPoint(mesh.verts.get(f.verts[2])!.co);
        const normal = b.sub(a).cross(c.sub(a));
        return normal.dot(a.sub(eye)) < 0;
      };

      const poly = this.points.map((p) => [p.x, p.y] as [number, number]);
      const before = mesh.clone();
      const res = knifeCut(mesh, poly, project, { frontFacing });
      if (res.newVerts > 0) {
        ctx.undo.push(MeshEditCommand.fromSnapshots('Knife', mesh, before, mesh.clone()));
        sel.prune(mesh);
        sel.touch();
      }
    }
    this.cleanup(ctx);
  }

  cancel(ctx: OperatorContext): void {
    this.cleanup(ctx);
  }

  // --- SVG overlay (screen-space, mirrors the box-select DOM overlay) --------

  private createOverlay(): void {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'knife-overlay');
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
    const YELLOW = '#ffd91a';

    // Polyline through placed points + a dashed rubber-band to the cursor.
    const chain = this.points.map((p) => `${p.x},${p.y}`);
    if (this.points.length >= 1) {
      if (this.points.length >= 2) {
        const solid = document.createElementNS(NS, 'polyline');
        solid.setAttribute('points', chain.join(' '));
        solid.setAttribute('fill', 'none');
        solid.setAttribute('stroke', YELLOW);
        solid.setAttribute('stroke-width', '1.5');
        svg.appendChild(solid);
      }
      const last = this.points.at(-1)!;
      const band = document.createElementNS(NS, 'line');
      band.setAttribute('x1', String(last.x));
      band.setAttribute('y1', String(last.y));
      band.setAttribute('x2', String(this.cursor.x));
      band.setAttribute('y2', String(this.cursor.y));
      band.setAttribute('stroke', YELLOW);
      band.setAttribute('stroke-width', '1.5');
      band.setAttribute('stroke-dasharray', '4 4');
      svg.appendChild(band);
    }
    for (const p of this.points) {
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('cx', String(p.x));
      dot.setAttribute('cy', String(p.y));
      dot.setAttribute('r', '3');
      dot.setAttribute('fill', YELLOW);
      svg.appendChild(dot);
    }
  }

  private cleanup(ctx: OperatorContext): void {
    this.svg?.remove();
    this.svg = null;
    this.points = [];
    ctx.setStatus('');
  }

  private updateStatus(ctx: OperatorContext): void {
    ctx.setStatus('Knife — click to add points, Enter/double-click: cut, Esc/RMB: cancel');
  }
}
