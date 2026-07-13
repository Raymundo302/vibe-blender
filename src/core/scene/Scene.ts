import { EditableMesh } from '../mesh/EditableMesh';
import { Transform } from '../math/transform';
import { Mat4 } from '../math/mat4';
import { Vec3 } from '../math/vec3';
import { Quat } from '../math/quat';
import { EditModeState } from './EditMode';
import { CurveEditState } from '../curve/CurveEdit';
import { defaultWorld, type World } from './worldData';
import type { Modifier, ModifierContext } from '../modifiers/Modifier';
import {
  DEFAULT_MATERIAL,
  cloneTextData,
  defaultCamera,
  defaultEmpty,
  defaultLight,
  defaultTextData,
  makeMaterial,
  cloneCurveData,
  type CameraData,
  type CurveData,
  type EmptyData,
  type LightData,
  type LightType,
  type Material,
  type ObjectKind,
  type TextData,
} from './objectData';

/** An outliner group (Phase 10). Objects reference one by collectionId. */
export interface SceneCollection {
  readonly id: number;
  name: string;
  /** Unchecking hides every member (obj.visible stays untouched). */
  visible: boolean;
}

/** Scene output settings (UR5-5 resolution + UR16-3 transparent film). */
export interface RenderSettings {
  width: number;
  height: number;
  /** Transparent film (UR16-3): render the world backdrop as alpha 0. Default false. */
  transparent?: boolean;
}

export class SceneObject {
  transform = new Transform();
  visible = true;
  /** Shade Smooth (per-vertex normals) vs Flat (Blender default). */
  shadeSmooth = false;
  /** Viewport display color (0..1 RGB floats). Default neutral grey (#b0b0b0-ish). */
  color: [number, number, number] = [0.69, 0.69, 0.69];
  /** Non-destructive modifier stack, evaluated top-to-bottom. */
  readonly modifiers: Modifier[] = [];
  /** Bump after ANY stack mutation (add/remove/reorder/param/enable). */
  modifiersVersion = 0;

  private evalCache: { key: string; mesh: EditableMesh } | null = null;

  /** Light payload — set iff kind === 'light'. */
  light?: LightData;
  /** Camera payload — set iff kind === 'camera'. */
  camera?: CameraData;
  /** Empty payload — set iff kind === 'empty' (UR5-7). */
  empty?: EmptyData;
  /** Assigned material id (scene.materials), or null → DEFAULT_MATERIAL. */
  materialId: number | null = null;
  /** Owning collection id (scene.collections), or null → scene root. */
  collectionId: number | null = null;
  /** Parent object id (P12 parenting), or null → world root. World transform =
   *  parent chain × local. Cycle-guarded in Scene.worldMatrix. */
  parentId: number | null = null;
  /** Animation curves (P15), or undefined = never keyed. */
  anim?: import('../anim/fcurve').AnimData;
  /** HTML-plane payload (UR7-1), or undefined = not an HTML plane. */
  html?: import('./objectData').HtmlPlaneData;
  /** Text payload (UR8-2) — set iff kind === 'text'. The mesh is regenerated
   *  from this by the text driver whenever the payload changes. */
  text?: TextData;
  /** Curve payload (UR11-1) — set iff kind === 'curve'. The viewport polyline
   *  is DERIVED from this (evaluateCurve); the object carries an empty mesh. */
  curve?: CurveData;

  constructor(
    /** Stable id, unique within the scene. Also the picking id (offset by 1). */
    readonly id: number,
    public name: string,
    /** Non-mesh kinds carry an EMPTY mesh so every mesh code path no-ops. */
    public mesh: EditableMesh,
    /** What this object IS. Lights/cameras have data payloads, not geometry. */
    readonly kind: ObjectKind = 'mesh',
  ) {}

  /**
   * The mesh the viewport shows in object mode: base mesh run through every
   * enabled modifier. Cached until the base mesh or the stack changes — or,
   * for object-referencing modifiers (Shrinkwrap/Scatter), until a dependency
   * reported through depVersion(ctx) changes. Pass the ctx from
   * Scene.modifierContext(obj) so those modifiers can resolve their targets;
   * without it they no-op.
   * With an empty/disabled stack this is the base mesh itself (no copy).
   */
  evaluatedMesh(ctx?: ModifierContext): EditableMesh {
    const active = this.modifiers.filter((m) => m.enabled);
    if (active.length === 0) return this.mesh;
    const deps = active.map((m) => m.depVersion?.(ctx) ?? '').join('|');
    const key = `${this.mesh.version}:${this.modifiersVersion}:${deps}`;
    if (this.evalCache?.key === key) return this.evalCache.mesh;
    let result = this.mesh;
    for (const mod of active) result = mod.apply(result, ctx);
    this.evalCache = { key, mesh: result };
    return result;
  }
}

