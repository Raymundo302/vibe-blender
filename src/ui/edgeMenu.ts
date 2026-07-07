import type { EditModeState } from '../core/scene/EditMode';
import type { EditableMesh } from '../core/mesh/EditableMesh';
import type { UndoStack } from '../core/undo/UndoStack';
import { MeshEditCommand } from '../core/undo/meshCommands';
import { bridgeLoops } from '../core/mesh/ops/bridge';

/**
 * Ctrl+E "Edge" popup (P11-1): Mark Seam / Clear Seam over the selected edges,
 * plus Bridge Edge Loops. In Blender Ctrl+E is the Edge menu and Bridge lives
 * inside it — this replaces the app's old direct Ctrl+E→bridge binding, folding
 * bridge into the menu so nothing is lost while adding seams.
 *
 * Seams live on the mesh (like creases), so MeshEditCommand.capture snapshots
 * them for undo. The edit cage tints seam edges (see editOverlayPass).
 *
 * A self-contained DOM widget mirroring AddMenu/DeleteMenu — it owns its element
 * and listeners and removes them on close. Reuses the shared `.add-menu` styling.
 */

/** Apply Mark/Clear Seam to the selected edges, wrapped in one undo command. */
export function setSeamOnSelection(
  on: boolean,
  sel: EditModeState,
  mesh: EditableMesh,
  undo: UndoStack,
  setStatus: (text: string) => void,
): void {
  const keys = [...sel.edges].filter((k) => mesh.edges().has(k));
  if (keys.length === 0) {
    setStatus('Mark Seam: select one or more edges');
    return;
  }
  const label = on ? 'Mark Seam' : 'Clear Seam';
  undo.push(MeshEditCommand.capture(label, mesh, () => {
    for (const k of keys) {
      const [a, b] = k.split(',').map(Number);
      mesh.setSeam(a, b, on);
    }
  }));
  sel.touch(); // nudge the cage cache so seam tint redraws
  setStatus(`${label} — ${keys.length} edge(s)`);
}

/**
 * Bridge two selected edge loops into a ring of quads (moved here from the old
 * direct Ctrl+E binding). Edge mode only; the op reports its own error with no
 * mutation. Always callable — the guards set the same status the old handler did
 * ("edge mode only", "Bridge: ...") so behaviour is preserved.
 */
export function runBridge(
  sel: EditModeState,
  mesh: EditableMesh,
  undo: UndoStack,
  setStatus: (text: string) => void,
): void {
  if (sel.elementMode !== 'edge') {
    setStatus('Bridge Edge Loops: edge mode only');
    return;
  }
  const edgeKeys = new Set(sel.edges);
  let result!: { newFaceIds: number[] } | { error: string };
  const cmd = MeshEditCommand.capture('Bridge Edge Loops', mesh, () => {
    result = bridgeLoops(mesh, edgeKeys);
  });
  if ('error' in result) {
    setStatus(`Bridge: ${result.error}`); // nothing mutated — drop the no-op command
    return;
  }
  undo.push(cmd);
  sel.prune(mesh);
  sel.touch();
  setStatus(`Bridged loops — ${result.newFaceIds.length} faces`);
}

export interface EdgeMenuOptions {
  parent: HTMLElement;
  x: number;
  y: number;
  sel: EditModeState;
  mesh: EditableMesh;
  undo: UndoStack;
  setStatus: (text: string) => void;
  onClose: () => void;
}

export class EdgeMenu {
  private readonly root: HTMLDivElement;
  private closed = false;

  constructor(private readonly opts: EdgeMenuOptions) {
    const { sel, mesh } = opts;
    this.root = document.createElement('div');
    this.root.className = 'add-menu';

    const heading = document.createElement('div');
    heading.className = 'add-menu-heading';
    heading.textContent = 'Edge';
    this.root.appendChild(heading);

    const hasEdges = sel.elementMode === 'edge' && [...sel.edges].some((k) => mesh.edges().has(k));
    this.addItem('Mark Seam', hasEdges,
      () => setSeamOnSelection(true, sel, mesh, opts.undo, opts.setStatus));
    this.addItem('Clear Seam', hasEdges,
      () => setSeamOnSelection(false, sel, mesh, opts.undo, opts.setStatus));
    // Bridge is always clickable — runBridge sets its own "edge mode only" /
    // error status, preserving the old direct-binding behaviour.
    this.addItem('Bridge Edge Loops', true,
      () => runBridge(sel, mesh, opts.undo, opts.setStatus));

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
