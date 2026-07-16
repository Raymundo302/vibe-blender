import type { GlContext } from './gl/context';
import { VertexArray } from './gl/VertexArray';
import { MeshPass } from './passes/meshPass';
import { StudioPass } from './passes/studioPass';
import { TexturedPass } from './passes/texturedPass';
import { WirePass } from './passes/wirePass';
import { IntersectPass, segmentsToRibbon } from './passes/intersectPass';
import { buildWireRibbon } from './passes/ribbon';
import { GridPass } from './passes/gridPass';
import { OutlinePass } from './passes/outlinePass';
import { PickingPass } from './passes/pickingPass';
import { GizmoPass, GIZMO_PICK_BASE, GIZMO_PLANE_BASE, GIZMO_AXES, GIZMO_PLANES, gizmoScreenScale, type GizmoAxis, type GizmoPlane, type AxisColors } from './passes/gizmoPass';
import { EditOverlayPass } from './passes/editOverlayPass';
import { CurveEditPass } from './passes/curveEditPass';
import { CombPass } from './passes/combPass';
import { SurfaceNetPass } from './passes/surfaceNetPass';
import { evaluateCurve, leftHandle, rightHandle } from '../core/curve/eval';
import { WIRE_MIN_PX, WIRE_MAX_PX } from './passes/ribbon';
import {
  ElementPickPass,
  closestNonZeroId,
  decodePick,
  xrayState,
  type ElementPickResult,
} from './passes/elementPickPass';
import { elementIndexMaps } from '../core/mesh/editOverlayData';
import { RenderedPass, WorldBackgroundPass, collectLights, shadowCasterIndices, cubeCasterIndices, type LightSet } from './passes/renderedPass';
import { ShadowPass, sunShadowMatrix, spotShadowMatrix, cubeFaceView, SHADOW_SLOTS, CUBE_SHADOW_SLOTS } from './passes/shadowPass';
import { averageWorldColor } from '../core/scene/worldData';
import { IconPass, type IconShape } from './passes/iconPass';
import { CameraFrustumPass, cameraFrameProjMatrix } from './passes/cameraFrustumPass';
import { applyCamView, identityCamView, type CamView } from '../camera/camView';
import { LightDirPass, hasAimArrow } from './passes/lightDirPass';
import { EmptyAxesPass } from './passes/emptyAxesPass';
import { ensureBaked } from '../core/nodes/bake';
import { nodeImageCache } from '../core/nodes/imageCache';
import { kindHasMaterial, cameraFovY, type Material, type GlareSettings } from '../core/scene/objectData';
import { overlays } from './overlayPrefs';
import { typeShown, typePickable } from './objectTypePrefs';
import { shadePrefs } from './shadePrefs';
import { AoPass } from './passes/aoPass';
import { GlarePass } from './passes/glarePass';
import { RayPresentPass } from './passes/rayPresentPass';
import { ViewportRay } from './viewportRay';
import { SdfAtlas } from './sdfAtlas';
import { createMatcapTexture } from './matcap';
import { matcapById } from './matcaps';
import { themeViewport } from '../ui/themes';
import { meshToRenderData } from '../core/mesh/meshToGpu';
import { meshIntersectionSegments } from '../core/mesh/intersect';
import type { Scene, SceneObject } from '../core/scene/Scene';
import type { OrbitCamera } from '../camera/OrbitCamera';
import { Mat4 } from '../core/math/mat4';
import { Quat } from '../core/math/quat';
import { Vec3 } from '../core/math/vec3';

interface GpuMesh {
  triangles: VertexArray;
  /** Unique-edge line segments (pos + adjacent face normals), gl.LINES. Kept
   *  for the wire-proximity object pick (rendered into the pick buffer). */
  edges: VertexArray;
  /** The same edges expanded into anti-aliased proximity-thickened ribbons
   *  (UR6-1) — what the wireframe / overlay / hidden-line passes DISPLAY. */
  wireRibbon: VertexArray;
  /** Composite cache key: which mesh (base vs evaluated) + its versions. */
  version: string;
  /** Local-space AABB of the triangles (null for empty meshes) — frames the
   *  sun shadow map's ortho box without re-touching vertex data per frame. */
  bounds: { min: Vec3; max: Vec3 } | null;
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
  | { kind: 'gizmo'; axis: GizmoAxis }
  | { kind: 'gizmoPlane'; plane: GizmoPlane };

/** The gizmo/axis palette from overlay prefs (drives arrows + plane handles). */
function axisColorsFromPrefs(): AxisColors {
  return {
    x: [overlays.axisX[0], overlays.axisX[1], overlays.axisX[2]],
    y: [overlays.axisY[0], overlays.axisY[1], overlays.axisY[2]],
    z: [overlays.axisZ[0], overlays.axisZ[1], overlays.axisZ[2]],
  };
}

// Viewport clear color comes from the active theme (themeViewport.background).

/** Which glyph the icon pass draws for a non-mesh object. */
function iconShape(obj: SceneObject): IconShape {
  if (obj.kind === 'camera') return 3;
  switch (obj.light?.type) {
    case 'sun': return 1;
    case 'spot': return 2;
    default: return 0;
  }
}

/**
 * Overlay tint for a non-mesh object's icon / frustum: selection orange (bright
 * for the active object, dimmer for the rest of the selection), light grey when
 * unselected. Shared by the icon pass and the camera-frustum pass so both read
 * as one selection system.
 */
function selectionColor(scene: Scene, obj: SceneObject): [number, number, number] {
  if (!scene.selection.has(obj.id)) return [0.85, 0.85, 0.85];
  // Active (last-selected) glows a bright near-white orange so it reads clearly
  // as the "active" object among a multi-selection (it acts as the pivot/parent
  // for Active-Element transforms); the rest get a duller, darker orange.
  return scene.activeId === obj.id ? [1, 0.82, 0.5] : [0.82, 0.4, 0.12];
}

export class Renderer {
  private readonly meshPass: MeshPass;
  private readonly studioPass: StudioPass;
  private readonly texturedPass: TexturedPass;
  private readonly wirePass: WirePass;
  private readonly intersectPass: IntersectPass;
  private readonly gridPass: GridPass;
  private readonly outlinePass: OutlinePass;
  private readonly pickingPass: PickingPass;
  private readonly gizmoPass: GizmoPass;
  private readonly editOverlayPass: EditOverlayPass;
  private readonly curveEditPass: CurveEditPass;
  private readonly combPass: CombPass;
  private readonly surfaceNetPass: SurfaceNetPass;
  private readonly elementPickPass: ElementPickPass;
  private readonly renderedPass: RenderedPass;
  private readonly shadowPass: ShadowPass;
  private readonly aoPass: AoPass;
  /** Camera Glare / bloom for the through-camera Rendered viewport (UR10-2 B). */
  private readonly glarePass: GlarePass;
  /** Fullscreen present of the viewport raytraced accumulation (UR15-1). */
  private readonly rayPresentPass: RayPresentPass;
  /** Progressive path-trace driver for Rendered → Raytraced mode (UR15-1). */
  readonly viewportRay = new ViewportRay();
  private readonly sdfAtlas: SdfAtlas;
  private readonly worldBgPass: WorldBackgroundPass;
  private readonly iconPass: IconPass;
  private readonly cameraFrustumPass: CameraFrustumPass;
  private readonly lightDirPass: LightDirPass;
  private readonly emptyAxesPass: EmptyAxesPass;
  /** GPU buffers per object id, invalidated by mesh.version. */
  private readonly gpuMeshes = new Map<number, GpuMesh>();
  /**
   * Mesh-mesh intersection curves ("Intersections" shading option): one cached
   * position-only line VertexArray (world space) covering every intersecting
   * pair of visible meshes. Rebuilt only when the composite geometry+transform
   * key changes AND the throttle has elapsed (mirrors the SDF-atlas pattern —
   * a modal drag bumps the key every frame but re-CSG-ing per frame would
   * hitch). `cpuTriCache` holds each object's OBJECT-space triangle positions
   * keyed by its gpuMesh version so a rebuild only re-transforms, not
   * re-flattens, the mesh.
   */
  private intersectionLines: VertexArray | null = null;
  private intersectionKey = '';
  private intersectionBuiltAt = 0;
  private readonly cpuTriCache = new Map<number, { version: string; tris: Float32Array }>();
  /** Equirect HDRI texture for the Rendered-mode background, or null. */
  private hdriTexture: WebGLTexture | null = null;
  /** The `world.hdri` data URL currently uploaded (null tracks "none"). */
  private hdriUrl: string | null = null;
  /**
   * Lazy per-material base-color texture cache (P11), keyed by material id. `url`
   * tracks which data URL is uploaded so a texDataUrl change re-uploads; `tex`
   * stays null while the async image decodes (falls back to white until ready).
   */
  private readonly matTextures = new Map<number, { url: string; tex: WebGLTexture | null; alphaBlend: boolean }>();
  /** P13: lazy data-URL → GL texture cache for map slots. Key prefix encodes
   *  color space ('s:' sRGB base color, 'l:' linear data maps). */
  private readonly urlTextures = new Map<string, { tex: WebGLTexture | null }>();

  /**
   * Whether the translate gizmo may draw / be picked. InputManager clears this
   * while a modal operator owns input (so no gizmo shows mid-G/R/S or mid-drag)
   * and restores it when the operator ends. It only shows when there is also an
   * active object, so nothing is drawn on an empty selection either.
   */
  gizmoVisible = true;

  /**
   * Modal axis-lock indicator: while a G/R/S runs with an X/Y/Z constraint,
   * InputManager mirrors the operator's lock here and render() draws just that
   * axis's arrow + guide line at the operator's pivot (the full gizmo stays
   * hidden). Null when no modal or no lock.
   */
  axisIndicator: { axis: GizmoAxis; pivot: Vec3 } | null = null;

  /**
   * WORLD-space guide line segments to draw while a modal runs — the edge-slide
   * tangent rails. InputManager mirrors the active operator's guideSegments()
   * here (see {@link axisIndicator}); render() draws them in a neutral grey with
   * the same near-plane-clamp technique as the axis guide. Null when none.
   */
  guideSegments: { a: Vec3; b: Vec3 }[] | null = null;

  /**
   * WORK-PLANE transform (local XY → world) the floor grid draws on while a
   * plane-handle move runs — the grid reorients onto the drag plane at the
   * gizmo. InputManager mirrors the active operator's workPlane() here; null
   * draws the normal world floor.
   */
  workPlane: Mat4 | null = null;

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

