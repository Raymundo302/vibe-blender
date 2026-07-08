import type { Operator, OperatorContext, PointerState } from '../core/operator/Operator';
import type { EditModeState } from '../core/scene/EditMode';
import type { EditableMesh } from '../core/mesh/EditableMesh';
import type { Mat4 } from '../core/math/mat4';
import { Vec3 } from '../core/math/vec3';
import { rayPlane } from '../core/math/ray';
import { extrudeFaces } from '../core/mesh/ops/extrude';
import { MeshEditCommand } from '../core/undo/meshCommands';
import { NumericInput } from './numericInput';

/**
 * E (edit mode, face select) — Blender's face extrude. On start it lifts the
 * selected face region off the mesh (walled by side quads), selects the new cap
 * faces, then rides the pointer to slide the cap along the region's average
 * normal. Numeric input sets the distance exactly. LMB/Enter confirm, RMB/Esc
 * cancel (restoring the pre-extrude mesh).
 *
 * Follows the "modal TOPOLOGY tools" undo pattern: snapshot before, mutate as
 * the preview, then push a from-snapshots command on confirm.
 */
export class ExtrudeOperator implements Operator {
  readonly name = 'Extrude';

  private mesh!: EditableMesh;
  private sel!: EditModeState;
  private before!: EditableMesh;

  /** Cap verts to slide, and their local coordinates at extrude time. */
  private capVerts: number[] = [];
  private capStartCo = new Map<number, Vec3>();

  private invMatrix!: Mat4;
  /** World-space extrude direction (average cap normal, unit length). */
  private worldAxis = Vec3.Y;
  /** World-space pivot (centroid of the cap verts). */
  private pivot = Vec3.ZERO;

  private readonly numeric = new NumericInput();
  private startOffset = 0;
  private pointerDist = 0;
  private dist = 0;

  start(ctx: OperatorContext, pointer: PointerState): boolean {
    const sel = ctx.scene.editMode;
    const obj = ctx.scene.editObject;
    if (!sel || !obj) return false;
    if (sel.elementMode !== 'face') return false;
    const faceIds = new Set([...sel.faces].filter((id) => obj.mesh.faces.has(id)));
    if (faceIds.size === 0) return false;

    this.sel = sel;
    this.mesh = obj.mesh;
    this.before = this.mesh.clone();

    const { capFaceIds } = extrudeFaces(this.mesh, faceIds);

    // Selection becomes the new cap faces (their ids are unchanged, remapped).
    sel.faces.clear();
    for (const id of capFaceIds) sel.faces.add(id);
    sel.touch();

    this.capVerts = [...sel.selectedVertIds(this.mesh)];
    for (const id of this.capVerts) this.capStartCo.set(id, this.mesh.verts.get(id)!.co);

    const matrix = ctx.scene.worldMatrix(obj);
    this.invMatrix = matrix.invert();

    // Average of the cap face normals (local), pushed to world for the drag axis.
    let nsum = Vec3.ZERO;
    for (const id of capFaceIds) nsum = nsum.add(this.mesh.faceNormal(id));
    this.worldAxis = matrix.transformDir(nsum.normalize()).normalize();

    let psum = Vec3.ZERO;
    for (const id of this.capVerts) psum = psum.add(matrix.transformPoint(this.mesh.verts.get(id)!.co));
    this.pivot = psum.scale(1 / this.capVerts.length);

    this.startOffset = this.axisHit(ctx, pointer) ?? 0;
    this.pointerDist = 0;
    this.apply(ctx);
    return true;
  }

  /** Signed distance along the extrude axis of the pointer ray's hit on the axis plane. */
  private axisHit(ctx: OperatorContext, pointer: PointerState): number | null {
    const { width, height } = ctx.viewportSize();
    const ray = ctx.camera.pointerRay(pointer.x, pointer.y, width, height);
    const forward = ctx.camera.forward;
    // Plane containing the axis that faces the camera most (same trick as translate).
    const planeNormal = this.worldAxis.cross(forward).cross(this.worldAxis).normalize();
    const hit = rayPlane(ray, this.pivot, planeNormal);
    if (!hit) return null;
    return hit.sub(this.pivot).dot(this.worldAxis);
  }

  onPointerMove(ctx: OperatorContext, pointer: PointerState): void {
    const off = this.axisHit(ctx, pointer);
    if (off !== null) this.pointerDist = off - this.startOffset;
    this.apply(ctx);
  }

  onKey(ctx: OperatorContext, key: string): boolean {
    if (this.numeric.handleKey(key)) {
      this.apply(ctx);
      return true;
    }
    return false;
  }

  private apply(ctx: OperatorContext): void {
    const numeric = this.numeric.value;
    this.dist = numeric !== null ? numeric : this.pointerDist;
    // Slide by `dist` world units along the world axis, converted to local.
    const localDelta = this.invMatrix.transformDir(this.worldAxis.scale(this.dist));
    for (const id of this.capVerts) this.mesh.setVertCo(id, this.capStartCo.get(id)!.add(localDelta));
    this.updateStatus(ctx);
  }

  confirm(ctx: OperatorContext): void {
    ctx.undo.push(MeshEditCommand.fromSnapshots(this.name, this.mesh, this.before, this.mesh.clone()));
    this.sel.touch();
    ctx.setStatus('');
  }

  cancel(ctx: OperatorContext): void {
    this.mesh.copyFrom(this.before);
    this.sel.prune(this.mesh);
    this.sel.touch();
    ctx.setStatus('');
  }

  private updateStatus(ctx: OperatorContext): void {
    const dText = this.numeric.text !== '' ? this.numeric.text : this.dist.toFixed(3);
    ctx.setStatus(`Extrude  D: ${dText}  LMB/Enter: confirm  RMB/Esc: cancel`);
  }
}
