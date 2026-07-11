import type { Panel } from './panel';
import type { Scene, SceneObject, SceneCollection } from '../core/scene/Scene';
import type { ObjectKind } from '../core/scene/objectData';
import type { UndoStack } from '../core/undo/UndoStack';
import { DeleteObjectsCommand, RenameObjectCommand, SetParentCommand } from '../core/undo/objectCommands';
import {
  CreateCollectionCommand,
  DeleteCollectionCommand,
  SetCollectionVisibilityCommand,
  RenameCollectionCommand,
} from '../core/undo/collectionCommands';
import './outliner.css';

/** Per-kind glyph shown before the object name (mesh / light / camera). */
const KIND_GLYPH: Record<ObjectKind, string> = {
  mesh: '▢', // ▢
  light: '\u{1F4A1}', // 💡
  camera: '\u{1F3A5}', // 🎥
  empty: '✛', // plain-axes empty (UR5-7)
  text: '\u{1D413}', // 𝐓 — text object (UR8-2)
};

/**
 * Blender's Outliner: objects grouped under collection headers (P10-1). Each
 * collection header carries an expand triangle, a folder glyph, its name, an eye
 * toggle and a delete button; member object rows are indented beneath it, and
 * scene-root objects are listed after the collections. A "New Collection" button
 * sits at the top. Every collection mutation goes through the undo stack.
 *
 * Object rows behave exactly as before (select / rename / hide / delete) so the
 * frozen e2e suites keep passing. Owns its DOM; collection styling lives in
 * outliner.css, base row styling in the shared theme.css.
 *
 * Parenting (P12-3): within each group (a collection's members, or the scene
 * root) parent objects nest their children 16px per depth, depth-first, each
 * parent carrying a ▸/▾ twisty that hides its subtree when collapsed. A child
 * whose parent lives in another collection renders un-nested under its own
 * collection with a subtle "↖ parent" hint. Dragging a row onto another row
 * parents it (and the rest of the selection, if it was selected) via
 * SetParentCommand; dropping onto a collection header or empty space clears the
 * parent. A refused drop (cycle) silently no-ops (no status access here).
 *
 * update() runs every frame, so it diffs a cheap signature and only rebuilds the
 * row DOM when something visible changed — and never while a rename <input> is
 * focused (rebuilding would blow away the field the user is typing in).
 */
export class OutlinerPanel implements Panel {
  readonly id = 'outliner';
  readonly title = 'Outliner';
  readonly element: HTMLDivElement;

  /** Signature of the last-rendered state; rebuild only when it changes. */
  private lastSig = '';
  /** Id of the object whose name is currently being edited, or null. */
  private renamingId: number | null = null;
  /** Id of the collection whose name is currently being edited, or null. */
  private renamingCollectionId: number | null = null;
  /** Collections collapsed in THIS panel session (default: expanded). */
  private readonly collapsed = new Set<number>();
  /** Parent objects collapsed in THIS panel session (default: expanded). */
  private readonly collapsedObjects = new Set<number>();

  /** Active drag-to-parent gesture (pointer-based), or null. */
  private dragState: { id: number; startX: number; startY: number; active: boolean } | null = null;
  /** Set true by a completed drag so the trailing click doesn't also select. */
  private suppressNextClick = false;

  constructor(
    private readonly scene: Scene,
    private readonly undo: UndoStack,
  ) {
    this.element = document.createElement('div');
    this.element.className = 'outliner-list';
    // A drag that crossed the threshold fires a click on mouseup; swallow it so
    // the drop doesn't also re-select. Capture phase beats the row handler.
    this.element.addEventListener('click', (e) => {
      if (this.suppressNextClick) {
        this.suppressNextClick = false;
        e.stopPropagation();
        e.preventDefault();
      }
    }, true);
    this.rebuild();
  }

  update(): void {
    // Never rebuild while a rename input holds focus — it would destroy the
    // field mid-edit. The commit/cancel handlers clear the guard and rebuild.
    if (this.renamingId !== null || this.renamingCollectionId !== null) return;
    const sig = this.signature();
    if (sig === this.lastSig) return;
    this.rebuild();
  }

  /** Cheap change signature: what the rows visibly depend on. */
  private signature(): string {
    const rows = this.scene.objects
      .map((o) =>
        `${o.id}:${o.name}:${o.visible ? 1 : 0}:${o.collectionId ?? -1}` +
        `:${o.parentId ?? -1}:${this.collapsedObjects.has(o.id) ? 1 : 0}`)
      .join('|');
    const cols = this.scene.collections
      .map((c) => `${c.id}:${c.name}:${c.visible ? 1 : 0}:${this.collapsed.has(c.id) ? 1 : 0}`)
      .join('|');
    const sel = [...this.scene.selection].join(',');
    return `${rows}#${cols}#${sel}#${this.scene.activeId}`;
  }

