import type { EditModeState } from '../core/scene/EditMode';
import type { EditableMesh } from '../core/mesh/EditableMesh';
import type { UndoStack } from '../core/undo/UndoStack';
import { MeshEditCommand } from '../core/undo/meshCommands';
import { dissolveEdges } from '../core/mesh/ops/dissolve';

/**
 * Delete a subset of the current edit-mode selection, wrapped in one snapshot
 * command. `kind` picks which EditableMesh op runs:
 *   vert → deleteVerts on `selectedVertIds` (the verts implied by the selection,
 *          whatever the element mode);
 *   edge → deleteEdges on `sel.edges` (edge mode);
 *   face → deleteFaces on `sel.faces` (face mode).
 * Blender leaves nothing selected after a delete, so we clear + prune afterward.
 * A no-op (empty target) pushes nothing.
 */
export function deleteSelection(
  kind: 'vert' | 'edge' | 'face',
  sel: EditModeState,
  mesh: EditableMesh,
  undo: UndoStack,
  setStatus: (text: string) => void,
): void {
  if (kind === 'vert') {
    const ids = [...sel.selectedVertIds(mesh)];
    if (ids.length === 0) return;
    undo.push(MeshEditCommand.capture('Delete Verts', mesh, () => mesh.deleteVerts(ids)));
    setStatus(`Deleted ${ids.length} vert(s)`);
  } else if (kind === 'edge') {
    const keys = [...sel.edges];
    if (keys.length === 0) return;
    undo.push(MeshEditCommand.capture('Delete Edges', mesh, () => mesh.deleteEdges(keys)));
    setStatus(`Deleted ${keys.length} edge(s)`);
  } else {
    const ids = [...sel.faces];
    if (ids.length === 0) return;
    undo.push(MeshEditCommand.capture('Delete Faces', mesh, () => mesh.deleteFaces(ids)));
    setStatus(`Deleted ${ids.length} face(s)`);
  }
  sel.clearSelection(); // also touches
  sel.prune(mesh);
}

/**
 * Blender's Merge → At Center on the verts implied by the selection. Needs ≥ 2.
 * On success the survivor is left selected in vert mode (nothing otherwise, to
 * match delete's "leave empty" behaviour).
 */
export function mergeAtCenter(
  sel: EditModeState,
  mesh: EditableMesh,
  undo: UndoStack,
  setStatus: (text: string) => void,
): void {
  const ids = [...sel.selectedVertIds(mesh)];
  if (ids.length < 2) {
    setStatus('Merge at Center needs 2 or more verts');
    return;
  }
  let survivor: number | null = null;
  undo.push(MeshEditCommand.capture('Merge at Center', mesh, () => {
    survivor = mesh.mergeVertsAtCenter(ids);
  }));
  sel.clearSelection(); // also touches
  if (survivor !== null && sel.elementMode === 'vert') sel.verts.add(survivor);
  sel.prune(mesh);
  sel.touch();
  setStatus('Merged at center');
}

/**
 * Blender's "Dissolve Edges": remove the selected interior edges while merging
 * their adjacent faces into n-gons (see ops/dissolve). Only edges with two
 * distinct faces dissolve; a selection with no such edges is a no-op that
 * pushes nothing. Leaves nothing selected, matching delete's behaviour.
 */
export function dissolveEdgeSelection(
  sel: EditModeState,
  mesh: EditableMesh,
  undo: UndoStack,
  setStatus: (text: string) => void,
): void {
  const keys = new Set(sel.edges);
  const dissolvable = [...keys].filter((k) => {
    const e = mesh.edges().get(k);
    return e !== undefined && new Set(e.faces).size === 2;
  });
  if (dissolvable.length === 0) {
    setStatus('Dissolve Edges: select interior edges');
    return;
  }
  undo.push(MeshEditCommand.capture('Dissolve Edges', mesh, () => dissolveEdges(mesh, keys)));
  sel.clearSelection(); // also touches
  sel.prune(mesh);
  setStatus(`Dissolved ${dissolvable.length} edge(s)`);
}

/** Everything the popup needs; kept free of InputManager internals. */
export interface DeleteMenuOptions {
  /** Positioned host — the pointer coords are relative to this element. */
  parent: HTMLElement;
  /** Pointer position (parent-local CSS px) where the menu should appear. */
  x: number;
  y: number;
  sel: EditModeState;
  mesh: EditableMesh;
  undo: UndoStack;
  setStatus: (text: string) => void;
  /** Fired exactly once when the menu tears down (so the owner drops its ref). */
  onClose: () => void;
}

/**
 * Blender's X "Delete" popup for edit mode. A self-contained DOM widget mirroring
 * AddMenu: it owns its element and listeners and removes them on close. Entries
 * that don't apply to the current element mode / selection render disabled.
 * Reuses the shared `.add-menu` styling from theme.css (P1-7).
 */
export class DeleteMenu {
  private readonly root: HTMLDivElement;
  private closed = false;

  constructor(private readonly opts: DeleteMenuOptions) {
    const { sel, mesh } = opts;
    this.root = document.createElement('div');
    this.root.className = 'add-menu';

    const heading = document.createElement('div');
    heading.className = 'add-menu-heading';
    heading.textContent = 'Delete';
    this.root.appendChild(heading);

    // Which entries make sense given the mode + current selection.
    const vertCount = sel.selectedVertIds(mesh).size;
    this.addItem('Verts', vertCount > 0, () => deleteSelection('vert', sel, mesh, opts.undo, opts.setStatus));
    this.addItem('Edges', sel.elementMode === 'edge' && sel.edges.size > 0,
      () => deleteSelection('edge', sel, mesh, opts.undo, opts.setStatus));
    this.addItem('Faces', sel.elementMode === 'face' && sel.faces.size > 0,
      () => deleteSelection('face', sel, mesh, opts.undo, opts.setStatus));
    this.addItem('Dissolve Edges', sel.elementMode === 'edge' && sel.edges.size > 0,
      () => dissolveEdgeSelection(sel, mesh, opts.undo, opts.setStatus));
    this.addItem('Merge at Center', vertCount >= 2,
      () => mergeAtCenter(sel, mesh, opts.undo, opts.setStatus));

    // Position at the pointer, then clamp so the menu stays inside the host.
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

  private addItem(label: string, enabled: boolean, run: () => void): void {
    const item = document.createElement('button');
    item.className = 'add-menu-item';
    item.type = 'button';
    item.textContent = label;
    if (enabled) {
      item.addEventListener('click', () => { run(); this.close(); });
    } else {
      item.disabled = true;
      item.style.opacity = '0.4';
      item.style.cursor = 'default';
    }
    this.root.appendChild(item);
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
    }
  };

  private readonly onOutsidePointer = (e: PointerEvent): void => {
    if (!this.root.contains(e.target as Node)) this.close();
  };

  /** Idempotent teardown: removes the element and every listener exactly once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('pointerdown', this.onOutsidePointer, true);
    this.root.remove();
    this.opts.onClose();
  }
}