  /**
   * When set to a camera object's id, render() and pick() look THROUGH that
   * camera (Numpad0) instead of the OrbitCamera. Cleared automatically if the
   * object disappears or stops being a camera; InputManager also clears it when
   * the user orbits/pans/zooms. Public so e2e can drive it directly.
   */
  cameraViewId: number | null = null;

  /**
   * Camera-view zoom/pan (passepartout) while looking through a camera without
   * view-lock. Wheel scales `zoom`, Shift+MMB shifts `panX`/`panY` (NDC). Applied
   * to the frame projection here + the OrbitCamera (input) + the passepartout DOM,
   * so all three agree. Persists across enter/exit; only meaningful when
   * cameraViewId is set. Public so input + the overlay can read/write it.
   */
  camView: CamView = identityCamView();

  /** Matcap gallery textures by id ('studio' seeded below; images uploaded
   *  lazily on first selection). */
  private readonly matcapTextures = new Map<string, WebGLTexture>();
  /** Image-matcap URLs currently loading (dedupe guard). */
  private readonly matcapLoading = new Set<string>();

  constructor(private readonly ctx: GlContext) {
    const { gl, canvas } = ctx;
    this.matcapTextures.set('studio', createMatcapTexture(gl));
    this.meshPass = new MeshPass(gl, this.matcapTextures.get('studio')!);
    this.studioPass = new StudioPass(gl);
    this.texturedPass = new TexturedPass(gl);
    this.wirePass = new WirePass(gl);
    this.intersectPass = new IntersectPass(gl);
    this.gridPass = new GridPass(gl);
    this.outlinePass = new OutlinePass(gl, canvas.width, canvas.height);
    this.pickingPass = new PickingPass(gl, canvas.width, canvas.height);
    this.gizmoPass = new GizmoPass(gl);
    this.editOverlayPass = new EditOverlayPass(gl);
    this.curveEditPass = new CurveEditPass(gl);
    this.combPass = new CombPass(gl);
    this.surfaceNetPass = new SurfaceNetPass(gl);
    this.elementPickPass = new ElementPickPass(gl, canvas.width, canvas.height);
    this.renderedPass = new RenderedPass(gl);
    this.shadowPass = new ShadowPass(gl);
    this.aoPass = new AoPass(gl, canvas.width, canvas.height);
    this.glarePass = new GlarePass(gl, canvas.width, canvas.height);
    this.rayPresentPass = new RayPresentPass(gl);
    this.sdfAtlas = new SdfAtlas(gl);
    this.worldBgPass = new WorldBackgroundPass(gl);
    this.iconPass = new IconPass(gl);
    this.cameraFrustumPass = new CameraFrustumPass(gl);
    this.lightDirPass = new LightDirPass(gl);
    this.emptyAxesPass = new EmptyAxesPass(gl);
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
    const mesh = editing ? obj.mesh : obj.evaluatedMesh(scene.modifierContext(obj));
    const version = `${editing ? 'edit' : 'obj'}:${mesh.version}:${obj.modifiersVersion}:${obj.shadeSmooth ? 's' : 'f'}`;
    const cached = this.gpuMeshes.get(obj.id);
    if (cached && cached.version === version) return cached;
    cached?.triangles.dispose();
    cached?.edges.dispose();
    cached?.wireRibbon.dispose();

    const data = meshToRenderData(mesh, obj.shadeSmooth);
    let bounds: GpuMesh['bounds'] = null;
    const pos = data.trianglePositions;
    if (pos.length >= 3) {
      const min = [pos[0], pos[1], pos[2]];
      const max = [pos[0], pos[1], pos[2]];
      for (let i = 3; i < pos.length; i += 3) {
        for (let a = 0; a < 3; a++) {
          if (pos[i + a] < min[a]) min[a] = pos[i + a];
          if (pos[i + a] > max[a]) max[a] = pos[i + a];
        }
      }
      bounds = { min: new Vec3(min[0], min[1], min[2]), max: new Vec3(max[0], max[1], max[2]) };
    }
    const entry: GpuMesh = {
      triangles: new VertexArray(this.ctx.gl, [
        { location: 0, size: 3, data: data.trianglePositions },
        { location: 1, size: 3, data: data.triangleNormals },
        { location: 2, size: 3, data: data.triangleColors },
        { location: 3, size: 2, data: data.triangleUVs },
      ]),
      edges: new VertexArray(this.ctx.gl, [
        { location: 0, size: 3, data: data.edgePositions },
        { location: 1, size: 3, data: data.edgeFaceNormals1 },
        { location: 2, size: 3, data: data.edgeFaceNormals2 },
      ]),
      wireRibbon: (() => {
        const r = buildWireRibbon(data.edgePositions, {
          faceN1: data.edgeFaceNormals1,
          faceN2: data.edgeFaceNormals2,
        });
        return new VertexArray(this.ctx.gl, [
          { location: 0, size: 3, data: r.positions },
          { location: 1, size: 3, data: r.others },
          { location: 2, size: 2, data: r.params },
          { location: 3, size: 3, data: r.faceN1 },
          { location: 4, size: 3, data: r.faceN2 },
          { location: 5, size: 3, data: r.colors },
        ]);
      })(),
      version,
      bounds,
    };
    this.gpuMeshes.set(obj.id, entry);
    return entry;
  }

  /** Per-curve GPU buffers: the evaluated polyline as an anti-aliased ribbon
   *  (display, every mode) + a raw gl.LINES VAO (object select-through pick).
   *  Cached by the curve payload signature. */
  private readonly curveGpus = new Map<number, {
    version: string;
    ribbon: VertexArray;
    pickLines: VertexArray;
    segCount: number;
  }>();

  private curveGpu(obj: SceneObject): {
    version: string; ribbon: VertexArray; pickLines: VertexArray; segCount: number;
  } {
    const curve = obj.curve!;
    const version = JSON.stringify(curve);
    const cached = this.curveGpus.get(obj.id);
    if (cached && cached.version === version) return cached;
    cached?.ribbon.dispose();
    cached?.pickLines.dispose();

    const poly = evaluateCurve(curve);
    // Consecutive-point segments (6 floats each) for both the ribbon + pick lines.
    const segs = new Float32Array(Math.max(0, poly.length - 1) * 6);
    const linePos = new Float32Array(Math.max(0, poly.length - 1) * 6);
    for (let i = 1; i < poly.length; i++) {
      const o = (i - 1) * 6;
      segs[o] = poly[i - 1].x; segs[o + 1] = poly[i - 1].y; segs[o + 2] = poly[i - 1].z;
      segs[o + 3] = poly[i].x; segs[o + 4] = poly[i].y; segs[o + 5] = poly[i].z;
      linePos.set(segs.subarray(o, o + 6), o);
    }
    const r = buildWireRibbon(segs);
    const entry = {
      version,
      ribbon: new VertexArray(this.ctx.gl, [
        { location: 0, size: 3, data: r.positions },
        { location: 1, size: 3, data: r.others },
        { location: 2, size: 2, data: r.params },
        { location: 3, size: 3, data: r.faceN1 },
        { location: 4, size: 3, data: r.faceN2 },
        { location: 5, size: 3, data: r.colors },
      ]),
      pickLines: new VertexArray(this.ctx.gl, [{ location: 0, size: 3, data: linePos }]),
      segCount: Math.max(0, poly.length - 1),
    };
    this.curveGpus.set(obj.id, entry);
    return entry;
  }

  /** Viewport color for a curve object: selection orange (bright when active),
   *  otherwise the object's own display color. */
  private curveColor(scene: Scene, obj: SceneObject): Vec3 {
    if (scene.selection.has(obj.id)) {
      return scene.activeId === obj.id ? new Vec3(1, 0.82, 0.5) : new Vec3(0.82, 0.4, 0.12);
    }
    return new Vec3(obj.color[0], obj.color[1], obj.color[2]);
  }

  /**
   * Draw every visible curve object's evaluated polyline as an anti-aliased
   * ribbon, in EVERY shading mode (a curve has no faces/mesh, so this is the
   * only thing that draws it). Object color, selection tint when selected.
   */
  private drawCurves(scene: Scene, visible: SceneObject[], view: Mat4, proj: Mat4, refDist: number): void {
    // Curves whose modifier stack materializes a mesh (UR11-2 Pipe) draw as that
    // mesh in the solid pass — skip the polyline so it doesn't run down the
    // tube's core. Bare curves (empty evaluated mesh) still draw their polyline.
    const curves = visible.filter((o) => o.kind === 'curve' && o.curve && o.curve.points.length >= 2
      && o.evaluatedMesh(scene.modifierContext(o)).faces.size === 0);
    if (curves.length === 0) return;
    const { gl, canvas } = this.ctx;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    for (const obj of curves) {
      const g = this.curveGpu(obj);
      if (g.segCount === 0) continue;
      this.wirePass.begin(view, proj, 0.0006, false, canvas.width, canvas.height,
        refDist, this.curveColor(scene, obj), WIRE_MIN_PX, WIRE_MAX_PX);
      this.wirePass.setObject(scene.worldMatrix(obj), view);
      g.ribbon.draw(gl.TRIANGLES);
    }
    gl.disable(gl.BLEND);
  }

  /** Object-space triangle positions for an object's DISPLAYED mesh, cached by
   *  its gpuMesh version so intersection rebuilds only re-transform (below) and
   *  don't re-flatten the mesh every time. */
  private objectSpaceTris(obj: SceneObject, scene: Scene, version: string): Float32Array {
    const cached = this.cpuTriCache.get(obj.id);
    if (cached && cached.version === version) return cached.tris;
    const editing = scene.editMode?.objectId === obj.id;
    const mesh = editing ? obj.mesh : obj.evaluatedMesh(scene.modifierContext(obj));
    const tris = meshToRenderData(mesh, obj.shadeSmooth).trianglePositions;
    this.cpuTriCache.set(obj.id, { version, tris });
    return tris;
  }

