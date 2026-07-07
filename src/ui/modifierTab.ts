import type { Scene, SceneObject } from '../core/scene/Scene';
import type { UndoStack } from '../core/undo/UndoStack';
import {
  createModifier,
  modifierTypes,
  type Modifier,
  type ModifierField,
} from '../core/modifiers/Modifier';
import { ModifierStackCommand, ApplyModifierCommand } from '../core/undo/modifierCommands';
import { registerPropertiesTab } from './propertiesEditor';

/**
 * Modifiers tab (Phase 4, P4-4) — Blender's wrench panel. Lists the active
 * object's modifier stack top-to-bottom (evaluation order), with per-entry
 * name/enable/reorder/remove/apply controls and a generic param UI driven by
 * each modifier's fields(). Every stack mutation goes through
 * ModifierStackCommand.capture (Apply through ApplyModifierCommand) so the whole
 * panel is undoable.
 *
 * Registered at module load, mirroring the Object tab — main.ts imports this
 * file once for the side effect. The tab knows nothing about concrete modifier
 * types: the dropdown comes from modifierTypes(), the params from fields().
 */

class ModifierTab {
  private readonly noObject: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly addSelect: HTMLSelectElement;
  private readonly stackEl: HTMLDivElement;

  /** `${activeId}:${modifiersVersion}` last rendered; null forces a rebuild. */
  private lastSig: string | null = null;

  constructor(
    container: HTMLElement,
    private readonly scene: Scene,
    private readonly undo: UndoStack,
  ) {
    this.noObject = document.createElement('div');
    this.noObject.className = 'properties-empty';
    this.noObject.textContent = 'No active object';

    this.body = document.createElement('div');
    this.body.className = 'properties-body';

    // Add-modifier dropdown: a disabled placeholder first, then one option per
    // registered modifier type. Choosing one adds it and snaps back to the
    // placeholder. Built once — the registry is static after module load.
    const addRow = document.createElement('div');
    addRow.className = 'modifier-add-row';
    addRow.style.marginBottom = '8px';
    this.addSelect = document.createElement('select');
    this.addSelect.className = 'modifier-add-select';
    this.addSelect.style.width = '100%';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Add Modifier';
    this.addSelect.append(placeholder);
    for (const { type, label } of modifierTypes()) {
      const opt = document.createElement('option');
      opt.value = type;
      opt.textContent = label;
      this.addSelect.append(opt);
    }
    this.addSelect.addEventListener('change', () => this.onAdd());
    addRow.append(this.addSelect);
    this.body.append(addRow);

    this.stackEl = document.createElement('div');
    this.stackEl.className = 'modifier-stack';
    this.body.append(this.stackEl);

    container.append(this.noObject, this.body);
    this.update();
  }

  update(): void {
    const obj = this.scene.activeObject;
    if (!obj) {
      this.noObject.style.display = '';
      this.body.style.display = 'none';
      this.lastSig = null; // rebuild once an object becomes active again
      return;
    }
    this.noObject.style.display = 'none';
    this.body.style.display = '';

    const sig = `${obj.id}:${obj.modifiersVersion}`;
    if (sig === this.lastSig) return;
    // Never yank focus out from under an in-progress edit — defer the rebuild
    // (keeping lastSig stale) until the user leaves the field. The committed
    // value is already correct in the DOM, so nothing looks out of date.
    if (this.isPanelFocused()) return;
    this.lastSig = sig;
    this.rebuild(obj);
  }

  private isPanelFocused(): boolean {
    const active = document.activeElement;
    return (
      (active instanceof HTMLInputElement || active instanceof HTMLSelectElement) &&
      this.stackEl.contains(active)
    );
  }

  /** Push one stack-mutation command through the standard capture helper. */
  private capture(name: string, obj: SceneObject, mutate: () => void): void {
    this.undo.push(ModifierStackCommand.capture(name, obj, mutate));
  }

  private onAdd(): void {
    const type = this.addSelect.value;
    this.addSelect.value = ''; // back to the placeholder regardless
    if (!type) return;
    const obj = this.scene.activeObject;
    if (!obj) return;
    this.capture('Add Modifier', obj, () => obj.modifiers.push(createModifier(type)));
  }

  private rebuild(obj: SceneObject): void {
    this.stackEl.replaceChildren();
    if (obj.modifiers.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'properties-empty';
      hint.textContent = 'No modifiers';
      this.stackEl.append(hint);
      return;
    }
    obj.modifiers.forEach((mod, i) => {
      this.stackEl.append(this.buildEntry(obj, mod, i));
    });
  }