/**
 * Flat object list + selection state. Blender concepts: many objects can be
 * selected, exactly one of them is "active" (keyboard operators pivot on the
 * selection; panels show the active object).
 */
export class Scene {
  readonly objects: SceneObject[] = [];
  readonly selection = new Set<number>();
  activeId: number | null = null;
  /** Non-null while editing one object's mesh (Blender's Edit Mode). */
  editMode: EditModeState | null = null;
  /** Non-null while editing one curve object's control points (UR11-1) — the
   *  curve analogue of editMode, kept separate because a curve has no mesh cage. */
  curveEdit: CurveEditState | null = null;
  /** Scene material library; objects reference entries by id. */
  readonly materials: Material[] = [];
  /** Outliner collections; objects reference entries by collectionId. */
  readonly collections: SceneCollection[] = [];
  /** The camera F12 renders from / Numpad-0 looks through, or null. */
  activeCameraId: number | null = null;
  /**
   * Scene output resolution (UR5-5) — Blender's Output "Format" resolution. It
   * is the REAL frame the F12 tracer / Ctrl+F12 animation render at, and the
   * aspect (width/height) the passepartout marks and the through-camera
   * projection letterboxes to. Defaults to 1920×1080; loading an old file that
   * predates it also lands here.
   *
   * `transparent` (UR16-3) — a transparent film: when true the F12 / Ctrl+F12
   * renders skip the world backdrop behind the geometry and output ALPHA
   * (primary-ray miss = 0). Defaults off; version-tolerant on load.
   */
  renderSettings: RenderSettings = { width: 1920, height: 1080, transparent: false };
  /** Environment (background + image-based lighting). Default reproduces the
   *  path tracer's original hardcoded sky, so pre-World scenes are unchanged. */
  world: World = defaultWorld();
  /** 3D cursor position, world space (P12). Shift+RightClick places it. */
  cursor: Vec3 = Vec3.ZERO;
  /**
   * Transform pivot point (Blender's `.`/comma pie). `median` = selection median
   * (default), `cursor` = the 3D cursor (P12), `individual` = each object/element
   * about its OWN origin, `active` = the active object's/element's origin (the
   * last-selected acts like a temporary parent). The gizmo sits at this point.
   */
  pivotMode: 'median' | 'cursor' | 'individual' | 'active' = 'median';

  /**
   * Transform orientation (Blender's orientation dropdown). `global` = world
   * axes (default), `local` = the active object's rotation basis, `normal` =
   * (edit mode) the selected element normal frame. Drives the gizmo orientation
   * and the axis-lock basis in G/R/S.
   */
  transformOrientation: 'global' | 'local' | 'normal' = 'global';
  /** Timeline (P15). frameCurrent is applied by the sampler on scrub/play. */
  frameStart = 1;
  frameEnd = 120;
  frameCurrent = 1;
  /** Playback rate; fixed 24 until a UI needs otherwise. */
  fps = 24;
  /** Runtime playback flag (timeline pane + spacebar) — NOT serialized. */
  playing = false;
  private nextId = 0;
  private nextMaterialId = 0;
  private nextCollectionId = 0;

  get mode(): 'object' | 'edit' {
    return this.editMode ? 'edit' : 'object';
  }

  /** Enter edit mode on an object (defaults to the active one). No-op if none. */
  enterEditMode(id = this.activeId): boolean {
    const obj = id === null ? null : this.get(id);
    if (!obj || obj.kind !== 'mesh') return false; // lights/cameras have no editable mesh
    this.selectOnly(obj.id); // Blender: editing implies the object is active+selected
    this.editMode = new EditModeState(obj.id);
    return true;
  }

  exitEditMode(): void {
    this.editMode = null;
  }

  /** The object whose mesh is being edited, or null outside edit mode. */
  get editObject(): SceneObject | null {
    return this.editMode ? this.get(this.editMode.objectId) ?? null : null;
  }

  add(name: string, mesh: EditableMesh): SceneObject {
    const obj = new SceneObject(this.nextId++, name, mesh);
    this.objects.push(obj);
    return obj;
  }