  /**
   * Rebuild (throttled) the cached mesh-mesh intersection line VertexArray for
   * the given visible mesh objects. Key = every object's id + gpuMesh version +
   * world-matrix elements; unchanged key → keep the cache. On a real change,
   * transform each object's cached object-space triangles to WORLD space on the
   * CPU (so non-uniform scale is baked in — exactly what we want), then run
   * meshIntersectionSegments on every distinct pair whose world AABBs overlap
   * and upload the concatenated segments. Empty result → null (nothing drawn).
   * Self-intersection of a single mesh is out of scope (distinct pairs only).
   */
  private updateIntersectionLines(scene: Scene, meshes: SceneObject[]): void {
    let key = '';
    for (const obj of meshes) {
      const v = this.gpuMesh(obj, scene).version;
      key += `${obj.id}:${v}:${scene.worldMatrix(obj).m.join(',')};`;
    }
    if (key === this.intersectionKey) return;
    const now = performance.now();
    // Time-only throttle — do NOT condition on having lines: a heavy mesh
    // dragged around while intersecting nothing would otherwise re-run the
    // whole pair sweep every frame (null result = no cache = no throttle).
    if (now - this.intersectionBuiltAt < 150) return;
    this.intersectionKey = key;
    this.intersectionBuiltAt = now;

    // World-space triangles + world AABB per object.
    const worldTris: Float32Array[] = [];
    const aabbs: { min: Vec3; max: Vec3 }[] = [];
    for (const obj of meshes) {
      const version = this.gpuMesh(obj, scene).version;
      const src = this.objectSpaceTris(obj, scene, version);
      const world = scene.worldMatrix(obj);
      const dst = new Float32Array(src.length);
      let minx = Infinity, miny = Infinity, minz = Infinity;
      let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
      for (let i = 0; i < src.length; i += 3) {
        const p = world.transformPoint(new Vec3(src[i], src[i + 1], src[i + 2]));
        dst[i] = p.x; dst[i + 1] = p.y; dst[i + 2] = p.z;
        if (p.x < minx) minx = p.x; if (p.x > maxx) maxx = p.x;
        if (p.y < miny) miny = p.y; if (p.y > maxy) maxy = p.y;
        if (p.z < minz) minz = p.z; if (p.z > maxz) maxz = p.z;
      }
      worldTris.push(dst);
      aabbs.push({ min: new Vec3(minx, miny, minz), max: new Vec3(maxx, maxy, maxz) });
    }

    const segs: number[] = [];
    for (let i = 0; i < meshes.length; i++) {
      for (let j = i + 1; j < meshes.length; j++) {
        const a = aabbs[i], b = aabbs[j];
        if (a.min.x > b.max.x || a.max.x < b.min.x
          || a.min.y > b.max.y || a.max.y < b.min.y
          || a.min.z > b.max.z || a.max.z < b.min.z) continue;
        const pair = meshIntersectionSegments(worldTris[i], worldTris[j]);
        for (let k = 0; k < pair.length; k++) segs.push(pair[k]);
      }
    }

    this.intersectionLines?.dispose();
    if (segs.length) {
      // Screen-space ribbon stream (6 verts/segment) — see segmentsToRibbon:
      // a 1px gl.LINES hairline was invisible against the matcap greys the
      // intersection curve usually sits on.
      const ribbon = segmentsToRibbon(segs);
      this.intersectionLines = new VertexArray(this.ctx.gl, [
        { location: 0, size: 3, data: ribbon.positions },
        { location: 1, size: 3, data: ribbon.others },
        { location: 2, size: 2, data: ribbon.params },
      ]);
    } else {
      this.intersectionLines = null;
    }
  }

  /**
   * Keep the GL HDRI texture in sync with scene.world.hdri. Uploads the equirect
   * image (sRGB internal format → sampled as linear) the first time a new data
   * URL appears; clears the binding when the world drops HDRI. Async image
   * decode: until it lands, the background falls back to the gradient (hasHdri 0).
   */
  private syncHdriTexture(scene: Scene): void {
    const url = scene.world.mode === 'hdri' ? scene.world.hdri : null;
    if (url === this.hdriUrl) return;
    this.hdriUrl = url;
    this.hdriTexture = null; // fall back to gradient until the new image loads
    if (!url) return;
    const gl = this.ctx.gl;
    const img = new Image();
    img.onload = () => {
      // Ignore a stale load (world.hdri changed again before this resolved).
      if (this.hdriUrl !== url) return;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.hdriTexture = tex;
    };
    img.onerror = () => { /* keep the gradient fallback */ };
    img.src = url;
  }

  /**
   * Base-color image texture for an image material, uploaded lazily and cached by
   * material id (mirrors the HDRI upload). Returns null while the async decode is
   * in flight or for non-image materials — the RenderedPass then binds white.
   * A changed texDataUrl triggers a fresh upload; the old GL texture is deleted.
   */
  private materialTexture(mat: Material): WebGLTexture | null {
    if (mat.texKind !== 'image' || !mat.texDataUrl) return null;
    const url = mat.texDataUrl;
    const wantAlpha = mat.alphaBlend === true;
    const cached = this.matTextures.get(mat.id);
    // UR16-6: alphaBlend is detected asynchronously at decode (a plain PNG that
    // turns out to carry transparency flips false→true after this first upload),
    // so the cache must invalidate when the flag changes — otherwise the stale
    // opaque upload (alpha flattened to 1) keeps drawing transparent texels black.
    if (cached && cached.url === url && cached.alphaBlend === wantAlpha) return cached.tex;
    if (cached?.tex) this.ctx.gl.deleteTexture(cached.tex);
    const holder = { url, tex: null as WebGLTexture | null, alphaBlend: wantAlpha };
    this.matTextures.set(mat.id, holder);
    const img = new Image();
    img.onload = () => {
      if (holder.url !== mat.texDataUrl || holder.alphaBlend !== (mat.alphaBlend === true)) return; // stale
      holder.tex = this.uploadBaseColorTexture(img, wantAlpha);
    };
    img.onerror = () => { /* leave white fallback */ };
    img.src = url;
    return null;
  }

  /**
   * Upload a base-color image to a GL texture (SRGB8_ALPHA8, LINEAR, REPEAT).
   *
   * UR8-3: when `alphaBlend` is set the source may carry real transparency, and
   * uploading a transparent `<img>` DIRECTLY flattens its alpha to 1 on some
   * drivers (SwiftShader does — verified: texImage2D from an <img> loses the
   * alpha channel; from a raw ArrayBufferView it is preserved exactly). So for
   * alpha materials we round-trip the image through a 2D canvas → raw RGBA bytes
   * and upload those. sRGB decode still happens via the internal format either
   * way; opaque materials keep the faster direct `<img>` path.
   */
  private uploadBaseColorTexture(img: HTMLImageElement, alphaBlend: boolean): WebGLTexture {
    const gl = this.ctx.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    let uploaded = false;
    if (alphaBlend && typeof document !== 'undefined') {
      const w = img.naturalWidth, h = img.naturalHeight;
      const cnv = document.createElement('canvas');
      cnv.width = w; cnv.height = h;
      const cx = cnv.getContext('2d');
      if (cx) {
        cx.drawImage(img, 0, 0);
        const bytes = new Uint8Array(cx.getImageData(0, 0, w, h).data.buffer);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
        uploaded = true;
      }
    }
    if (!uploaded) gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    return tex;
  }

  /**
   * Await the base-color texture upload for an image material (UR7-1). Unlike the
   * lazy {@link materialTexture} (which returns null during the async decode and
   * pops the texture in on a later frame), this resolves only once the GL texture
   * matching the CURRENT texDataUrl is uploaded — so a synchronous render right
   * after shows the right pixels. Used by the animation renderer to make the
   * VIEWPORT engine deterministic for animated HTML planes. No-op (resolves) for
   * non-image materials or with no DOM.
   */
  async ensureMaterialTexture(mat: Material): Promise<void> {
    if (mat.texKind !== 'image' || !mat.texDataUrl) return;
    if (typeof Image === 'undefined') return;
    const url = mat.texDataUrl;
    const wantAlpha = mat.alphaBlend === true;
    const cached = this.matTextures.get(mat.id);
    if (cached && cached.url === url && cached.tex && cached.alphaBlend === wantAlpha) return; // already up to date
    const gl = this.ctx.gl;
    const img = new Image();
    const ok = await new Promise<boolean>((resolve) => {
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = url;
    });
    if (!ok || mat.texDataUrl !== url) return; // decode failed or superseded
    const prev = this.matTextures.get(mat.id);
    if (prev?.tex && (prev.url !== url || prev.alphaBlend !== wantAlpha)) gl.deleteTexture(prev.tex);
    const tex = this.uploadBaseColorTexture(img, wantAlpha);
    this.matTextures.set(mat.id, { url, tex, alphaBlend: wantAlpha });
  }

  /**
   * P13 map-slot upload: data URL → GL texture, cached by URL. Returns null
   * while the async decode is in flight (caller binds a neutral fallback).
   * `srgb` = false uploads LINEAR (normal/rough/metal maps are data, not
   * color); true mirrors the base-color path. Cache is URL-keyed and never
   * evicted — packed data URLs are few and shared across materials.
   */
  private textureFor(url: string | null, srgb: boolean): WebGLTexture | null {
    if (!url) return null;
    const key = (srgb ? 's:' : 'l:') + url;
    const cached = this.urlTextures.get(key);
    if (cached) return cached.tex;
    const holder = { tex: null as WebGLTexture | null };
    this.urlTextures.set(key, holder);
    const gl = this.ctx.gl;
    const img = new Image();
    img.onload = () => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      holder.tex = tex;
    };
    img.onerror = () => { /* leave null → feature stays off */ };
    img.src = url;
    return null;
  }

