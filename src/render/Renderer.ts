import type { GlContext } from './gl/context';
import { VertexArray } from './gl/VertexArray';
import { MeshPass } from './passes/meshPass';
import { StudioPass } from './passes/studioPass';
import { WirePass } from './passes/wirePass';
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
import { RenderedPass, collectLights } from './passes/renderedPass';
import { IconPass, type IconShape } from './passes/iconPass';
import { createMatcapTexture } from './matcap';
import { meshToRenderData } from '../core/mesh/meshToGpu';
import type { Scene, SceneObject } from '../core/scene/Scene';
import type { OrbitCamera } from '../camera/OrbitCamera';
import type { Vec3 } from '../core/math/vec3';

interface GpuMesh {
  triangles: VertexArray;
  /** Unique-edge line segments (position-only), for wireframe shading. */
  edges: VertexArray;
  /** Composite cache key: which mesh (base vs evaluated) + its versions. */
  version: string;
}

/** Viewport solid-shading mode; Z cycles matcap → wireframe → studio → rendered. */
export type ShadingMode = 'matcap' | 'wireframe' | 'studio' | 'rendered';

const SHADING_CYCLE: readonly ShadingMode[] = ['matcap', 'wireframe', 'studio', 'rendered'];

/**
 * What a pick landed on: a scene object, a translate-gizmo axis handle, or
 * (null) the background. InputManager branches on `kind`.
 */
export type PickResult =
  | { kind: 'object'; id: number }
  | { kind: 'gizmo'; axis: GizmoAxis };

const BG = [0.227, 0.227, 0.227] as const; // Blender viewport grey

/** Which glyph the icon pass draws for a non-mesh object. */
function iconShape(obj: SceneObject): IconShape {
  if (obj.kind === 'camera') return 3;
  switch (obj.light?.type) {
    case 'sun': return 1;
    case 'spot': return 2;
    default: return 0;
  }
}

export class Renderer {
  private readonly meshPass: MeshPass;
  private readonly studioPass: StudioPass;
  private readonly wirePass: WirePass;
  private readonly gridPass: GridPass;
  private readonly outlinePass: OutlinePass;
  private readonly pickingPass: PickingPass;
  private readonly gizmoPass: GizmoPass;
  private readonly editOverlayPass: EditOverlayPass;
  private readonly elementPickPass: ElementPickPass;
  private readonly renderedPass: RenderedPass;
  private readonly iconPass: IconPass;
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
   * Current viewport solid-shading mode. Z (or the topbar chip) cycles it via
   * {@link cycleShadingMode}. The solid pass in render() branches on this;
   * outlines / edit-cage / gizmo overlays are unaffected.
   */
  shadingMode: ShadingMode = 'matcap';

  /**
   * Ad-hoc overlay polyline in the edit object's LOCAL space (loop-cut
   * preview). Owning operator sets it on hover and MUST null it on
   * confirm/cancel. Pass a NEW array per change — it doubles as the cache key.
   */
  editPreviewLines: Float32Array | null = null;

  constructor(private readonly ctx: GlContext) {
    const { gl, canvas } = ctx;
    this.meshPass = new MeshPass(gl, createMatcapTexture(gl));
    this.studioPass = new StudioPass(gl);
    this.wirePass = new WirePass(gl);
    this.gridPass = new GridPass(gl);
    this.outlinePass = new OutlinePass(gl, canvas.width, canvas.height);
    this.pickingPass = new PickingPass(gl, canvas.width, canvas.height);
    this.gizmoPass = new GizmoPass(gl);
    this.editOverlayPass = new EditOverlayPass(gl);
    this.elementPickPass = new ElementPickPass(gl, canvas.width, canvas.height);
    this.renderedPass = new RenderedPass(gl);
    this.iconPass = new IconPass(gl);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
  }

  /**
   * GPU buffers for what this object DISPLAYS: the modifier-evaluated mesh in
   * object mode, the raw base mesh while it is being edited (modifiers are
   * hidden during edit — predictable cage, no double-vision).
   */
  private gpuMesh(obj: SceneObject, scene: Scene): GpuMesh {
    const editing = scene.editMode?.objectId === obj.id;
    const mesh = editing ? obj.mesh : obj.evaluatedMesh();
    const version = `${editing ? 'edit' : 'obj'}:${mesh.version}:${obj.modifiersVersion}:${obj.shadeSmooth ? 's' : 'f'}`;
    const cached = this.gpuMeshes.get(obj.id);
    if (cached && cached.version === version) return cached;
    cached?.triangles.dispose();
    cached?.edges.dispose();

    const data = meshToRenderData(mesh, obj.shadeSmooth);
    const entry: GpuMesh = {
      triangles: new VertexArray(this.ctx.gl, [
        { location: 0, size: 3, data: data.trianglePositions },
        { location: 1, size: 3, data: data.triangleNormals },
      ]),
      edges: new VertexArray(this.ctx.gl, [
        { location: 0, size: 3, data: data.edgePositions },
      ]),
      version,
    };
    this.gpuMeshes.set(obj.id, entry);
    return entry;
  }

