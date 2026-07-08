import type { EditModeState } from '../core/scene/EditMode';
import type { Scene, SceneObject } from '../core/scene/Scene';
import type { UndoStack } from '../core/undo/UndoStack';
import type { OrbitCamera } from '../camera/OrbitCamera';
import { MeshEditCommand } from '../core/undo/meshCommands';
import { unwrapIslands, smartUvProject, projectFromView } from '../core/mesh/ops/unwrap';

/**
 * U "UV Mapping" popup (P11-1): Unwrap / Smart UV Project / Project From View.
 *
 * SELECTION POLICY (documented): each op runs on the selected faces, falling
 * back to ALL faces when the selection is empty — Blender operates on the
 * selection; the all-faces fallback makes a bare U useful on a fresh mesh. All
 * three are undoable via a single mesh snapshot (uvs live on the mesh).
 *
 * Self-contained DOM widget mirroring AddMenu/DeleteMenu. Reuses `.add-menu`.
 */

/** The face-id domain a UV op runs over: the selection, or all faces if empty. */
function faceDomain(obj: SceneObject, sel: EditModeState): number[] {
  const mesh = obj.mesh;
  const selected = [...sel.faces].filter((id) => mesh.faces.has(id));
  return selected.length > 0 ? selected : [...mesh.faces.keys()];
}

export function runUnwrap(
  obj: SceneObject, sel: EditModeState, undo: UndoStack, setStatus: (t: string) => void,
): void {
  const faceIds = faceDomain(obj, sel);
  if (faceIds.length === 0) { setStatus('Unwrap: no faces'); return; }
  undo.push(MeshEditCommand.capture('Unwrap', obj.mesh, () => unwrapIslands(obj.mesh, faceIds)));
  sel.touch();
  setStatus(`Unwrap — ${faceIds.length} face(s)`);
}

export function runSmartProject(
  obj: SceneObject, sel: EditModeState, undo: UndoStack, setStatus: (t: string) => void,
): void {
  const faceIds = faceDomain(obj, sel);
  if (faceIds.length === 0) { setStatus('Smart UV Project: no faces'); return; }
  undo.push(MeshEditCommand.capture('Smart UV Project', obj.mesh, () => smartUvProject(obj.mesh, faceIds)));
  sel.touch();
  setStatus(`Smart UV Project — ${faceIds.length} face(s)`);
}

export function runProjectFromView(
  scene: Scene, obj: SceneObject, sel: EditModeState, undo: UndoStack,
  camera: OrbitCamera, viewport: { width: number; height: number },
  setStatus: (t: string) => void,
): void {
  const faceIds = faceDomain(obj, sel);
  if (faceIds.length === 0) { setStatus('Project From View: no faces'); return; }
  const aspect = viewport.width / Math.max(1, viewport.height);
  const mvp = camera.projMatrix(aspect).mul(camera.viewMatrix()).mul(scene.worldMatrix(obj));
  undo.push(MeshEditCommand.capture('Project From View', obj.mesh,
    () => projectFromView(obj.mesh, faceIds, mvp, aspect)));
  sel.touch();
  setStatus(`Project From View — ${faceIds.length} face(s)`);
}

export interface UvMenuOptions {
  parent: HTMLElement;
  x: number;
  y: number;
  scene: Scene;
  obj: SceneObject;
  sel: EditModeState;
  undo: UndoStack;
  camera: OrbitCamera;
  viewportSize: () => { width: number; height: number };
  setStatus: (text: string) => void;
  onClose: () => void;
}

export class UvMenu {
  private readonly root: HTMLDivElement;
  private closed = false;

  constructor(private readonly opts: UvMenuOptions) {
    this.root = document.createElement('div');
    this.root.className = 'add-menu';

    const heading = document.createElement('div');
    heading.className = 'add-menu-heading';
    heading.textContent = 'UV Mapping';
    this.root.appendChild(heading);

    const { scene, obj, sel, undo, camera, setStatus } = opts;
    this.addItem('Unwrap', () => runUnwrap(obj, sel, undo, setStatus));
    this.addItem('Smart UV Project', () => runSmartProject(obj, sel, undo, setStatus));
    this.addItem('Project From View',
      () => runProjectFromView(scene, obj, sel, undo, camera, opts.viewportSize(), setStatus));

    this.root.style.left = `${opts.x}px`;
    this.root.style.top = `${opts.y}px`;
    opts.parent.appendChild(this.root);
    const maxX = Math.max(0, opts.parent.clientWidth - this.root.offsetWidth);
    const maxY = Math.max(0, opts.parent.clientHeight - this.root.offsetHeight);
    this.root.style.left = `${Math.min(opts.x, maxX)}px`;
    this.root.style.top = `${Math.min(opts.y, maxY)}px`;

    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('pointerdown', this.onOutsidePointer, true);
  }

  private addItem(label: string, run: () => void): void {
    const item = document.createElement('button');
    item.className = 'add-menu-item';
    item.type = 'button';
    item.textContent = label;
    item.addEventListener('click', () => { run(); this.close(); });
    this.root.appendChild(item);
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); this.close(); }
  };

  private readonly onOutsidePointer = (e: PointerEvent): void => {
    if (!this.root.contains(e.target as Node)) this.close();
  };

  close(): void {
    if (this.closed) return;
    this.closed = true;
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('pointerdown', this.onOutsidePointer, true);
    this.root.remove();
    this.opts.onClose();
  }
}
