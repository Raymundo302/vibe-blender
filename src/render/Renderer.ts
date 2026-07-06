import type { GlContext } from './gl/context';
import { VertexArray } from './gl/VertexArray';
import { MeshPass } from './passes/meshPass';
import { GridPass } from './passes/gridPass';
import { OutlinePass } from './passes/outlinePass';
import { PickingPass } from './passes/pickingPass';
import { GizmoPass, GIZMO_PICK_BASE, GIZMO_AXES, gizmoScreenScale, type GizmoAxis } from './passes/gizmoPass';
import { EditOverlayPass } from './passes/editOverlayPass';
import {
  ElementPickPass,
  closestNonZeroId,
  decodePick,
  type ElementPickResult,
} from './passes/elementPickPass';
import { elementIndexMaps } from '../core/mesh/editOverlayData';
import { createMatcapTexture } from './matcap';
import { meshToRenderData } from '../core/mesh/meshToGpu';
import type { Scene, SceneObject } from '../core/scene/Scene';
import type { OrbitCamera } from '../camera/OrbitCamera';
import type { Vec3 } from '../core/math/vec3';

interface GpuMesh {
  triangles: VertexArray;
  version: number;
}

/**
 * What a pick landed on: a scene object, a translate-gizmo axis handle, or
 * (null) the background. InputManager branches on `kind`.
 */
export type PickResult =
  | { kind: 'object'; id: number }
  | { kind: 'gizmo'; axis: GizmoAxis };

const BG = [0.227, 0.227, 0.227] as const; // Blender viewport grey

export class Renderer {
  private readonly meshPass: MeshPass;
  private readonly gridPass: GridPass;
  private readonly outlinePass: OutlinePass;
  private readonly pickingPass: PickingPass;
  private readonly gizmoPass: GizmoPass;
  private readonly editOverlayPass: EditOverlayPass;
  private readonly elementPickPass: ElementPickPass;
  /** GPU buffers per object id, invalidated by mesh.version. */
  private readonly gpuMeshes = new Map<number, GpuMesh>();

  /**
   * Whether the translate gizmo may draw / be picked. InputManager clears this
   * while a modal operator owns input (so no gizmo shows mid-G/R/S or mid-drag)
   * and restores it when the operator ends. It only shows when there is also an
   * active object, so nothing is drawn on an empty selection either.
   */
  gizmoVisible = true;

  /**
   * Ad-hoc overlay polyline in the edit object's LOCAL space (loop-cut
   * preview). Owning operator sets it on hover and MUST null it on
   * confirm/cancel. Pass a NEW array per change — it doubles as the cache key.
   */
  editPreviewLines: Float32Array | null = null;

  constructor(private readonly ctx: GlContext) {
    const { gl, canvas } = ctx;
    this.meshPass = new MeshPass(gl, createMatcapTexture(gl));
    this.gridPass = new GridPass(gl);
    this.outlinePass = new OutlinePass(gl, canvas.width, canvas.height);
    this.pickingPass = new PickingPass(gl, canvas.width, canvas.height);
    this.gizmoPass = new GizmoPass(gl);
    this.editOverlayPass = new EditOverlayPass(gl);
    this.elementPickPass = new ElementPickPass(gl, canvas.width, canvas.height);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
  }

  private gpuMesh(obj: SceneObject): GpuMesh {
    const cached = this.gpuMeshes.get(obj.id);
    if (cached && cached.version === obj.mesh.version) return cached;
    cached?.triangles.dispose();

    const data = meshToRenderData(obj.mesh);
    const entry: GpuMesh = {
      triangles: new VertexArray(this.ctx.gl, [
        { location: 0, size: 3, data: data.trianglePositions },
        { location: 1, size: 3, data: data.triangleNormals },
      ]),
      version: obj.mesh.version,
    };
    this.gpuMeshes.set(obj.id, entry);
    return entry;
  }