  /** Add a light object (empty mesh + LightData payload). Not auto-selected. */
  addLight(name: string, type: LightType, data?: LightData): SceneObject {
    const obj = new SceneObject(this.nextId++, name, new EditableMesh(), 'light');
    obj.light = data ?? defaultLight(type);
    this.objects.push(obj);
    return obj;
  }

  /**
   * Add a camera object (empty mesh + CameraData payload). The first camera
   * added becomes the scene's active camera.
   */
  addCamera(name: string, data?: CameraData): SceneObject {
    const obj = new SceneObject(this.nextId++, name, new EditableMesh(), 'camera');
    obj.camera = data ?? defaultCamera();
    this.objects.push(obj);
    if (this.activeCameraId === null) this.activeCameraId = obj.id;
    return obj;
  }

  /** Add an empty object (null object: rig/target helper drawn as plain axes).
   *  Carries an empty mesh so every mesh code path no-ops. Not auto-selected. */
  addEmpty(name: string, data?: EmptyData): SceneObject {
    const obj = new SceneObject(this.nextId++, name, new EditableMesh(), 'empty');
    obj.empty = data ?? defaultEmpty();
    this.objects.push(obj);
    return obj;
  }

  /**
   * Add a text object (UR8-2). Carries a real mesh (unlike light/camera/empty),
   * but it starts EMPTY: the text driver regenerates it from the payload via
   * buildTextMesh (canvas-bound, so it can't run in this pure-core method). The
   * object's viewport color is white so the per-glyph face/outline tints show
   * their true colors (matcap multiplies obj.color × tint). Not auto-selected.
   */
  addText(name: string, data?: TextData): SceneObject {
    const obj = new SceneObject(this.nextId++, name, new EditableMesh(), 'text');
    obj.text = data ?? defaultTextData();
    obj.color = [1, 1, 1];
    this.objects.push(obj);
    return obj;
  }

  /**
   * Add a curve object (UR11-1). Carries an EMPTY mesh (the viewport polyline is
   * derived from the payload, not stored geometry). Not auto-selected.
   */
  addCurve(name: string, data: CurveData): SceneObject {
    const obj = new SceneObject(this.nextId++, name, new EditableMesh(), 'curve');
    obj.curve = data;
    this.objects.push(obj);
    return obj;
  }

  /** Enter curve edit mode on a curve object (defaults to the active one). */
  enterCurveEdit(id = this.activeId): boolean {
    const obj = id === null ? null : this.get(id);
    if (!obj || obj.kind !== 'curve' || !obj.curve) return false;
    this.selectOnly(obj.id);
    this.curveEdit = new CurveEditState(obj.id);
    return true;
  }

  exitCurveEdit(): void {
    this.curveEdit = null;
  }

  /** The curve object being edited, or null outside curve edit mode. */
  get curveEditObject(): SceneObject | null {
    return this.curveEdit ? this.get(this.curveEdit.objectId) ?? null : null;
  }

  /** The active camera object, or null (none set / it was deleted). */
  get activeCamera(): SceneObject | null {
    const obj = this.activeCameraId === null ? null : this.get(this.activeCameraId);
    return obj?.kind === 'camera' ? obj : null;
  }

  /** Create a collection (name defaults to Collection.NNN). */
  addCollection(name?: string): SceneCollection {
    const id = this.nextCollectionId++;
    const col: SceneCollection = {
      id,
      name: name ?? `Collection.${String(id + 1).padStart(3, '0')}`,
      visible: true,
    };
    this.collections.push(col);
    return col;
  }

  getCollection(id: number): SceneCollection | undefined {
    return this.collections.find((c) => c.id === id);
  }

  /** Remove a collection; members drop back to the scene root. */
  removeCollection(id: number): void {
    const i = this.collections.findIndex((c) => c.id === id);
    if (i < 0) return;
    this.collections.splice(i, 1);
    for (const obj of this.objects) if (obj.collectionId === id) obj.collectionId = null;
  }

  /**
   * What the viewport/pick/export/render actually honor: the object's own
   * visibility AND its collection's (root objects only have their own).
   */
  effectiveVisible(obj: SceneObject): boolean {
    if (!obj.visible) return false;
    if (obj.collectionId === null) return true;
    return this.getCollection(obj.collectionId)?.visible !== false;
  }