  /**
   * Render this frame's shadow maps (Rendered mode only): every sun and spot
   * (up to SHADOW_SLOTS, scene order) gets one depth-only render of the
   * visible meshes — suns through an ortho box fitted around the world-space
   * bounds, spots through a perspective frustum matching their cone. Returns
   * casters[slot] = { light-space matrix, light index } for the RenderedPass;
   * empty when there is nothing to cast or no shadowing light. Fixed 1024²
   * maps, redrawn per frame — cheap depth-only rasterization.
   */
  private renderShadows(
    scene: Scene,
    meshes: SceneObject[],
    lights: LightSet,
  ): {
    casters: { viewProj: Mat4; lightIndex: number }[];
    cubeCasters: { lightIndex: number; near: number; far: number }[];
  } {
    const casterIdx = shadowCasterIndices(lights, SHADOW_SLOTS);
    const cubeIdx = cubeCasterIndices(lights, CUBE_SHADOW_SLOTS);
    if ((casterIdx.length === 0 && cubeIdx.length === 0) || meshes.length === 0) {
      return { casters: [], cubeCasters: [] };
    }

    // World-space AABB of everything that will cast/receive: transform each
    // mesh's cached local AABB corners by its world matrix.
    let min: Vec3 | null = null;
    let max: Vec3 | null = null;
    for (const obj of meshes) {
      const b = this.gpuMesh(obj, scene).bounds;
      if (!b) continue;
      const world = scene.worldMatrix(obj);
      for (let c = 0; c < 8; c++) {
        const p = world.transformPoint(new Vec3(
          c & 1 ? b.max.x : b.min.x,
          c & 2 ? b.max.y : b.min.y,
          c & 4 ? b.max.z : b.min.z,
        ));
        min = min ? new Vec3(Math.min(min.x, p.x), Math.min(min.y, p.y), Math.min(min.z, p.z)) : p;
        max = max ? new Vec3(Math.max(max.x, p.x), Math.max(max.y, p.y), Math.max(max.z, p.z)) : p;
      }
    }
    if (!min || !max) return { casters: [], cubeCasters: [] };
    const center = min.add(max).scale(0.5);
    const radius = max.sub(min).length() * 0.5;

    const { gl, canvas } = this.ctx;
    const casters: { viewProj: Mat4; lightIndex: number }[] = [];
    for (const lightIndex of casterIdx) {
      const dir = new Vec3(
        lights.directions[lightIndex * 3],
        lights.directions[lightIndex * 3 + 1],
        lights.directions[lightIndex * 3 + 2],
      ).normalize();
      let viewProj: Mat4;
      if (lights.types[lightIndex] === 1) {
        viewProj = sunShadowMatrix(dir, center, radius);
      } else {
        const pos = new Vec3(
          lights.positions[lightIndex * 3],
          lights.positions[lightIndex * 3 + 1],
          lights.positions[lightIndex * 3 + 2],
        );
        // Full apex angle back from the stored cos(outer half-angle).
        const spotAngle = 2 * Math.acos(Math.min(1, Math.max(-1, lights.spots[lightIndex * 2 + 1])));
        const far = pos.distanceTo(center) + radius * 1.5;
        viewProj = spotShadowMatrix(pos, dir, spotAngle, far);
      }
      this.shadowPass.begin(casters.length, viewProj);
      for (const obj of meshes) {
        this.shadowPass.setObject(scene.worldMatrix(obj));
        this.gpuMesh(obj, scene).triangles.draw(gl.TRIANGLES);
      }
      casters.push({ viewProj, lightIndex });
    }

    // Point lights: 6 depth renders into the slot's cube map (90° fov faces).
    const cubeCasters: { lightIndex: number; near: number; far: number }[] = [];
    for (const lightIndex of cubeIdx) {
      const pos = new Vec3(
        lights.positions[lightIndex * 3],
        lights.positions[lightIndex * 3 + 1],
        lights.positions[lightIndex * 3 + 2],
      );
      const near = 0.05;
      const far = Math.max(pos.distanceTo(center) + radius * 1.5, 1);
      const proj = Mat4.perspective(Math.PI / 2, 1, near, far);
      for (let face = 0; face < 6; face++) {
        this.shadowPass.beginCubeFace(cubeCasters.length, face, proj.mul(cubeFaceView(pos, face)));
        for (const obj of meshes) {
          this.shadowPass.setObject(scene.worldMatrix(obj));
          this.gpuMesh(obj, scene).triangles.draw(gl.TRIANGLES);
        }
      }
      cubeCasters.push({ lightIndex, near, far });
    }
    this.shadowPass.end(canvas.width, canvas.height);
    return { casters, cubeCasters };
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

  /**
   * The view/proj (plus eye + fovY, for lighting, grid fade and gizmo scale)
   * this frame uses: the active camera object when looking through one
   * (cameraViewId), otherwise the OrbitCamera. Self-heals a stale cameraViewId
   * (object gone or no longer a camera). Called by both render() and pick() so
   * everything downstream — picking, gizmo, edit overlays — agrees.
   */
  private resolveView(
    scene: Scene,
    camera: OrbitCamera,
  ): { view: Mat4; proj: Mat4; eye: Vec3; fovY: number } {
    const { canvas } = this.ctx;
    const aspect = canvas.width / canvas.height;
    if (this.cameraViewId !== null) {
      const camObj = scene.get(this.cameraViewId);
      if (!camObj || camObj.kind !== 'camera') {
        this.cameraViewId = null; // object gone: fall through to the user camera
      } else if (camObj.visible && camObj.camera) {
        // Central world matrix (UR5-7): applies Look At orientation when set, so
        // the through-camera view, tracer and frustum all agree.
        const world = scene.cameraWorldMatrix(camObj);
        // Letterbox the projection to the scene's OUTPUT resolution (UR5-5): the
        // camera FOV maps to the render frame, not the canvas, and the image is
        // framed inside the passepartout rect — what you see inside the frame is
        // what F12 renders.
        const rs = scene.renderSettings;
        return {
          view: world.invert(),
          // Camera-view zoom/pan (passepartout) rides on the letterboxed frame
          // projection; the OrbitCamera applies the SAME transform so input agrees.
          proj: applyCamView(cameraFrameProjMatrix(camObj.camera, rs.width, rs.height, canvas.width, canvas.height), this.camView),
          eye: scene.worldTransformOf(camObj).position,
          fovY: cameraFovY(camObj.camera),
        };
      }
    }
    return {
      view: camera.viewMatrix(),
      proj: camera.projMatrix(aspect),
      eye: camera.eye,
      fovY: camera.fovY,
    };
  }

  /**
   * Camera Glare (UR10-2 Part B): the glare settings of the camera we are looking
   * THROUGH, or null. Glare is a CAMERA property — it applies only through-camera
   * (cameraViewId set), never during free navigation. Requires the HDR capture
   * target to be available on this GL context.
   */
  /** e2e/debug: whether the through-camera glare GL pass can run on this context
   *  (needs a float-renderable HDR capture target — false on SwiftShader). */
  get glareAvailable(): boolean {
    return this.glarePass.available;
  }

  private viewportGlare(scene: Scene): GlareSettings | null {
    if (!this.glarePass.available || this.cameraViewId === null) return null;
    const cam = scene.get(this.cameraViewId);
    const g = cam && cam.kind === 'camera' ? cam.camera?.glare : undefined;
    return g && g.enabled ? g : null;
  }

  /** UR8-3: is this a mesh whose material shows its texture in every solid mode?
   *  (mesh/surface/curve — every material-carrying kind, see kindHasMaterial.) */
  private isAlwaysTextured(obj: SceneObject, scene: Scene): boolean {
    return kindHasMaterial(obj.kind) && scene.materialOf(obj).alwaysTextured === true;
  }

  /** UR8-3: is this a mesh whose material alpha-blends (transparent cutout)? */
  private isAlphaBlend(obj: SceneObject, scene: Scene): boolean {
    return kindHasMaterial(obj.kind) && scene.materialOf(obj).alphaBlend === true;
  }

  /** UR10-3: is this a mesh whose material transmits (glass)? Drawn Cook-Torrance
   *  but alpha-blended with a Fresnel rim (the RenderedPass glass approximation). */
  private isGlass(obj: SceneObject, scene: Scene): boolean {
    return kindHasMaterial(obj.kind) && (scene.materialOf(obj).transmission ?? 0) > 0
      && scene.materialOf(obj).alphaBlend !== true;
  }

  /** UR16-1: is this a LIT mesh whose material ALPHA channel makes it partly
   *  transparent (value < 1, or a gradient/image alpha)? Drawn lit (RenderedPass)
   *  in the same blended pass as glass — distinct from the shadeless alphaBlend
   *  cutout planes. Excludes glass/alphaBlend (handled by their own predicates). */
  private isBlendedAlpha(obj: SceneObject, scene: Scene): boolean {
    if (!kindHasMaterial(obj.kind)) return false;
    const mat = scene.materialOf(obj);
    if (mat.alphaBlend === true) return false;
    if ((mat.transmission ?? 0) > 0) return false;
    const a = mat.alpha;
    return !!a && ((a.kind === 'value' && a.value < 1) || a.kind === 'gradient' || a.kind === 'image');
  }

  /** Sort objects back-to-front by their origin's view-space depth (camera looks
   *  down -Z, so farther = more negative → ascending z draws far first). */
  private sortBackToFront(scene: Scene, objs: SceneObject[], view: Mat4): SceneObject[] {
    return objs
      .map((o) => ({ o, z: view.transformPoint(scene.worldTransformOf(o).position).z }))
      .sort((a, b) => a.z - b.z)
      .map((e) => e.o);
  }

  /**
   * UR8-3 — draw the SHADELESS TEXTURED objects `objs` via the TexturedPass:
   * opaque always-textured first (normal depth), then alphaBlend ones LAST in a
   * blended pass, back-to-front, depth-test ON but depth-WRITE OFF. Used for the
   * always-textured draw in matcap/studio/wireframe AND the alpha second pass in
   * Rendered mode.
   */
  private drawTexturedObjects(scene: Scene, objs: SceneObject[], view: Mat4, proj: Mat4, aoTex: WebGLTexture): void {
    if (objs.length === 0) return;
    const { gl, canvas } = this.ctx;
    const opaque = objs.filter((o) => !this.isAlphaBlend(o, scene));
    const blended = this.sortBackToFront(scene, objs.filter((o) => this.isAlphaBlend(o, scene)), view);
    this.texturedPass.begin(view, proj, aoTex, canvas.width, canvas.height);
    for (const obj of opaque) {
      const mat = scene.materialOf(obj);
      this.texturedPass.setObject(scene.worldMatrix(obj), mat, this.materialTexture(mat), false);
      this.gpuMesh(obj, scene).triangles.draw(gl.TRIANGLES);
    }
    if (blended.length > 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      for (const obj of blended) {
        const mat = scene.materialOf(obj);
        this.texturedPass.setObject(scene.worldMatrix(obj), mat, this.materialTexture(mat), true);
        this.gpuMesh(obj, scene).triangles.draw(gl.TRIANGLES);
      }
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
  }

  /**
   * Keep MeshPass sampling the matcap selected in shadePrefs (the gallery).
   * Image matcaps upload lazily on first selection; while one is still
   * loading the previous texture keeps drawing (a one-frame-later pop-in,
   * never a black flash). Unknown ids resolve to Studio.
   */
  private syncMatcap(): void {
    const entry = matcapById(shadePrefs.matcap);
    const cached = this.matcapTextures.get(entry.id);
    if (cached) {
      this.meshPass.setMatcap(cached, entry.gain);
      return;
    }
    if (!entry.url || this.matcapLoading.has(entry.id)) return;
    this.matcapLoading.add(entry.id);
    const img = new Image();
    img.onload = () => {
      const { gl } = this.ctx;
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      // Same orientation convention as the procedural canvas upload (no flip).
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.matcapTextures.set(entry.id, tex);
      this.matcapLoading.delete(entry.id);
    };
    img.onerror = () => this.matcapLoading.delete(entry.id);
    img.src = entry.url;
  }

  render(scene: Scene, camera: OrbitCamera): void {
    const { gl, canvas } = this.ctx;
    this.syncMatcap();
    if (this.ctx.syncSize()) {
      this.outlinePass.resize(canvas.width, canvas.height);
      this.pickingPass.resize(canvas.width, canvas.height);
      this.elementPickPass.resize(canvas.width, canvas.height);
      this.aoPass.resize(canvas.width, canvas.height);
      this.glarePass.resize(canvas.width, canvas.height);
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    const bg = themeViewport.background;
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const { view, proj, eye, fovY } = this.resolveView(scene, camera);
    // Object-type visibility (viewport-header dropdown): a hidden type is not
    // drawn (and, in pick(), not selectable either).
    const visible = scene.objects.filter((o) => scene.effectiveVisible(o) && typeShown(o.kind));

    // UR15-1: Rendered → Raytraced. The progressive path tracer accumulates into a
    // fullscreen textured quad instead of the rasterized RenderedPass. Any other
    // mode (or Rendered → Live, the default) keeps the driver inactive so it never
    // ghosts on re-entry (the mode-switch reset trigger).
    const rayMode = this.shadingMode === 'rendered' && shadePrefs.renderedMode === 'ray';
    if (!rayMode) this.viewportRay.markInactive();

    // Camera Glare (UR10-2 Part B): in Rendered LIVE mode through a glare-enabled
    // camera the whole frame is rendered into an HDR capture target (so emissive
    // surfaces keep their >1 values), then bright-pass + blurred + composited to
    // the canvas at the end. null → straight-to-canvas (byte-identical). In Ray
    // mode glare is applied in the tracer's tonemap seam instead (like F12).
    const glare = (this.shadingMode === 'rendered' && !rayMode) ? this.viewportGlare(scene) : null;

    // SSAO (shading-dropdown "Ambient Occlusion", solid modes only): depth
    // prepass of the visible meshes, then SSAO+blur into aoPass.texture. The
    // solid passes below multiply it in; when off they bind the 1×1 white.
    // Cavity (UR13-1, Blender viewport curvature) shares AO's depth+normal
    // prepass. It works in the solid modes AND in wireframe HIDDEN-LINE mode
    // (the depth prime gives the wires a surface to read); classic see-through
    // wireframe has no primed surface, so cavity is skipped there. The prepass
    // must run when EITHER AO or cavity needs it (generalized from the old
    // ao-only gate).
    // AO/cavity are raster-solid-pass effects; the ray tracer has its own GI, so
    // they're skipped entirely in ray mode (rayMode short-circuits the prepass).
    const solidMode = this.shadingMode !== 'wireframe';
    const aoOn = shadePrefs.ao && solidMode && !rayMode;
    const cavityOn = shadePrefs.cavity
      && (solidMode || shadePrefs.hiddenLine.wireframe) && !rayMode;
    if (aoOn || cavityOn) {
      this.aoPass.beginDepth(view, proj);
      const aoMeshes: SceneObject[] = [];
      for (const obj of visible) {
        if (obj.kind !== 'mesh' && obj.kind !== 'surface') continue; // NB-CORE: surfaces occlude like meshes
        // UR8-3 B: alphaBlend cutouts DON'T occlude — a floating transparent
        // plane must not sink AO into the surfaces behind it. UR10-3: glass is
        // transparent too, so it doesn't sink AO either.
        if (this.isAlphaBlend(obj, scene)) continue;
        if (this.isGlass(obj, scene)) continue;
        aoMeshes.push(obj);
        this.aoPass.setObject(scene.worldMatrix(obj), view);
        this.gpuMesh(obj, scene).triangles.draw(gl.TRIANGLES);
      }
      if (aoOn) {
        if (shadePrefs.aoMode === 'object') {
          // Object AO (Ray's SDF technique): voxel-SDF atlas in sync with the
          // visible meshes, then the world-space march instead of GTAO.
          const sdf = this.sdfAtlas.sync(scene, aoMeshes);
          this.aoPass.computeObject(proj.invert(), view.invert(), sdf,
            shadePrefs.aoRadius, shadePrefs.aoStrength, shadePrefs.aoSamples, shadePrefs.aoMethod);
        } else {
          this.aoPass.compute(proj, proj.invert(), shadePrefs.aoRadius, shadePrefs.aoStrength, shadePrefs.aoSamples);
        }
      }
    }
    // Factor texture the shaded passes multiply: AO alone, or AO·cavity folded
    // (computeCavity composes the two into ONE full-res factor), or 1×1 white.
    let aoTex = aoOn ? this.aoPass.texture : this.aoPass.white;
    let cavityTex: WebGLTexture | null = null;
    if (cavityOn) {
      this.aoPass.computeCavity(proj.invert(), aoOn ? this.aoPass.texture : null,
        shadePrefs.cavityRidge, shadePrefs.cavityValley);
      cavityTex = this.aoPass.cavityTexture;
      // Solid modes multiply the composed factor as their AO texture; wireframe
      // hidden-line reads it in the wire fragment (below) instead.
      if (solidMode) aoTex = cavityTex;
    }

    // While an object is in edit mode its EDGE lines are skipped in every
    // wirePass draw below — the edit cage IS its wireframe (Blender's model),
    // and letting wirePass also draw those grey edges made them depth-fight the
    // orange cage and cover it. Its TRIANGLES still draw (depth prime / solid
    // fill) so it occludes other objects normally. -1 = nothing being edited.
    const editSkipId = scene.editObject?.id ?? -1;
    const hiddenLine = shadePrefs.hiddenLine[this.shadingMode];
    // Wire look from prefs (UR9-1): color + ribbon clamp bounds. Proximity off
    // → both bounds = wireMaxPx so every edge draws at a constant width.
    const wireColor = new Vec3(shadePrefs.wireColor[0], shadePrefs.wireColor[1], shadePrefs.wireColor[2]);
    const wireMinPx = shadePrefs.wireProximity ? shadePrefs.wireMinPx : shadePrefs.wireMaxPx;
    const wireMaxPx = shadePrefs.wireMaxPx;

    // Solid pass — branch on shading mode. Wireframe draws dark edge lines with
    // no fill; matcap/studio fill triangles with their respective shaders.
    // UR8-3 C: always-textured meshes draw their texture in matcap/studio/
    // wireframe via the shadeless TexturedPass (part B blends the alpha ones).
    const texturedObjs = this.shadingMode !== 'rendered'
      ? visible.filter((o) => this.isAlwaysTextured(o, scene))
      : [];
    const texturedSet = new Set(texturedObjs);

    if (rayMode) {
      // UR15-1: advance the accumulation, present it fullscreen (LINEAR-upscaled
      // while degraded), then prime the depth buffer with real geometry so the
      // overlays below (grid/outline/cage/gizmo/guides) depth-test over the image.
      this.renderRaytraced(scene, camera, view, proj, eye, fovY, visible);
    } else if (this.shadingMode === 'wireframe') {
      // UR8-3 C: textured fill FIRST (depth on), wires drawn on top afterwards.
      this.drawTexturedObjects(scene, texturedObjs, view, proj, aoTex);
      // Hidden-line option: prime the depth buffer with the solid faces
      // (color untouched) so backfacing wires and wires behind other geometry
      // fail the depth test; the biased lines then only survive where visible.
      if (hiddenLine) {
        const viewProj = proj.mul(view);
        this.wirePass.beginPrime();
        gl.colorMask(false, false, false, false);
        for (const obj of visible) {
          this.wirePass.primeObject(viewProj.mul(scene.worldMatrix(obj)));
          this.gpuMesh(obj, scene).triangles.draw(gl.TRIANGLES);
        }
        gl.colorMask(true, true, true, true);
      }
      // Anti-aliased ribbons (UR6-1), blended for the soft AA rim. In hidden-
      // line mode the wires sample the cavity factor (UR13-1) so ridges brighten
      // and valley/crease edges darken; see-through wireframe passes null.
      this.wirePass.begin(view, proj, hiddenLine ? 0.002 : 0, hiddenLine,
        canvas.width, canvas.height, camera.distance, wireColor, wireMinPx, wireMaxPx,
        cavityTex ? { texture: cavityTex, width: canvas.width, height: canvas.height } : null);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      for (const obj of visible) {
        if (obj.id === editSkipId) continue; // cage draws its wireframe
        this.wirePass.setObject(scene.worldMatrix(obj), view);
        this.gpuMesh(obj, scene).wireRibbon.draw(gl.TRIANGLES);
      }
      gl.disable(gl.BLEND);
    } else if (this.shadingMode === 'studio') {
      gl.disable(gl.CULL_FACE); // two-sided solid shading (see matcap branch)
      this.studioPass.begin(view, proj, aoTex, canvas.width, canvas.height);
      for (const obj of visible) {
        if (texturedSet.has(obj)) continue; // drawn shadeless-textured below
        this.studioPass.setObject(scene.worldMatrix(obj), view, obj.color);
        this.gpuMesh(obj, scene).triangles.draw(gl.TRIANGLES);
      }
      gl.enable(gl.CULL_FACE);
      this.drawTexturedObjects(scene, texturedObjs, view, proj, aoTex);
    } else if (this.shadingMode === 'rendered') {
      // World environment as the backdrop (flat / gradient / HDRI), then the
      // meshes over it. Other shading modes keep the theme clear color.
      this.syncHdriTexture(scene);
      // Mesh objects + NURBS surfaces (NB-CORE: tessellation IS the mesh) +
      // curve objects that materialize a tube (UR11-2 Pipe).
      const meshes = visible.filter((o) => o.kind === 'mesh' || o.kind === 'surface'
        || (o.kind === 'curve' && o.evaluatedMesh(scene.modifierContext(o)).faces.size > 0));
      // UR8-3 B: alphaBlend cutouts draw in a blended SECOND pass and DON'T cast
      // shadows (a floating cutout casting a full quad shadow looks broken).
      // UR10-3: glass (transmission > 0) draws in a blended pass like alphaBlend,
      // but through the RenderedPass (Cook-Torrance + Fresnel-rim glass alpha),
      // NOT the shadeless TexturedPass. It doesn't cast shadow maps either.
      const opaqueMeshes = meshes.filter((o) => !this.isAlphaBlend(o, scene) && !this.isGlass(o, scene) && !this.isBlendedAlpha(o, scene));
      // Glass + UR16-1 half-alpha lit meshes share one back-to-front blended pass.
      const glassMeshes = this.sortBackToFront(scene, meshes.filter((o) => this.isGlass(o, scene) || this.isBlendedAlpha(o, scene)), view);
      const alphaMeshes = meshes.filter((o) => this.isAlphaBlend(o, scene));
      const lights = collectLights(scene);
      const { casters, cubeCasters } = this.renderShadows(scene, opaqueMeshes, lights);
      // Glare (UR10-2 B): redirect the frame into the HDR capture target. The AO
      // and shadow passes above bind their own FBOs (and end on the default), so
      // this must happen AFTER them; a fresh clear matches the canvas path.
      if (glare) {
        this.glarePass.capture.bind();
        gl.clearColor(bg[0], bg[1], bg[2], 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      }
      const invViewProj = proj.mul(view).invert();
      this.worldBgPass.render(invViewProj, eye, scene.world, this.hdriTexture);
      const amb = averageWorldColor(scene.world);
      const k = scene.world.strength * 0.3;
      this.renderedPass.begin(view, proj, eye, lights,
        new Vec3(amb[0] * k, amb[1] * k, amb[2] * k), this.shadowPass.textures, casters,
        this.shadowPass.cubeTextures, cubeCasters, aoTex, canvas.width, canvas.height);
      gl.disable(gl.CULL_FACE); // two-sided solid shading (see matcap branch)
      for (const obj of opaqueMeshes) {
        const mat = scene.materialOf(obj);
        // P14 shader nodes: bake the graph (idempotent per version) and view
        // the material THROUGH the bake — texture slots point at the baked
        // maps, scalars forced to 1 so the map-multiply becomes replacement.
        let effMat = mat;
        if (mat.useNodes && mat.nodeGraph) {
          ensureBaked(mat, nodeImageCache(),
            () => obj.evaluatedMesh(scene.modifierContext(obj)));
          if (mat.baked) {
            effMat = {
              ...mat,
              baseColor: [1, 1, 1],
              roughness: 1,
              metallic: 1,
              texKind: 'image',
              texDataUrl: mat.baked.baseUrl,
              roughDataUrl: mat.baked.roughUrl,
              metalDataUrl: mat.baked.metalUrl,
            };
          }
        }
        this.renderedPass.setObject(scene.worldMatrix(obj), effMat);
        this.renderedPass.bindTexture(
          effMat === mat ? this.materialTexture(mat) : this.textureFor(effMat.texDataUrl, true),
        );
        this.renderedPass.bindMaps(
          effMat,
          this.textureFor(effMat.normalDataUrl, false),
          this.textureFor(effMat.roughDataUrl, false),
          this.textureFor(effMat.metalDataUrl, false),
        );
        this.gpuMesh(obj, scene).triangles.draw(gl.TRIANGLES);
      }
      gl.enable(gl.CULL_FACE); // restore before the glass/alpha passes
      // UR10-3: glass meshes over the opaque result — same RenderedPass shader
      // (so lighting/nodes/maps all apply), blended back-to-front with depth-test
      // ON, depth-WRITE OFF so multiple glass surfaces layer correctly.
      if (glassMeshes.length > 0) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        for (const obj of glassMeshes) {
          const mat = scene.materialOf(obj);
          this.renderedPass.setObject(scene.worldMatrix(obj), mat);
          this.renderedPass.bindTexture(this.materialTexture(mat));
          this.renderedPass.bindMaps(
            mat,
            this.textureFor(mat.normalDataUrl, false),
            this.textureFor(mat.roughDataUrl, false),
            this.textureFor(mat.metalDataUrl, false),
          );
          this.gpuMesh(obj, scene).triangles.draw(gl.TRIANGLES);
        }
        gl.depthMask(true);
        gl.disable(gl.BLEND);
      }
      // UR8-3 B: alphaBlend planes over the opaque result, blended back-to-front
      // (shadeless textured — transparent HTML/image cutouts are emit planes).
      this.drawTexturedObjects(scene, alphaMeshes, view, proj, aoTex);
    } else {
      // Two-sided solid shading: draw backfaces too (the shader flips the normal
      // for them) so flat/open geometry — e.g. a Plane rotated past edge-on —
      // stays visible instead of appearing to "stop" when its front turns away.
      gl.disable(gl.CULL_FACE);
      this.meshPass.begin(view, proj, aoTex, canvas.width, canvas.height);
      for (const obj of visible) {
        if (texturedSet.has(obj)) continue; // drawn shadeless-textured below
        this.meshPass.setObject(scene.worldMatrix(obj), view, obj.color);
        this.gpuMesh(obj, scene).triangles.draw(gl.TRIANGLES);
      }
      gl.enable(gl.CULL_FACE);
      this.drawTexturedObjects(scene, texturedObjs, view, proj, aoTex);
    }

    // Wireframe overlay (shading-dropdown option): the edge wires drawn over
    // the shaded result. Hidden Line ON (per mode): depth-tested against the
    // solid pass's depth buffer with a small bias + backface cull so only
    // visible wires survive. Hidden Line OFF: depth test disabled so the FULL
    // wireframe shows through the geometry ("so I can see the full mesh").
    // The edit object's edges are skipped either way (its cage is its wire).
    if (shadePrefs.wireOverlay && this.shadingMode !== 'wireframe') {
      if (hiddenLine) {
        this.wirePass.begin(view, proj, 0.002, true,
          canvas.width, canvas.height, camera.distance, wireColor, wireMinPx, wireMaxPx);
      } else {
        gl.disable(gl.DEPTH_TEST);
        this.wirePass.begin(view, proj, 0, false,
          canvas.width, canvas.height, camera.distance, wireColor, wireMinPx, wireMaxPx);
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      for (const obj of visible) {
        if (obj.id === editSkipId) continue;
        this.wirePass.setObject(scene.worldMatrix(obj), view);
        this.gpuMesh(obj, scene).wireRibbon.draw(gl.TRIANGLES);
      }
      gl.disable(gl.BLEND);
      if (!hiddenLine) gl.enable(gl.DEPTH_TEST);
    }

    // Mesh-mesh intersection curves (shading-dropdown "Intersections" option):
    // light grey lines where two objects' geometry passes through each other.
    // Drawn AFTER the solid pass and the wire overlay, in EVERY shading mode
    // (incl. wireframe), with a slightly stronger bias than the wire overlay so
    // the line wins against both surfaces and their wires. Depth test stays on.
    if (shadePrefs.intersections) {
      this.updateIntersectionLines(scene, visible.filter((o) => o.kind === 'mesh'));
      if (this.intersectionLines) {
        // Blended for the ribbon's anti-aliased edges (grid-pass pattern);
        // depth writes off so the soft rim can't shadow later overlays.
        this.intersectPass.begin(view, proj, 0.004, canvas.width, canvas.height,
          new Vec3(shadePrefs.intersectColor[0], shadePrefs.intersectColor[1], shadePrefs.intersectColor[2]));
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        this.intersectionLines.draw(gl.TRIANGLES);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
      }
    }

    // Curve objects (UR11-1): evaluated polylines drawn as anti-aliased ribbons
    // in EVERY shading mode (a curve has no mesh, so this is its only geometry).
    // After the solid/wire passes, before the grid so curves sit over surfaces.
    this.drawCurves(scene, visible, view, proj, camera.distance);

    // Curvature combs (NB-B1): per-curve porcupine overlay for curves whose
    // comb pref is ON. Drawn right after the curve ribbons, world-space, depth
    // test on + blended (an APP-level display pref — see combPrefs.ts).
    this.combPass.render(scene, visible, view, proj);

    // Grid (blended, after opaque) — Overlays › Grid toggles it (P12-2). Colors,
    // fade and the floor-lines toggle come from overlay prefs; workPlane (set
    // while a plane-handle move runs) reorients the grid onto the drag plane.
    if (overlays.grid) {
      this.gridPass.render(view, proj, eye, {
        gridColor: new Vec3(overlays.gridColor[0], overlays.gridColor[1], overlays.gridColor[2]),
        axisXColor: new Vec3(overlays.axisX[0], overlays.axisX[1], overlays.axisX[2]),
        axisYColor: new Vec3(overlays.axisY[0], overlays.axisY[1], overlays.axisY[2]),
        fade: overlays.gridFade,
        floor: overlays.floor,
        plane: this.workPlane ?? undefined,
      });
    }

    // Camera frustums — after the grid, before outlines. Skip the camera we are
    // currently looking through (its wireframe would smear across the whole view).
    const frustums = visible.filter((o) => overlays.frustums && o.kind === 'camera' && o.id !== this.cameraViewId);
    if (frustums.length > 0) {
      const viewProj = proj.mul(view);
      this.cameraFrustumPass.begin();
      for (const obj of frustums) {
        this.cameraFrustumPass.draw(viewProj, obj, selectionColor(scene, obj), scene.cameraWorldMatrix(obj));
      }
    }

    // Aim arrows for directional lights (sun/spot) — rides the icons toggle,
    // same selection tint as the icon so they read as one object.
    const aimed = visible.filter((o) => overlays.icons && hasAimArrow(o));
    if (aimed.length > 0) {
      const viewProj = proj.mul(view);
      this.lightDirPass.begin();
      for (const obj of aimed) {
        const pose = scene.worldTransformOf(obj);
        const col = selectionColor(scene, obj);
        this.lightDirPass.draw(viewProj, pose, col);
        // Area lights (UR10-1) also get their emitting rectangle outline drawn
        // in the light's local XY plane at width×height.
        if (obj.light?.type === 'area') {
          this.lightDirPass.drawRect(viewProj, pose, obj.light.width ?? 1, obj.light.height ?? 1, col);
        }
      }
    }

    // Plain-axes display for empties (UR5-7) — rides the icons toggle, same
    // selection tint as light/camera glyphs. Drawn instead of a billboard.
    const empties = visible.filter((o) => overlays.icons && o.kind === 'empty' && o.empty);
    if (empties.length > 0) {
      const viewProj = proj.mul(view);
      this.emptyAxesPass.begin();
      for (const obj of empties) {
        this.emptyAxesPass.draw(viewProj, scene.worldTransformOf(obj).position, obj.empty!.displaySize, selectionColor(scene, obj));
      }
    }

    // Billboard icons for lights + cameras. The looked-through camera has no icon
    // (it is the viewpoint); empties draw axes above, not a billboard.
    const icons = visible.filter((o) => overlays.icons && (o.kind === 'light' || o.kind === 'camera') && o.id !== this.cameraViewId);
    if (icons.length > 0) {
      this.iconPass.begin(proj.mul(view), canvas.width, canvas.height);
      for (const obj of icons) {
        this.iconPass.draw(scene.worldTransformOf(obj).position, iconShape(obj), selectionColor(scene, obj));
      }
    }

    // Selection outlines — the object being edited gets the cage, not an outline
    const editObj = scene.editObject;
    const selected = visible.filter((o) => scene.selection.has(o.id) && o !== editObj);
    if (selected.length > 0) {
      const viewProj = proj.mul(view);
      this.outlinePass.beginMask();
      for (const obj of selected) {
        this.outlinePass.maskObject(viewProj.mul(scene.worldMatrix(obj)));
        this.gpuMesh(obj, scene).triangles.draw(gl.TRIANGLES);
      }
      this.outlinePass.endMask(canvas.width, canvas.height);
      // endMask unbinds to the default framebuffer — restore the glare capture so
      // the outline edges (and the gizmo/guides below) land in the HDR target.
      if (glare) this.glarePass.capture.bind();
      this.outlinePass.renderEdges();
    }

    // Edit-mode cage (verts/edges/selected-face fill). Hidden Line OFF for the
    // current mode → draw the cage with the depth test disabled so the full
    // orange cage (incl. back-side edges) is always visible through geometry.
    if (editObj && scene.effectiveVisible(editObj) && scene.editMode) {
      const modelView = view.mul(scene.worldMatrix(editObj));
      if (!hiddenLine) gl.disable(gl.DEPTH_TEST);
      this.editOverlayPass.render(modelView, proj, editObj.mesh, scene.editMode,
        canvas.width, canvas.height, camera.distance);
      if (this.editPreviewLines) this.editOverlayPass.renderPreview(modelView, proj, this.editPreviewLines);
      if (!hiddenLine) gl.enable(gl.DEPTH_TEST);
    }

    // Curve edit mode (UR11-1): control points + bezier handles over the polyline.
    // Depth cleared so the control structure is always visible on top.
    const curveEditObj = scene.curveEditObject;
    if (curveEditObj && scene.curveEdit && curveEditObj.curve && scene.effectiveVisible(curveEditObj)) {
      gl.clear(gl.DEPTH_BUFFER_BIT);
      const modelView = view.mul(scene.worldMatrix(curveEditObj));
      this.curveEditPass.render(modelView, proj, curveEditObj.curve, scene.curveEdit);
    }

    // Surface control net (NB-A2): the net of the surface being edited (with the
    // orange selection tint), plus any object-mode surface whose showNet flag is
    // on (neutral). Depth cleared so the net is always visible on top, like the
    // curve edit overlay.
    const surfEditObj = scene.surfaceEditObject;
    const netObjs: SceneObject[] = [];
    if (surfEditObj && scene.surfaceEdit && surfEditObj.surface && scene.effectiveVisible(surfEditObj)) {
      netObjs.push(surfEditObj);
    } else if (scene.surfaceEdit === null) {
      for (const o of visible) if (o.kind === 'surface' && o.surface?.showNet) netObjs.push(o);
    }
    if (netObjs.length > 0) {
      gl.clear(gl.DEPTH_BUFFER_BIT);
      for (const obj of netObjs) {
        const modelView = view.mul(scene.worldMatrix(obj));
        const sel = obj === surfEditObj ? scene.surfaceEdit : null;
        this.surfaceNetPass.render(obj.id, modelView, proj, obj.surface!, sel);
      }
    }

    // Translate gizmo — on top of everything (clear depth after outlines).
    // Overlays › Transform Gizmo toggles it; colors follow the axis prefs.
    const gz = overlays.gizmo ? this.gizmoTransform(scene, eye, fovY) : null;
    if (gz) {
      gl.clear(gl.DEPTH_BUFFER_BIT);
      this.gizmoPass.render(proj.mul(view), gz.origin, gz.scale, Mat4.fromQuat(gz.quat), axisColorsFromPrefs());
    }

    // Locked-axis indicator — the one gizmo arrow + guide line that stays on
    // while a modal G/R/S is constrained to an axis.
    if (this.axisIndicator) {
      gl.clear(gl.DEPTH_BUFFER_BIT);
      const { axis, pivot } = this.axisIndicator;
      // World-space view direction = -(third row of the view matrix).
      const forward = new Vec3(-view.m[2], -view.m[6], -view.m[10]);
      this.gizmoPass.renderAxis(
        proj.mul(view), pivot, gizmoScreenScale(eye, pivot, fovY), axis, eye, forward,
      );
    }

    // Edge-slide (GG) tangent guide lines — WORLD-space rails through each
    // sliding vert, extended past the far vert. Same near-plane-clamp technique
    // as the axis guide; neutral grey, distinct from the X/Y/Z axis colors.
    if (this.guideSegments && this.guideSegments.length > 0) {
      gl.clear(gl.DEPTH_BUFFER_BIT);
      const forward = new Vec3(-view.m[2], -view.m[6], -view.m[10]);
      this.gizmoPass.renderGuides(proj.mul(view), this.guideSegments, eye, forward);
    }

    // Camera Glare (UR10-2 Part B): bright-pass + separable blur of the HDR
    // capture, composited over the canvas. Runs last so every pass above is in
    // the captured frame. Overlays (grid/gizmo) are LDR (< threshold) so they
    // don't bloom — only bright emissive surfaces do.
    if (glare) this.glarePass.composite(glare);
  }

  /**
   * UR15-1 — Rendered → Raytraced solid pass. Ticks the progressive tracer (GPU
   * or CPU per shadePrefs.rayEngine), draws its current accumulation as a
   * fullscreen textured quad (LINEAR-upscaled from half-res while the camera
   * moves), then primes the depth buffer with the real scene geometry (color mask
   * off, reusing the wirePass prime shader) so the overlay tail in render()
   * depth-tests correctly ON TOP of the traced image.
   */
  private renderRaytraced(scene: Scene, camera: OrbitCamera, view: Mat4, proj: Mat4, eye: Vec3, fovY: number, visible: SceneObject[]): void {
    const { gl, canvas } = this.ctx;
    const ok = this.viewportRay.tick(scene, camera, { view, eye, fovY }, canvas.width, canvas.height);
    const img = this.viewportRay.imageBytes;
    if (ok && img) {
      this.rayPresentPass.draw(img, this.viewportRay.imageW, this.viewportRay.imageH, canvas.width, canvas.height);
    }
    // Depth prime: rasterize scene depth-only (color untouched) so overlays sit
    // over the traced image with correct occlusion.
    const viewProj = proj.mul(view);
    this.wirePass.beginPrime();
    gl.colorMask(false, false, false, false);
    for (const obj of visible) {
      if (obj.kind !== 'mesh' && obj.kind !== 'surface'
        && !(obj.kind === 'curve' && obj.evaluatedMesh(scene.modifierContext(obj)).faces.size > 0)) continue;
      this.wirePass.primeObject(viewProj.mul(scene.worldMatrix(obj)));
      this.gpuMesh(obj, scene).triangles.draw(gl.TRIANGLES);
    }
    gl.colorMask(true, true, true, true);
  }

  /** Gizmo placement (active object's position) + constant-screen-size scale (from
   *  the current viewpoint's eye/fovY), or null when hidden. */
  private gizmoTransform(scene: Scene, eye: Vec3, fovY: number): { origin: Vec3; scale: number; quat: Quat } | null {
    if (!this.gizmoVisible) return null;
    if (scene.editMode || scene.curveEdit || scene.surfaceEdit) return null; // no object gizmo in edit/curve/surface-edit mode
    const active = scene.activeObject;
    if (!active || !active.visible) return null;
    // Origin follows the transform pivot (median / individual→median / active /
    // 3D cursor); orientation follows the transform orientation (global → world
    // axes, local/normal → the active object's basis).
    const origin = scene.pivotPoint();
    return { origin, scale: gizmoScreenScale(eye, origin, fovY), quat: scene.orientationQuat() };
  }

  /** The view-projection of whatever is on screen right now (orbit camera or
   *  a looked-through camera object) — for DOM overlays like the 3D cursor. */
  currentViewProj(scene: Scene, camera: OrbitCamera): Mat4 {
    const { view, proj } = this.resolveView(scene, camera);
    return proj.mul(view);
  }

  /** The SEPARATE view + projection matrices on screen right now (orbit camera
   *  or a looked-through camera) — for the UR7-3 HTML-portal CSS3D sync, which
   *  needs them apart to build the iframe's screen matrix3d. */
  viewProjForOverlay(scene: Scene, camera: OrbitCamera): { view: Mat4; proj: Mat4 } {
    const { view, proj } = this.resolveView(scene, camera);
    return { view, proj };
  }

  /**
   * Pick what is under CSS-pixel position (x, y). Renders the id buffer on
   * demand: objects first, then (if visible) the gizmo handles LAST with depth
   * cleared so they win over objects behind them. Returns null for background.
   */
  pick(scene: Scene, camera: OrbitCamera, cssX: number, cssY: number): PickResult | null {
    const { gl, canvas } = this.ctx;
    const { view, proj, eye, fovY } = this.resolveView(scene, camera);
    const viewProj = proj.mul(view);

    this.pickingPass.begin();
    for (const obj of scene.objects) {
      if (!scene.effectiveVisible(obj) || !typePickable(obj.kind)) continue;
      this.pickingPass.drawObject(viewProj.mul(scene.worldMatrix(obj)), obj.id + 1);
      this.gpuMesh(obj, scene).triangles.draw(gl.TRIANGLES);
    }
    const gz = overlays.gizmo ? this.gizmoTransform(scene, eye, fovY) : null;
    if (gz) {
      gl.clear(gl.DEPTH_BUFFER_BIT); // pick FBO still bound: gizmo handles win
      this.gizmoPass.renderPick(this.pickingPass, viewProj, gz.origin, gz.scale, Mat4.fromQuat(gz.quat));
    }
    // Light/camera icons — drawn last (iconPass switches GL programs, and
    // pickingPass.drawObject assumes the picking shader is still active). The
    // looked-through camera has no on-screen icon, so it is not pickable either.
    const iconObjs = scene.objects.filter((o) => overlays.icons && scene.effectiveVisible(o) && typePickable(o.kind) && o.kind !== 'mesh' && o.id !== this.cameraViewId);
    if (iconObjs.length > 0) {
      this.iconPass.begin(viewProj, canvas.width, canvas.height);
      for (const obj of iconObjs) this.iconPass.drawPick(scene.worldTransformOf(obj).position, obj.id + 1);
    }
    this.pickingPass.end(canvas.width, canvas.height);

    const dpr = window.devicePixelRatio || 1;
    const px = Math.round(cssX * dpr);
    const py = Math.round(cssY * dpr);
    const raw = this.pickingPass.read(px, py);
    // Gizmo handles win over everything (they drew last with depth cleared) —
    // keep that ordering regardless of the select-through phase below. Plane ids
    // sit above the arrow ids, so test them first.
    if (raw >= GIZMO_PLANE_BASE) return { kind: 'gizmoPlane', plane: GIZMO_PLANES[raw - GIZMO_PLANE_BASE] };
    if (raw >= GIZMO_PICK_BASE) return { kind: 'gizmo', axis: GIZMO_AXES[raw - GIZMO_PICK_BASE] };

    // Curve select-through (UR11-1): a curve has no surface, so its polyline is
    // rendered into the pick buffer and matched by proximity, in EVERY mode.
    // Tight window so it doesn't steal clicks meant for meshes behind it.
    const curveId = this.curveProximityPick(scene, viewProj, px, py);
    if (curveId !== null) return { kind: 'object', id: curveId };

    // Object select-through: when Hidden Line is off for the current mode the
    // wireframe is see-through, so a click on/near ANY visible wire — including
    // one behind other geometry — should select that object. Runs BEFORE the
    // surface result; an empty proximity window falls back to the triangle pick.
    if (!shadePrefs.hiddenLine[this.shadingMode]) {
      const wireId = this.wireProximityPick(scene, viewProj, px, py);
      if (wireId !== null) return { kind: 'object', id: wireId };
    }

    if (raw === 0) return null;
    return { kind: 'object', id: raw - 1 };
  }

  /**
   * Object select-through helper: render every visible object's EDGE lines into
   * the pick buffer with the depth test OFF (so wires behind geometry still
   * write their id), then find the id of the non-zero pixel nearest the cursor
   * within an N×N window (expanding Chebyshev rings — nearest wins, and we stop
   * at the first ring that has a hit). Returns the object id, or null if no wire
   * is within the window. Does not touch the gizmo (handled by the caller).
   */
  private wireProximityPick(scene: Scene, viewProj: Mat4, px: number, py: number): number | null {
    const { gl, canvas } = this.ctx;
    this.pickingPass.begin();
    gl.disable(gl.DEPTH_TEST);
    for (const obj of scene.objects) {
      if (!scene.effectiveVisible(obj) || (obj.kind !== 'mesh' && obj.kind !== 'surface') || !typePickable(obj.kind)) continue;
      this.pickingPass.drawObject(viewProj.mul(scene.worldMatrix(obj)), obj.id + 1);
      this.gpuMesh(obj, scene).edges.draw(gl.LINES);
    }
    gl.enable(gl.DEPTH_TEST);
    this.pickingPass.end(canvas.width, canvas.height);

    const half = 5; // N = 11
    for (let ring = 0; ring <= half; ring++) {
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue; // this ring only
          const x = px + dx, y = py + dy;
          if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) continue;
          const id = this.pickingPass.read(x, y);
          if (id !== 0 && id < GIZMO_PICK_BASE) return id - 1;
        }
      }
    }
    return null;
  }

  /**
   * Curve object select-through: render every visible curve's polyline into the
   * pick buffer (depth OFF so it always writes) and return the id of the nearest
   * non-zero pixel within a small window. Null = no curve near the cursor.
   */
  private curveProximityPick(scene: Scene, viewProj: Mat4, px: number, py: number): number | null {
    const curves = scene.objects.filter((o) => scene.effectiveVisible(o) && typePickable(o.kind) && o.kind === 'curve' && o.curve && o.curve.points.length >= 2);
    if (curves.length === 0) return null;
    const { gl, canvas } = this.ctx;
    this.pickingPass.begin();
    gl.disable(gl.DEPTH_TEST);
    for (const obj of curves) {
      const g = this.curveGpu(obj);
      if (g.segCount === 0) continue;
      this.pickingPass.drawObject(viewProj.mul(scene.worldMatrix(obj)), obj.id + 1);
      g.pickLines.draw(gl.LINES);
    }
    gl.enable(gl.DEPTH_TEST);
    this.pickingPass.end(canvas.width, canvas.height);

    const half = 5; // 11px window
    for (let ring = 0; ring <= half; ring++) {
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const x = px + dx, y = py + dy;
          if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) continue;
          const id = this.pickingPass.read(x, y);
          if (id !== 0 && id < GIZMO_PICK_BASE) return id - 1;
        }
      }
    }
    return null;
  }

  /**
   * Curve-edit element pick (UR11-1): the control point or bezier handle under
   * the cursor, by CPU screen-space projection (no faces to raster). Returns the
   * nearest within `radius` CSS px — anchors win ties over handles — or null.
   */
  pickCurveElement(
    scene: Scene,
    camera: OrbitCamera,
    cssX: number,
    cssY: number,
    radius = 12,
  ): { kind: 'point'; index: number } | { kind: 'handle'; index: number; side: 'hl' | 'hr' } | null {
    const obj = scene.curveEditObject;
    const sel = scene.curveEdit;
    if (!obj || !sel || !obj.curve) return null;
    const { canvas } = this.ctx;
    const mvp = camera.projMatrix(canvas.width / canvas.height).mul(camera.viewMatrix()).mul(scene.worldMatrix(obj));
    const project = (p: Vec3): { x: number; y: number } | null => {
      const ndc = mvp.transformPoint(p);
      return { x: ((ndc.x + 1) / 2) * canvas.clientWidth, y: ((1 - ndc.y) / 2) * canvas.clientHeight };
    };
    let best: { kind: 'point'; index: number } | { kind: 'handle'; index: number; side: 'hl' | 'hr' } | null = null;
    let bestD = radius * radius;
    obj.curve.points.forEach((pt, i) => {
      const anchor = project(new Vec3(pt.co[0], pt.co[1], pt.co[2]));
      if (anchor) {
        const d = (anchor.x - cssX) ** 2 + (anchor.y - cssY) ** 2;
        if (d <= bestD) { bestD = d; best = { kind: 'point', index: i }; }
      }
      if (obj.curve!.kind === 'bezier') {
        for (const side of ['hl', 'hr'] as const) {
          const hv = side === 'hl' ? leftHandle(pt) : rightHandle(pt);
          const s = project(hv);
          if (!s) continue;
          const d = (s.x - cssX) ** 2 + (s.y - cssY) ** 2;
          // Strict '<' so an anchor at the same spot (auto handle == co) wins.
          if (d < bestD) { bestD = d; best = { kind: 'handle', index: i, side }; }
        }
      }
    });
    return best;
  }

  /**
   * Surface-edit net pick (NB-A2): the control-net point (FLAT index
   * iu*pointsV + iv) nearest the cursor by CPU screen-space projection, within
   * `radius` CSS px (the same tolerance curve edit uses), or null. Mirrors
   * pickCurveElement — no faces to raster, so we project every control point.
   */
  pickSurfacePoint(
    scene: Scene,
    camera: OrbitCamera,
    cssX: number,
    cssY: number,
    radius = 12,
  ): { index: number } | null {
    const obj = scene.surfaceEditObject;
    const sel = scene.surfaceEdit;
    if (!obj || !sel || !obj.surface) return null;
    const { canvas } = this.ctx;
    const mvp = camera.projMatrix(canvas.width / canvas.height).mul(camera.viewMatrix()).mul(scene.worldMatrix(obj));
    let best: { index: number } | null = null;
    let bestD = radius * radius;
    obj.surface.points.forEach((pt, i) => {
      const ndc = mvp.transformPoint(new Vec3(pt.co[0], pt.co[1], pt.co[2]));
      const x = ((ndc.x + 1) / 2) * canvas.clientWidth;
      const y = ((1 - ndc.y) / 2) * canvas.clientHeight;
      const d = (x - cssX) ** 2 + (y - cssY) ** 2;
      if (d <= bestD) { bestD = d; best = { index: i }; }
    });
    return best;
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
    const modelView = view.mul(scene.worldMatrix(editObj));
    // Effective select-through: Alt+Z x-ray OR a see-through shading mode
    // (Hidden Line off for the current mode) — so clicks reach hidden elements.
    const xray = xrayState.enabled || !shadePrefs.hiddenLine[this.shadingMode];
    this.elementPickPass.render(modelView, proj, editObj.mesh, kindOverride ?? sel.elementMode, xray);

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

  /**
   * True when edit-mode face picking should use centroid-dot proximity instead
   * of the surface pick — i.e. Hidden Line is OFF for the current shading mode
   * (the see-through case where face-center dots are the pick targets).
   */
  faceProximityPickActive(): boolean {
    return !shadePrefs.hiddenLine[this.shadingMode];
  }

  /**
   * Proximity face pick: project every edit-mesh face CENTROID to screen and
   * return the id of the face whose dot is nearest the click, THROUGH geometry
   * (no occlusion), within `radius` CSS px. Null = miss (nothing in range).
   */
  pickFaceByProximity(
    scene: Scene,
    camera: OrbitCamera,
    cssX: number,
    cssY: number,
    radius = 40,
  ): number | null {
    const editObj = scene.editObject;
    const sel = scene.editMode;
    if (!editObj || !sel) return null;
    const { canvas } = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.width / dpr;
    const cssH = canvas.height / dpr;
    const mvp = camera
      .projMatrix(canvas.width / canvas.height)
      .mul(camera.viewMatrix())
      .mul(scene.worldMatrix(editObj));
    const mesh = editObj.mesh;
    let best: number | null = null;
    let bestD = radius * radius;
    for (const f of mesh.faces.values()) {
      let cx = 0, cy = 0, cz = 0;
      for (const vid of f.verts) {
        const co = mesh.verts.get(vid)!.co;
        cx += co.x; cy += co.y; cz += co.z;
      }
      const n = f.verts.length;
      const ndc = mvp.transformPoint(new Vec3(cx / n, cy / n, cz / n));
      const sx = ((ndc.x + 1) / 2) * cssW;
      const sy = ((1 - ndc.y) / 2) * cssH;
      const d = (sx - cssX) ** 2 + (sy - cssY) ** 2;
      if (d < bestD) { bestD = d; best = f.id; }
    }
    return best;
  }
}