  private rebuild(): void {
    this.lastSig = this.signature();
    this.element.replaceChildren();

    this.element.appendChild(this.makeNewCollectionButton());

    // Collections first (Blender order), each with its parent-nested members.
    for (const col of this.scene.collections) {
      this.element.appendChild(this.makeCollectionHeader(col));
      if (!this.collapsed.has(col.id)) {
        const members = this.scene.objects.filter((o) => o.collectionId === col.id);
        this.renderGroup(members, true);
      }
    }

    // Scene-root objects (no collection) after the collections.
    const rootObjects = this.scene.objects.filter((o) => o.collectionId === null);
    this.renderGroup(rootObjects, false);

    if (this.scene.objects.length === 0 && this.scene.collections.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'outliner-empty';
      empty.textContent = 'No objects';
      this.element.appendChild(empty);
    }
  }

  /** The "+ New Collection" action pinned to the top of the panel. */
  private makeNewCollectionButton(): HTMLElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'outliner-newcol';
    btn.textContent = '+ New Collection';
    btn.addEventListener('click', () => {
      const col = this.scene.addCollection();
      this.undo.push(new CreateCollectionCommand(this.scene, col));
      this.lastSig = '';
      this.update();
    });
    return btn;
  }

  private makeCollectionHeader(col: SceneCollection): HTMLElement {
    const row = document.createElement('div');
    row.className = 'outliner-collection-header';

    const tri = document.createElement('span');
    tri.className = 'outliner-tri';
    tri.textContent = this.collapsed.has(col.id) ? '▸' : '▾';
    row.appendChild(tri);

    const folder = document.createElement('span');
    folder.className = 'outliner-kind';
    folder.textContent = '\u{1F4C1}'; // 📁
    row.appendChild(folder);

    const name = document.createElement('span');
    name.className = 'outliner-collection-name';
    name.textContent = col.name;
    row.appendChild(name);

    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'outliner-btn outliner-eye';
    eye.classList.toggle('outliner-hidden', !col.visible);
    eye.textContent = col.visible ? '\u{1F441}' : '–';
    eye.title = col.visible ? 'Hide collection' : 'Show collection';
    row.appendChild(eye);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'outliner-btn outliner-del';
    del.textContent = '✕';
    del.title = 'Delete collection (members drop to root)';
    row.appendChild(del);

    // Click the triangle (or the header body) to expand/collapse.
    const toggleExpand = (): void => {
      if (this.collapsed.has(col.id)) this.collapsed.delete(col.id);
      else this.collapsed.add(col.id);
      this.lastSig = '';
      this.update();
    };
    tri.addEventListener('click', (e) => { e.stopPropagation(); toggleExpand(); });
    row.addEventListener('click', toggleExpand);

    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      this.undo.push(SetCollectionVisibilityCommand.toggle(col));
      this.lastSig = '';
      this.update();
    });

    del.addEventListener('click', (e) => {
      e.stopPropagation();
      const cmd = DeleteCollectionCommand.perform(this.scene, col.id);
      if (cmd) this.undo.push(cmd);
      this.lastSig = '';
      this.update();
    });

    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.beginRenameCollection(col, row, name);
    });

    return row;
  }

  /**
   * Render a set of objects (a collection's members, or the scene root) with
   * parent nesting. A "group root" is a member whose parent isn't in the same
   * group — either no parent, or a parent that lives in another collection.
   * Group roots render un-nested (base indent); their in-group descendants nest
   * 16px deeper per level, depth-first. Cross-collection parents get a hint.
   */
  private renderGroup(members: SceneObject[], collectionMember: boolean): void {
    const memberIds = new Set(members.map((m) => m.id));
    for (const obj of members) {
      if (obj.parentId === null || !memberIds.has(obj.parentId)) {
        this.renderSubtree(obj, 0, memberIds, collectionMember);
      }
    }
  }

  private renderSubtree(
    obj: SceneObject,
    depth: number,
    memberIds: Set<number>,
    collectionMember: boolean,
  ): void {
    const children = this.scene.childrenOf(obj).filter((c) => memberIds.has(c.id));
    const collapsed = this.collapsedObjects.has(obj.id);
    // A group root that has a parent means the parent is in another collection;
    // surface it as a subtle "↖ parent" hint rather than nesting cross-group.
    const crossParent = depth === 0 && obj.parentId !== null ? this.scene.parentOf(obj) : null;
    this.element.appendChild(
      this.makeRow(obj, collectionMember, depth, children.length > 0, collapsed, crossParent),
    );
    if (children.length > 0 && !collapsed) {
      for (const child of children) {
        this.renderSubtree(child, depth + 1, memberIds, collectionMember);
      }
    }
  }

  private makeRow(
    obj: SceneObject,
    collectionMember: boolean,
    depth: number,
    hasChildren: boolean,
    collapsed: boolean,
    crossParent: SceneObject | null,
  ): HTMLElement {
    const row = document.createElement('div');
    row.className = 'outliner-row';
    row.dataset.objId = String(obj.id);
    if (collectionMember) row.classList.add('outliner-indent');
    // 16px per hierarchy depth on top of the group's base indent.
    const base = collectionMember ? 22 : 8;
    row.style.paddingLeft = `${base + depth * 16}px`;
    if (this.scene.selection.has(obj.id)) row.classList.add('outliner-selected');
    if (this.scene.activeId === obj.id) row.classList.add('outliner-active');

    // Twisty for parents (collapse the subtree); a spacer keeps leaves aligned.
    const twisty = document.createElement('span');
    twisty.className = 'outliner-twisty';
    if (hasChildren) {
      twisty.textContent = collapsed ? '▸' : '▾';
      twisty.title = collapsed ? 'Expand' : 'Collapse';
      twisty.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.collapsedObjects.has(obj.id)) this.collapsedObjects.delete(obj.id);
        else this.collapsedObjects.add(obj.id);
        this.lastSig = '';
        this.update();
      });
    }
    row.appendChild(twisty);

    const glyph = document.createElement('span');
    glyph.className = 'outliner-glyph';
    glyph.textContent = '▲';
    row.appendChild(glyph);

    // Kind glyph (▢ mesh / 💡 light / 🎥 camera) — plain-text hint before the name.
    const kind = document.createElement('span');
    kind.className = 'outliner-kind';
    kind.textContent = KIND_GLYPH[obj.kind];
    row.appendChild(kind);

    const name = document.createElement('span');
    name.className = 'outliner-name';
    name.textContent = obj.name;
    row.appendChild(name);

    if (crossParent) {
      const hint = document.createElement('span');
      hint.className = 'outliner-parent-hint';
      hint.textContent = `↖ ${crossParent.name}`;
      hint.title = `Child of ${crossParent.name} (in another collection)`;
      row.appendChild(hint);
    }

    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'outliner-btn outliner-eye';
    eye.classList.toggle('outliner-hidden', !obj.visible);
    eye.textContent = obj.visible ? '\u{1F441}' : '–';
    eye.title = obj.visible ? 'Hide' : 'Show';
    row.appendChild(eye);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'outliner-btn outliner-del';
    del.textContent = '✕';
    del.title = 'Delete';
    row.appendChild(del);

    // Pointer-based drag-to-parent: start on a left press over the row body
    // (not the twisty or the eye/delete buttons).
    row.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const tgt = e.target as HTMLElement;
      if (tgt.closest('button') || tgt.classList.contains('outliner-twisty')) return;
      this.beginDrag(obj.id, e.clientX, e.clientY);
    });

    // Row selection. Shift toggles into/out of the selection.
    row.addEventListener('click', (e) => {
      if (e.shiftKey) this.scene.toggleSelect(obj.id);
      else this.scene.selectOnly(obj.id);
    });

    // Visibility toggle carries no undo (matches our scope). Stop propagation so
    // it doesn't also select the row.
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      obj.visible = !obj.visible;
    });

    del.addEventListener('click', (e) => {
      e.stopPropagation();
      this.undo.push(DeleteObjectsCommand.perform('Delete', this.scene, [obj.id]));
    });

    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.beginRename(obj, row, name);
    });

    return row;
  }

  // --- Drag-to-parent (pointer-based) ---------------------------------------

  private beginDrag(id: number, x: number, y: number): void {
    this.dragState = { id, startX: x, startY: y, active: false };
    document.addEventListener('mousemove', this.onDragMove);
    document.addEventListener('mouseup', this.onDragUp);
  }

  private readonly onDragMove = (e: MouseEvent): void => {
    const st = this.dragState;
    if (!st) return;
    if (!st.active) {
      if (Math.hypot(e.clientX - st.startX, e.clientY - st.startY) < 4) return;
      st.active = true;
      this.element.classList.add('outliner-dragging');
    }
    this.highlightDropTarget(e.clientX, e.clientY);
  };

  private readonly onDragUp = (e: MouseEvent): void => {
    const st = this.dragState;
    document.removeEventListener('mousemove', this.onDragMove);
    document.removeEventListener('mouseup', this.onDragUp);
    this.dragState = null;
    this.clearDropHighlight();
    this.element.classList.remove('outliner-dragging');
    if (!st || !st.active) return; // never crossed threshold — it was a click
    // Swallow the click the browser synthesizes from this press+release so the
    // drop doesn't also re-select. If performDrop re-renders (it usually does),
    // the press target is detached and no click fires — so clear the guard on
    // the next tick to avoid it leaking onto a later, unrelated click.
    this.suppressNextClick = true;
    setTimeout(() => { this.suppressNextClick = false; }, 0);
    this.performDrop(st.id, e.clientX, e.clientY);
  };

  /** Element under the pointer that a drop would act on: a row or a header. */
  private dropElementAt(x: number, y: number): HTMLElement | null {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!el || !this.element.contains(el)) return null;
    return (el.closest('.outliner-row') ?? el.closest('.outliner-collection-header')) as HTMLElement | null;
  }

  private highlightDropTarget(x: number, y: number): void {
    this.clearDropHighlight();
    const target = this.dropElementAt(x, y);
    // Don't highlight the dragged row itself.
    if (target && target.dataset.objId === String(this.dragState?.id)) return;
    target?.classList.add('outliner-drop-target');
  }

  private clearDropHighlight(): void {
    for (const el of this.element.querySelectorAll('.outliner-drop-target')) {
      el.classList.remove('outliner-drop-target');
    }
  }

  /**
   * Resolve the drop: onto an object row → parent the dragged set to it; onto a
   * collection header or empty space → clear the parent. If the dragged row was
   * part of the selection, the whole selection moves; otherwise just that row.
   */
  private performDrop(draggedId: number, x: number, y: number): void {
    const dragged = this.scene.get(draggedId);
    if (!dragged) return;

    const objects = this.scene.selection.has(draggedId)
      ? this.scene.selectedObjects
      : [dragged];

    const target = this.dropElementAt(x, y);
    const targetRow = target?.classList.contains('outliner-row') ? target : null;
    const parent = targetRow?.dataset.objId != null ? this.scene.get(Number(targetRow.dataset.objId)) ?? null : null;

    const cmd = parent
      ? SetParentCommand.perform('Parent', this.scene, objects, parent)
      : SetParentCommand.perform('Clear Parent', this.scene, objects, null);
    // A null command onto a real target means every entry was refused (cycle or
    // no-op). We have no status/toast access here, so silently no-op per spec.
    if (cmd) this.undo.push(cmd);
    this.lastSig = '';
    this.update();
  }

  /** Swap the name label for an inline <input>; commit on Enter/blur, revert on Escape. */
  private beginRename(obj: SceneObject, row: HTMLElement, name: HTMLElement): void {
    this.renamingId = obj.id;
    const before = obj.name;

    const input = document.createElement('input');
    input.className = 'outliner-name-input';
    input.type = 'text';
    input.value = before;
    row.replaceChild(input, name);
    input.focus();
    input.select();

    let done = false;
    const finish = (commit: boolean): void => {
      if (done) return;
      done = true;
      if (commit) {
        const after = input.value.trim();
        if (after && after !== before) {
          obj.name = after;
          this.undo.push(new RenameObjectCommand(obj, before, after));
        }
      }
      // Clear the guard and force a rebuild from current state.
      this.renamingId = null;
      this.lastSig = '';
      this.update();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  }

  /** Inline-rename a collection header (same pattern as object rename). */
  private beginRenameCollection(col: SceneCollection, row: HTMLElement, name: HTMLElement): void {
    this.renamingCollectionId = col.id;
    const before = col.name;

    const input = document.createElement('input');
    input.className = 'outliner-name-input';
    input.type = 'text';
    input.value = before;
    row.replaceChild(input, name);
    input.focus();
    input.select();

    let done = false;
    const finish = (commit: boolean): void => {
      if (done) return;
      done = true;
      if (commit) {
        const after = input.value.trim();
        if (after && after !== before) {
          col.name = after;
          this.undo.push(new RenameCollectionCommand(col, before, after));
        }
      }
      this.renamingCollectionId = null;
      this.lastSig = '';
      this.update();
    };

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  }
}