  /** Create a material in the scene library (name defaults to Material.NNN). */
  addMaterial(name?: string): Material {
    const id = this.nextMaterialId++;
    const mat = makeMaterial(id, name ?? `Material.${String(id + 1).padStart(3, '0')}`);
    this.materials.push(mat);
    return mat;
  }

  getMaterial(id: number): Material | undefined {
    return this.materials.find((m) => m.id === id);
  }

  /** Remove a material from the library and unassign it from every object. */
  removeMaterial(id: number): void {
    const i = this.materials.findIndex((m) => m.id === id);
    if (i < 0) return;
    this.materials.splice(i, 1);
    for (const obj of this.objects) if (obj.materialId === id) obj.materialId = null;
  }

  /** The material an object renders with (assigned, or the shared default). */
  materialOf(obj: SceneObject): Material {
    return (obj.materialId !== null && this.getMaterial(obj.materialId)) || DEFAULT_MATERIAL;
  }

  /**
   * Scene access for an object's modifier stack ('object'-param modifiers).
   * Targets resolve to their EVALUATED mesh; `visited` breaks reference
   * cycles (A shrinkwraps to B shrinkwraps to A → the inner lookup gets null).
   */
  modifierContext(host: SceneObject, visited: Set<number> = new Set()): ModifierContext {
    visited.add(host.id);
    return {
      hostMatrix: this.worldMatrix(host),
      // UR11-2: a curve host exposes its payload so the Pipe modifier can sweep
      // a tube along it (curve objects carry an empty base mesh).
      hostCurve: host.kind === 'curve' ? host.curve : undefined,
      target: (objectId: number) => {
        if (visited.has(objectId)) return null;
        const obj = this.get(objectId);
        if (!obj || obj.kind !== 'mesh') return null;
        const childCtx = this.modifierContext(obj, new Set(visited));
        const mesh = obj.evaluatedMesh(childCtx);
        return {
          mesh,
          matrix: this.worldMatrix(obj),
          version: `${objectId}:${mesh.version}:${obj.modifiersVersion}`,
        };
      },
    };
  }

  get(id: number): SceneObject | undefined {
    return this.objects.find((o) => o.id === id);
  }

  // --- Parenting (P12) -------------------------------------------------------

  /** The parent object, or null (root, or a dangling/removed parent id). */
  parentOf(obj: SceneObject): SceneObject | null {
    return obj.parentId === null ? null : this.get(obj.parentId) ?? null;
  }

  /** Direct children (objects whose parentId is obj.id). */
  childrenOf(obj: SceneObject): SceneObject[] {
    return this.objects.filter((o) => o.parentId === obj.id);
  }

  /** True if `ancestor` appears anywhere up `obj`'s parent chain. */
  isAncestor(ancestor: SceneObject, obj: SceneObject): boolean {
    const seen = new Set<number>([obj.id]);
    for (let p = this.parentOf(obj); p; p = this.parentOf(p)) {
      if (p.id === ancestor.id) return true;
      if (seen.has(p.id)) return false; // corrupt cycle — treat as root
      seen.add(p.id);
    }
    return false;
  }

  /** World matrix of the parent chain ABOVE obj (identity for roots). */
  parentWorldMatrix(obj: SceneObject): Mat4 {
    const parent = this.parentOf(obj);
    return parent ? this.worldMatrix(parent) : Mat4.identity();
  }

  /** Full world matrix: parent chain × local TRS. Cycles act as roots. */
  worldMatrix(obj: SceneObject): Mat4 {
    let m = obj.transform.matrix();
    const seen = new Set<number>([obj.id]);
    for (let p = this.parentOf(obj); p; p = this.parentOf(p)) {
      if (seen.has(p.id)) break; // corrupt cycle guard
      seen.add(p.id);
      m = p.transform.matrix().mul(m);
    }
    return m;
  }

  /** World-space TRS of an object. Roots return the transform itself. */
  worldTransformOf(obj: SceneObject): Transform {
    if (obj.parentId === null) return obj.transform;
    return Transform.fromMat4(this.worldMatrix(obj));
  }

  // --- Camera world matrix (UR5-7) -------------------------------------------

  /**
   * The Look At target of a camera, resolved defensively (UR5-7): null when
   * lookAtId is unset, the target was deleted, points at the camera itself, or
   * the target is a DESCENDANT of the camera (a lookAt there would make the
   * world-matrix computation recurse — the cycle guard). When this returns null
   * the camera keeps its own transform orientation.
   */
  cameraLookAtTarget(cam: SceneObject): SceneObject | null {
    const id = cam.camera?.lookAtId;
    if (id === undefined || id === null) return null;
    const target = this.get(id);
    if (!target || target.id === cam.id) return null;
    // Descendant of the camera → ignore (world-matrix recursion would loop).
    if (this.isAncestor(cam, target)) return null;
    return target;
  }

