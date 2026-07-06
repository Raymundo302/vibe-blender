import type { Panel } from './panel';
import type { Scene, SceneObject } from '../core/scene/Scene';
import type { UndoStack } from '../core/undo/UndoStack';
import { DeleteObjectsCommand, RenameObjectCommand } from '../core/undo/objectCommands';

/**
 * Blender's Outliner: one row per scene object with select / rename / delete /
 * visibility. Owns its DOM; all styling lives in the shared theme.css (P1-7).
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
    // field mid-edit. The commit/cancel handlers clear renamingId and rebuild.
    if (this.renamingId !== null) return;
    const sig = this.signature();
    if (sig === this.lastSig) return;
    this.rebuild();
  }

  /** Cheap change signature: what the rows visibly depend on. */
  private signature(): string {
    const rows = this.scene.objects
      .map((o) => `${o.id}:${o.name}:${o.visible ? 1 : 0}`)
      .join('|');
    const sel = [...this.scene.selection].join(',');
    return `${rows}#${sel}#${this.scene.activeId}`;
  }

  private rebuild(): void {
    this.lastSig = this.signature();
    this.element.replaceChildren();

    if (this.scene.objects.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'outliner-empty';
      empty.textContent = 'No objects';
      this.element.appendChild(empty);
      return;
    }

    for (const obj of this.scene.objects) {
      this.element.appendChild(this.makeRow(obj));
    }
  }

  private makeRow(obj: SceneObject): HTMLElement {
    const row = document.createElement('div');
    row.className = 'outliner-row';
    if (this.scene.selection.has(obj.id)) row.classList.add('outliner-selected');
    if (this.scene.activeId === obj.id) row.classList.add('outliner-active');

    const glyph = document.createElement('span');
    glyph.className = 'outliner-glyph';
    glyph.textContent = '▲';
    row.appendChild(glyph);

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
}
