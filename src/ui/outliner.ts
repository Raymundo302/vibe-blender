import type { Panel } from './panel';
import type { Scene, SceneObject, SceneCollection } from '../core/scene/Scene';
import type { ObjectKind } from '../core/scene/objectData';
import type { UndoStack } from '../core/undo/UndoStack';
import { DeleteObjectsCommand, RenameObjectCommand } from '../core/undo/objectCommands';
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

  constructor(
    private readonly scene: Scene,
    private readonly undo: UndoStack,
  ) {
    this.element = document.createElement('div');
    this.element.className = 'outliner-list';
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
      .map((o) => `${o.id}:${o.name}:${o.visible ? 1 : 0}:${o.collectionId ?? -1}`)
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

    // Collections first (Blender order), each with its indented members.
    for (const col of this.scene.collections) {
      this.element.appendChild(this.makeCollectionHeader(col));
      if (!this.collapsed.has(col.id)) {
        for (const obj of this.scene.objects) {
          if (obj.collectionId === col.id) this.element.appendChild(this.makeRow(obj, true));
        }
      }
    }

    // Scene-root objects (no collection) after the collections.
    const rootObjects = this.scene.objects.filter((o) => o.collectionId === null);
    for (const obj of rootObjects) this.element.appendChild(this.makeRow(obj, false));

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

  private makeRow(obj: SceneObject, indented: boolean): HTMLElement {
    const row = document.createElement('div');
    row.className = 'outliner-row';
    if (indented) row.classList.add('outliner-indent');
    if (this.scene.selection.has(obj.id)) row.classList.add('outliner-selected');
    if (this.scene.activeId === obj.id) row.classList.add('outliner-active');

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