  /**
   * True when a camera's lookAtId points at a descendant of the camera (or
   * itself): the lookAt is IGNORED and the Camera tab surfaces a warning. Distinct
   * from a merely-deleted target (which is silently unset, not a cycle).
   */
  cameraLookAtIsCyclic(cam: SceneObject): boolean {
    const id = cam.camera?.lookAtId;
    if (id === undefined || id === null) return false;
    const target = this.get(id);
    if (!target) return false; // deleted → stale, not cyclic
    return target.id === cam.id || this.isAncestor(cam, target);
  }

  /**
   * The single source of a camera object's world matrix (translation × rotation,
   * scale ignored — Blender treats camera scale as display only). EVERY consumer
   * — the through-camera viewport view, the path tracer, the frustum drawing and
   * Numpad0 — routes through here so they always agree.
   *
   * Position comes from the parent chain (worldTransformOf). Orientation is the
   * aim-at-target lookAt basis when a valid Look At is set (local -Z toward the
   * target's world origin, up = world +Z, with a fallback up when the aim is
   * straight up/down so the basis stays defined), otherwise the object's own
   * world rotation.
   */
  cameraWorldMatrix(cam: SceneObject): Mat4 {
    const pose = this.worldTransformOf(cam);
    const target = this.cameraLookAtTarget(cam);
    if (!target) {
      return Mat4.translation(pose.position).mul(Mat4.fromQuat(pose.rotation));
    }
    const eye = pose.position;
    const targetPos = this.worldTransformOf(target).position;
    let fwd = targetPos.sub(eye);
    if (fwd.lengthSq() < 1e-12) {
      // Coincident eye/target → keep the camera's own orientation.
      return Mat4.translation(eye).mul(Mat4.fromQuat(pose.rotation));
    }
    fwd = fwd.normalize();
    // Standard lookAt basis: camera +Z points back toward the viewer (−fwd).
    const worldUp = Vec3.Z;
    const up = Math.abs(fwd.dot(worldUp)) > 0.9995 ? Vec3.Y : worldUp; // degenerate up/down
    const z = fwd.scale(-1);
    const x = up.cross(z).normalize();
    const y = z.cross(x); // already unit-length (x, z orthonormal)
    return new Mat4([
      x.x, x.y, x.z, 0,
      y.x, y.y, y.z, 0,
      z.x, z.y, z.z, 0,
      eye.x, eye.y, eye.z, 1,
    ]);
  }

  /** Re-express a world-space transform in obj's CURRENT parent space. */
  localFromWorld(obj: SceneObject, world: Transform): Transform {
    if (obj.parentId === null) return world;
    return Transform.fromMat4(this.parentWorldMatrix(obj).invert().mul(world.matrix()));
  }

  /**
   * Set (or clear, parent=null) an object's parent, keeping its world
   * transform (Blender's Ctrl+P / Alt+P "Keep Transform"). Refuses self- and
   * descendant-parenting (returns false) so the graph stays a forest.
   */
  setParentKeepTransform(child: SceneObject, parent: SceneObject | null): boolean {
    if (parent && (parent.id === child.id || this.isAncestor(child, parent))) return false;
    const world = this.worldTransformOf(child);
    child.parentId = parent ? parent.id : null;
    child.transform = parent
      ? Transform.fromMat4(this.worldMatrix(parent).invert().mul(world.matrix()))
      : world;
    return true;
  }