  private buildEntry(obj: SceneObject, mod: Modifier, index: number): HTMLElement {
    const last = obj.modifiers.length - 1;
    const entry = document.createElement('div');
    entry.className = 'modifier-entry properties-group';
    entry.dataset.index = String(index);

    const head = document.createElement('div');
    head.className = 'modifier-head';
    head.style.display = 'flex';
    head.style.alignItems = 'center';
    head.style.gap = '4px';
    head.style.marginBottom = '4px';

    const enable = document.createElement('input');
    enable.type = 'checkbox';
    enable.className = 'modifier-enable';
    enable.checked = mod.enabled;
    enable.title = 'Enabled';
    enable.style.flex = 'none';
    enable.addEventListener('change', () => {
      this.capture('Toggle Modifier', obj, () => { mod.enabled = enable.checked; });
    });

    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'modifier-name properties-name-input';
    name.value = mod.name;
    name.style.flex = '1';
    name.style.minWidth = '0';
    name.addEventListener('change', () => {
      const next = name.value.trim();
      if (!next || next === mod.name) { name.value = mod.name; return; }
      this.capture('Rename Modifier', obj, () => { mod.name = next; });
    });
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); name.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); name.value = mod.name; name.blur(); }
    });

    const up = this.iconBtn('▲', 'Move up', index === 0, () => {
      this.capture('Reorder Modifier', obj, () => {
        const m = obj.modifiers;
        [m[index - 1], m[index]] = [m[index], m[index - 1]];
      });
    });
    const down = this.iconBtn('▼', 'Move down', index === last, () => {
      this.capture('Reorder Modifier', obj, () => {
        const m = obj.modifiers;
        [m[index + 1], m[index]] = [m[index], m[index + 1]];
      });
    });
    const apply = this.iconBtn('Apply', 'Apply modifier to base mesh', index !== 0, () => {
      this.undo.push(new ApplyModifierCommand(obj, mod));
    });
    apply.classList.add('modifier-apply');
    apply.style.width = 'auto';
    const remove = this.iconBtn('✕', 'Remove', false, () => {
      this.capture('Remove Modifier', obj, () => { obj.modifiers.splice(index, 1); });
    });

    head.append(enable, name, up, down, apply, remove);
    entry.append(head);

    for (const field of mod.fields()) {
      entry.append(this.buildField(obj, mod, field));
    }
    return entry;
  }

  private iconBtn(text: string, title: string, disabled: boolean, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'modifier-btn';
    btn.textContent = text;
    btn.title = title;
    btn.disabled = disabled;
    btn.style.flex = 'none';
    btn.style.cursor = disabled ? 'default' : 'pointer';
    btn.addEventListener('click', () => { if (!btn.disabled) onClick(); });
    return btn;
  }

  /** One generic param row, rendered from a ModifierField descriptor. */
  private buildField(obj: SceneObject, mod: Modifier, field: ModifierField): HTMLElement {
    const row = document.createElement('label');
    row.className = 'modifier-field';
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '4px';
    row.style.marginTop = '3px';

    const label = document.createElement('span');
    label.className = 'properties-group-title';
    label.textContent = field.label;
    label.style.flex = '1';
    label.style.marginBottom = '0';
    row.append(label);

    const current = mod.params()[field.key];

    const commit = (name: string, value: number | boolean | string): void => {
      this.capture(name, obj, () => mod.setParam(field.key, value));
    };

    if (field.kind === 'bool') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'modifier-param';
      input.dataset.key = field.key;
      input.style.flex = 'none';
      input.checked = current === true;
      input.addEventListener('change', () => commit('Edit Modifier', input.checked));
      row.append(input);
    } else if (field.kind === 'object') {
      // Dropdown of the scene's OTHER mesh objects; value is the object id,
      // -1 = none. Options rebuild on every tab refresh (buildField is called
      // from the signature-diffed update path, so scene changes reach it).
      const select = document.createElement('select');
      select.className = 'modifier-param';
      select.dataset.key = field.key;
      const none = document.createElement('option');
      none.value = '-1';
      none.textContent = '(None)';
      select.append(none);
      for (const other of this.scene.objects) {
        if (other.id === obj.id || other.kind !== 'mesh') continue;
        const opt = document.createElement('option');
        opt.value = String(other.id);
        opt.textContent = other.name;
        select.append(opt);
      }
      select.value = String(typeof current === 'number' ? current : -1);
      if (select.selectedIndex < 0) select.value = '-1'; // target was deleted
      select.addEventListener('change', () => commit('Edit Modifier', parseInt(select.value, 10)));
      row.append(select);
    } else if (field.kind === 'axis') {
      const select = document.createElement('select');
      select.className = 'modifier-param';
      select.dataset.key = field.key;
      for (const axis of ['x', 'y', 'z'] as const) {
        const opt = document.createElement('option');
        opt.value = axis;
        opt.textContent = axis.toUpperCase();
        select.append(opt);
      }
      select.value = typeof current === 'string' ? current : 'x';
      select.addEventListener('change', () => commit('Edit Modifier', select.value));
      row.append(select);
    } else {
      // number | int
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'modifier-param properties-input';
      input.dataset.key = field.key;
      input.style.width = '70px';
      input.style.flex = 'none';
      const step = field.step ?? (field.kind === 'int' ? 1 : 0.1);
      input.step = String(step);
      if (field.min !== undefined) input.min = String(field.min);
      if (field.max !== undefined) input.max = String(field.max);
      input.value = String(typeof current === 'number' ? current : 0);
      input.addEventListener('change', () => {
        const raw = parseFloat(input.value);
        if (!Number.isFinite(raw)) { input.value = String(mod.params()[field.key]); return; }
        const value = field.kind === 'int' ? Math.round(raw) : raw;
        commit('Edit Modifier', value);
      });
      row.append(input);
    }
    return row;
  }
}

// Registered at module load so any PropertiesEditor built afterward includes it.
registerPropertiesTab({
  id: 'modifier',
  icon: '🔧',
  title: 'Modifiers',
  build: (container, ctx) => new ModifierTab(container, ctx.scene, ctx.undo),
});