  /**
   * Advance the shading mode one step (matcap → wireframe → studio → matcap)
   * and return the new mode. Called by the Z keybind and the topbar chip.
   */
  cycleShadingMode(): ShadingMode {
    const i = SHADING_CYCLE.indexOf(this.shadingMode);
    this.shadingMode = SHADING_CYCLE[(i + 1) % SHADING_CYCLE.length];
    return this.shadingMode;
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

    // Solid pass — branch on shading mode. Wireframe draws dark edge lines with
    // no fill; matcap/studio fill triangles with their respective shaders.
    if (this.shadingMode === 'wireframe') {
      this.wirePass.begin(view, proj);
      for (const obj of visible) {
        this.wirePass.setObject(obj.transform.matrix());
        this.gpuMesh(obj, scene).edges.draw(gl.LINES);
      }
    } else if (this.shadingMode === 'studio') {
      this.studioPass.begin(view, proj);
      for (const obj of visible) {
        this.studioPass.setObject(obj.transform.matrix(), view, obj.color);
        this.gpuMesh(obj, scene).triangles.draw(gl.TRIANGLES);
      }
    } else if (this.shadingMode === 'rendered') {
      this.renderedPass.begin(view, proj, camera.eye, collectLights(scene));
      for (const obj of visible) {
        if (obj.kind !== 'mesh') continue;
        this.renderedPass.setObject(obj.transform.matrix(), scene.materialOf(obj));
        this.gpuMesh(obj, scene).triangles.draw(gl.TRIANGLES);
      }
    } else {
      this.meshPass.begin(view, proj);
      for (const obj of visible) {
        this.meshPass.setObject(obj.transform.matrix(), view, obj.color);
        this.gpuMesh(obj, scene).triangles.draw(gl.TRIANGLES);
      }
    }

    // Grid (blended, after opaque)
    this.gridPass.render(view, proj, camera.eye);

    // Billboard icons for non-mesh objects (lights, cameras)
    const icons = visible.filter((o) => o.kind !== 'mesh');
    if (icons.length > 0) {
      this.iconPass.begin(proj.mul(view), canvas.width, canvas.height);
      for (const obj of icons) {
        const selected = scene.selection.has(obj.id);
        const color: [number, number, number] = selected
          ? (scene.activeId === obj.id ? [1, 0.66, 0.25] : [0.95, 0.55, 0.2])
          : [0.85, 0.85, 0.85];
        this.iconPass.draw(obj.transform.position, iconShape(obj), color);
      }
    }

    // Selection outlines — the object being edited gets the cage, not an outline
    const editObj = scene.editObject;
    const selected = visible.filter((o) => scene.selection.has(o.id) && o !== editObj);
    if (selected.length > 0) {
      const viewProj = proj.mul(view);
      this.outlinePass.beginMask();
      for (const obj of selected) {
        this.outlinePass.maskObject(viewProj.mul(obj.transform.matrix()));
        this.gpuMesh(obj, scene).triangles.draw(gl.TRIANGLES);
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
      this.gpuMesh(obj, scene).triangles.draw(gl.TRIANGLES);
    }
    const gz = this.gizmoTransform(scene, camera);
    if (gz) {
      gl.clear(gl.DEPTH_BUFFER_BIT); // pick FBO still bound: gizmo handles win
      this.gizmoPass.renderPick(this.pickingPass, viewProj, gz.origin, gz.scale);
    }
    // Light/camera icons — drawn last (iconPass switches GL programs, and
    // pickingPass.drawObject assumes the picking shader is still active).
    const iconObjs = scene.objects.filter((o) => o.visible && o.kind !== 'mesh');
    if (iconObjs.length > 0) {
      this.iconPass.begin(viewProj, canvas.width, canvas.height);
      for (const obj of iconObjs) this.iconPass.drawPick(obj.transform.position, obj.id + 1);
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
