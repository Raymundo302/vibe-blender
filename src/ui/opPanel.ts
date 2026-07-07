import './opPanel.css';
import type { SceneObject } from '../core/scene/Scene';
import type { PrimitiveDef, PrimParam } from '../core/mesh/primitives';

export interface OpPanelOptions {
  /** Positioned host — the panel pins to this element's bottom-left. */
  parent: HTMLElement;
  /** The primitive definition whose params drive the fields. */
  def: PrimitiveDef;
  /** The freshly-added object to regenerate in place. */
  obj: SceneObject;
  /** Fired exactly once when the panel tears down. */
  onClose: () => void;
}

/**
 * Blender's post-Add "Adjust Last Operation" redo panel. Mounted by AddMenu
 * after a primitive is added, it exposes one row per PrimParam. Editing a value
 * regenerates the mesh via `def.make(values)` and writes it back onto the SAME
 * object with `obj.mesh.copyFrom(...)` — no new undo entry is pushed, so the
 * whole tweak-then-add collapses to the single "Add <Name>" undo step (exactly
 * how Blender's F9 panel behaves: one Ctrl+Z removes the object entirely).
 *
 * It owns and removes all its own listeners. It dismisses on any pointerdown
 * outside the panel, any keydown outside the panel (operator keys G/R/S/Tab/
 * Shift+A…, Ctrl+Z), or Escape.
 */
export class OpPanel {
  private readonly root: HTMLDivElement;
  private readonly values: Record<string, number | boolean> = {};
  private closed = false;

  constructor(private readonly opts: OpPanelOptions) {
    for (const p of opts.def.params) this.values[p.key] = p.value;

    this.root = document.createElement('div');
    this.root.className = 'op-panel';

    const header = document.createElement('div');
    header.className = 'op-panel-header';
    const caret = document.createElement('span');
    caret.className = 'op-panel-caret';
    caret.textContent = '▾';
    const title = document.createElement('span');
    title.textContent = `Add ${opts.def.name}`;
    header.append(caret, title);
    header.addEventListener('click', () => this.root.classList.toggle('collapsed'));
    this.root.appendChild(header);

    const body = document.createElement('div');
    body.className = 'op-panel-body';
    for (const p of opts.def.params) body.appendChild(this.row(p));
    this.root.appendChild(body);

    opts.parent.appendChild(this.root);

    // Attach the dismissal listeners on the next tick so the pointer click that
    // spawned us (via the Add menu) doesn't immediately close the panel.
    setTimeout(() => {
      if (this.closed) return;
      window.addEventListener('pointerdown', this.onOutsidePointer, true);
      window.addEventListener('keydown', this.onKeyDown, true);
    }, 0);
  }

  private row(p: PrimParam): HTMLElement {
    const row = document.createElement('div');
    row.className = 'op-panel-row';
    const label = document.createElement('label');
    label.textContent = p.label;

    const input = document.createElement('input');
    input.dataset.param = p.key;
    if (p.kind === 'bool') {
      input.type = 'checkbox';
      input.checked = p.value as boolean;
      label.htmlFor = '';
      input.addEventListener('change', () => {
        this.values[p.key] = input.checked;
        this.regenerate();
      });
    } else {
      input.type = 'number';
      if (p.min !== undefined) input.min = String(p.min);
      if (p.max !== undefined) input.max = String(p.max);
      input.step = p.kind === 'int' ? '1' : String(p.step ?? 'any');
      input.value = String(p.value);
      input.addEventListener('input', () => {
        let v = Number(input.value);
        if (!Number.isFinite(v)) return; // mid-edit empty field — wait for a value
        if (p.kind === 'int') v = Math.round(v);
        if (p.min !== undefined) v = Math.max(p.min, v);
        if (p.max !== undefined) v = Math.min(p.max, v);
        this.values[p.key] = v;
        this.regenerate();
      });
    }

    row.append(label, input);
    return row;
  }

  /** Rebuild the object's mesh from the current values (mutates in place). */
  private regenerate(): void {
    const mesh = this.opts.def.make(this.values);
    this.opts.obj.mesh.copyFrom(mesh);
  }

  private readonly onOutsidePointer = (e: PointerEvent): void => {
    if (!this.root.contains(e.target as Node)) this.close();
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    // Escape always dismisses; other keys dismiss only when focus isn't in the
    // panel (so typing into a field doesn't tear it down). Never preventDefault
    // — the operator/undo key must still reach the InputManager.
    if (e.key === 'Escape' || !this.root.contains(e.target as Node)) this.close();
  };

  /** Idempotent teardown: removes the element and every listener exactly once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    window.removeEventListener('pointerdown', this.onOutsidePointer, true);
    window.removeEventListener('keydown', this.onKeyDown, true);
    this.root.remove();
    this.opts.onClose();
  }
}
