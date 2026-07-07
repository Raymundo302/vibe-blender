import { EditableMesh } from '../mesh/EditableMesh';
import { Transform } from '../math/transform';
import { EditModeState } from './EditMode';
import { defaultWorld, type World } from './worldData';
import type { Modifier, ModifierContext } from '../modifiers/Modifier';
import {
  DEFAULT_MATERIAL,
  defaultCamera,
  defaultLight,
  makeMaterial,
  type CameraData,
  type LightData,
  type LightType,
  type Material,
  type ObjectKind,
} from './objectData';

/** An outliner group (Phase 10). Objects reference one by collectionId. */
export interface SceneCollection {
  readonly id: number;
  name: string;
  /** Unchecking hides every member (obj.visible stays untouched). */
  visible: boolean;
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
  /** Assigned material id (scene.materials), or null → DEFAULT_MATERIAL. */
  materialId: number | null = null;
  /** Owning collection id (scene.collections), or null → scene root. */
  collectionId: number | null = null;

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
  /** Scene material library; objects reference entries by id. */
  readonly materials: Material[] = [];
  /** Outliner collections; objects reference entries by collectionId. */
  readonly collections: SceneCollection[] = [];
  /** The camera F12 renders from / Numpad-0 looks through, or null. */
  activeCameraId: number | null = null;
  /** Environment (background + image-based lighting). Default reproduces the
   *  path tracer's original hardcoded sky, so pre-World scenes are unchanged. */
  world: World = defaultWorld();
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
      hostMatrix: host.transform.matrix(),
      target: (objectId: number) => {
        if (visited.has(objectId)) return null;
        const obj = this.get(objectId);
        if (!obj || obj.kind !== 'mesh') return null;
        const childCtx = this.modifierContext(obj, new Set(visited));
        const mesh = obj.evaluatedMesh(childCtx);
        return {
          mesh,
          matrix: obj.transform.matrix(),
          version: `${objectId}:${mesh.version}:${obj.modifiersVersion}`,
        };
      },
    };
  }

  get(id: number): SceneObject | undefined {
    return this.objects.find((o) => o.id === id);
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
    obj.transform = src.transform; // Transform is immutable — sharing is safe.
    obj.visible = src.visible;
    obj.shadeSmooth = src.shadeSmooth;
    obj.color = [...src.color];
    obj.materialId = src.materialId;
    obj.collectionId = src.collectionId;
    this.objects.push(obj);
    return obj;
  }

  get selectedObjects(): SceneObject[] {
    return this.objects.filter((o) => this.selection.has(o.id));
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

  /** Remove an object from the scene (drops it from the selection too). */
  remove(id: number): void {
    const i = this.objects.findIndex((o) => o.id === id);
    if (i < 0) return;
    if (this.editMode?.objectId === id) this.exitEditMode();
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