  render(scene: Scene, camera: OrbitCamera): void {
    const { gl, canvas } = this.ctx;
    if (this.ctx.syncSize()) {
      this.outlinePass.resize(canvas.width, canvas.height);
      this.pickingPass.resize(canvas.width, canvas.height);
      this.elementPickPass.resize(canvas.width, canvas.height);
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(BG[0], BG[1], BG[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const view = camera.viewMatrix();
    const proj = camera.projMatrix(canvas.width / canvas.height);
    const visible = scene.objects.filter((o) => o.visible);

    // Solid matcap meshes
    this.meshPass.begin(view, proj);
    for (const obj of visible) {
      this.meshPass.setObject(obj.transform.matrix(), view);
      this.gpuMesh(obj).triangles.draw(gl.TRIANGLES);
    }

    // Grid (blended, after opaque)
    this.gridPass.render(view, proj, camera.eye);

    // Selection outlines — the object being edited gets the cage, not an outline
    const editObj = scene.editObject;
    const selected = visible.filter((o) => scene.selection.has(o.id) && o !== editObj);
    if (selected.length > 0) {
      const viewProj = proj.mul(view);
      this.outlinePass.beginMask();
      for (const obj of selected) {
        this.outlinePass.maskObject(viewProj.mul(obj.transform.matrix()));
        this.gpuMesh(obj).triangles.draw(gl.TRIANGLES);
      }
      this.outlinePass.endMask(canvas.width, canvas.height);
      this.outlinePass.renderEdges();
    }

    // Edit-mode cage (verts/edges/selected-face fill)
    if (editObj && editObj.visible && scene.editMode) {
      const mvp = proj.mul(view).mul(editObj.transform.matrix());
      this.editOverlayPass.render(mvp, editObj.mesh, scene.editMode);
      if (this.editPreviewLines) this.editOverlayPass.renderPreview(mvp, this.editPreviewLines);
    }

    // Translate gizmo — on top of everything (clear depth after outlines).
    const gz = this.gizmoTransform(scene, camera);
    if (gz) {
      gl.clear(gl.DEPTH_BUFFER_BIT);
      this.gizmoPass.render(proj.mul(view), gz.origin, gz.scale);
    }
  }

  /** Gizmo placement (active object's position) + constant-screen-size scale, or null when hidden. */
  private gizmoTransform(scene: Scene, camera: OrbitCamera): { origin: Vec3; scale: number } | null {
    if (!this.gizmoVisible) return null;
    if (scene.editMode) return null; // object gizmo has no meaning in edit mode (P2-3 may add an element gizmo)
    const active = scene.activeObject;
    if (!active || !active.visible) return null;
    const origin = active.transform.position;
    return { origin, scale: gizmoScreenScale(camera.eye, origin, camera.fovY) };
  }

  /**
   * Pick what is under CSS-pixel position (x, y). Renders the id buffer on
   * demand: objects first, then (if visible) the gizmo handles LAST with depth
   * cleared so they win over objects behind them. Returns null for background.
   */
  pick(scene: Scene, camera: OrbitCamera, cssX: number, cssY: number): PickResult | null {
    const { gl, canvas } = this.ctx;
    const view = camera.viewMatrix();
    const proj = camera.projMatrix(canvas.width / canvas.height);
    const viewProj = proj.mul(view);

    this.pickingPass.begin();
    for (const obj of scene.objects) {
      if (!obj.visible) continue;
      this.pickingPass.drawObject(viewProj.mul(obj.transform.matrix()), obj.id + 1);
      this.gpuMesh(obj).triangles.draw(gl.TRIANGLES);
    }
    const gz = this.gizmoTransform(scene, camera);
    if (gz) {
      gl.clear(gl.DEPTH_BUFFER_BIT); // pick FBO still bound: gizmo handles win
      this.gizmoPass.renderPick(this.pickingPass, viewProj, gz.origin, gz.scale);
    }
    this.pickingPass.end(canvas.width, canvas.height);

    const dpr = window.devicePixelRatio || 1;
    const raw = this.pickingPass.read(Math.round(cssX * dpr), Math.round(cssY * dpr));
    if (raw === 0) return null;
    if (raw >= GIZMO_PICK_BASE) return { kind: 'gizmo', axis: GIZMO_AXES[raw - GIZMO_PICK_BASE] };
    return { kind: 'object', id: raw - 1 };
  }

  /**
   * Pick the edit-object element (vert/edge/face for the current elementMode)
   * under CSS-pixel (cssX, cssY). Renders the element id buffer on demand and
   * reads a 9×9 region so small elements have click tolerance. Returns element
   * ids/keys (not indices), or null for a miss / when not in edit mode.
   */
  pickElement(
    scene: Scene,
    camera: OrbitCamera,
    cssX: number,
    cssY: number,
    kindOverride?: 'vert' | 'edge' | 'face',
  ): ElementPickResult | null {
    const editObj = scene.editObject;
    const sel = scene.editMode;
    if (!editObj || !sel) return null;
    const { gl, canvas } = this.ctx;

    const view = camera.viewMatrix();
    const proj = camera.projMatrix(canvas.width / canvas.height);
    const mvp = proj.mul(view).mul(editObj.transform.matrix());
    this.elementPickPass.render(mvp, editObj.mesh, kindOverride ?? sel.elementMode);

    // Center a clamped 9×9 window on the cursor (device pixels, GL bottom-up).
    const dpr = window.devicePixelRatio || 1;
    const px = Math.round(cssX * dpr);
    const py = Math.round(cssY * dpr);
    const w = canvas.width;
    const h = canvas.height;
    const glCenterY = h - 1 - py;
    const size = 9;
    const x0 = Math.max(0, Math.min(px - 4, w - size));
    const y0 = Math.max(0, Math.min(glCenterY - 4, h - size));
    const region = this.elementPickPass.readRegion(x0, y0, size, size);
    const raw = closestNonZeroId(region, size, size, px - x0, glCenterY - y0);
    gl.viewport(0, 0, canvas.width, canvas.height);

    if (raw === 0) return null;
    return decodePick(raw, elementIndexMaps(editObj.mesh));
  }
}
