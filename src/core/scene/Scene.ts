import { EditableMesh } from '../mesh/EditableMesh';
import { Transform } from '../math/transform';
import { EditModeState } from './EditMode';

export class SceneObject {
  transform = new Transform();
  visible = true;

  constructor(
    /** Stable id, unique within the scene. Also the picking id (offset by 1). */
    readonly id: number,
    public name: string,
    public mesh: EditableMesh,
  ) {}
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
  private nextId = 0;

  get mode(): 'object' | 'edit' {
    return this.editMode ? 'edit' : 'object';
  }

  /** Enter edit mode on an object (defaults to the active one). No-op if none. */
  enterEditMode(id = this.activeId): boolean {
    const obj = id === null ? null : this.get(id);
    if (!obj) return false;
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

  get(id: number): SceneObject | undefined {
    return this.objects.find((o) => o.id === id);
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
  }

  /** Re-insert a previously removed object at its old list index (undo restore). */
  insertAt(obj: SceneObject, index: number): void {
    this.objects.splice(Math.min(index, this.objects.length), 0, obj);
  }
}