  /**
   * Kind-aware copy of an object (Shift+D): clones the mesh for mesh objects,
   * deep-copies light/camera payloads, carries transform / visibility /
   * shading / color / material. Modifier stacks are NOT copied (matches the
   * pre-P8 behavior; revisit if it ever bites).
   */
  duplicate(src: SceneObject, name: string): SceneObject {
    const obj = new SceneObject(this.nextId++, name, src.mesh.clone(), src.kind);
    if (src.light) obj.light = { ...src.light, color: [...src.light.color] };
    if (src.camera) obj.camera = { ...src.camera };
    if (src.empty) obj.empty = { ...src.empty };
    // HTML-plane payload is flat plain data — a shallow spread is a deep copy.
    if (src.html) obj.html = { ...src.html };
    // Text payload (UR8-2): deep-copy so the duplicate's mesh regenerates from
    // its own payload (the cloned mesh above is a fine starting point).
    if (src.text) obj.text = cloneTextData(src.text);
    // Curve payload (UR11-1): deep-copy so the duplicate is independent.
    if (src.curve) obj.curve = cloneCurveData(src.curve);
    obj.transform = src.transform; // Transform is immutable — sharing is safe.
    obj.visible = src.visible;
    obj.shadeSmooth = src.shadeSmooth;
    obj.color = [...src.color];
    obj.materialId = src.materialId;
    obj.collectionId = src.collectionId;
    obj.parentId = src.parentId; // duplicate of a child stays a child
    if (src.anim) obj.anim = JSON.parse(JSON.stringify(src.anim)); // curves are plain data
    this.objects.push(obj);
    return obj;
  }

  get selectedObjects(): SceneObject[] {
    return this.objects.filter((o) => this.selection.has(o.id));
  }

  /**
   * Object-mode transform pivot point (where the gizmo sits, world space),
   * resolved from {@link pivotMode}: `cursor` → the 3D cursor; `active` → the
   * active object's origin (last-selected acts as a temporary parent);
   * `median`/`individual` → the median of the selected objects' origins (for
   * Individual Origins the gizmo shows the median; the per-object pivoting is
   * applied by the transform operators). Falls back to the cursor when nothing
   * is selected.
   */
  pivotPoint(): Vec3 {
    if (this.pivotMode === 'cursor') return this.cursor;
    const sel = this.selectedObjects;
    if (sel.length === 0) return this.cursor;
    if (this.pivotMode === 'active') {
      const a = this.activeObject;
      if (a) return this.worldTransformOf(a).position;
    }
    let sum = Vec3.ZERO;
    for (const o of sel) sum = sum.add(this.worldTransformOf(o).position);
    return sum.scale(1 / sel.length);
  }

  /**
   * Transform-orientation rotation (object mode), used to orient the gizmo and
   * the axis-lock basis in G/R/S. `global` → identity (world axes); `local` and
   * `normal` → the active object's world rotation (in object mode Normal behaves
   * like Local — Blender). Edit-mode `normal` element frames are resolved by the
   * edit transform operators, not here.
   */
  orientationQuat(): Quat {
    if (this.transformOrientation === 'global') return Quat.identity();
    const a = this.activeObject;
    return a ? this.worldTransformOf(a).rotation : Quat.identity();
  }

  get activeObject(): SceneObject | null {
    return this.activeId === null ? null : this.get(this.activeId) ?? null;
  }

  selectOnly(id: number): void {
    this.selection.clear();
    this.selection.add(id);
    this.activeId = id;
  }

  toggleSelect(id: number): void {
    if (this.selection.has(id)) {
      this.selection.delete(id);
      if (this.activeId === id) this.activeId = [...this.selection].pop() ?? null;
    } else {
      this.selection.add(id);
      this.activeId = id;
    }
  }

  deselectAll(): void {
    this.selection.clear();
    this.activeId = null;
  }

  /** Remove an object from the scene (drops it from the selection too).
   *  Children survive: they reparent to the removed object's parent, keeping
   *  their world transform (no visual jump). */
  remove(id: number): void {
    const i = this.objects.findIndex((o) => o.id === id);
    if (i < 0) return;
    if (this.editMode?.objectId === id) this.exitEditMode();
    if (this.curveEdit?.objectId === id) this.exitCurveEdit();
    const doomed = this.objects[i];
    const grandparent = this.parentOf(doomed);
    for (const child of this.childrenOf(doomed)) {
      this.setParentKeepTransform(child, grandparent);
    }
    this.objects.splice(i, 1);
    this.selection.delete(id);
    if (this.activeId === id) this.activeId = [...this.selection].pop() ?? null;
    if (this.activeCameraId === id) {
      this.activeCameraId = this.objects.find((o) => o.kind === 'camera')?.id ?? null;
    }
  }

  /** Re-insert a previously removed object at its old list index (undo restore). */
  insertAt(obj: SceneObject, index: number): void {
    this.objects.splice(Math.min(index, this.objects.length), 0, obj);
    // Undeleting a camera into a camera-less scene makes it active again.
    if (obj.kind === 'camera' && this.activeCameraId === null) this.activeCameraId = obj.id;
  }
}
