import type { Scene, SceneObject } from '../core/scene/Scene';
import type { UndoStack, Command } from '../core/undo/UndoStack';
import type { CameraData, GlareSettings } from '../core/scene/objectData';
import { cloneGlare, defaultGlare, clampFStop, F_STOP_MIN, F_STOP_MAX } from '../core/scene/objectData';
import { registerPropertiesTab } from './propertiesEditor';
import './cameraTab.css';

/**
 * Camera properties tab (P8-2) — Blender's camera-data panel (🎥). Edits the
 * ACTIVE object's CameraData live when that object is a camera; otherwise it
 * shows an empty state (mirroring the Object/Light/Modifier tabs). Cameras
 * already exist end-to-end (Shift+A → Add Camera, viewport icon + frustum,
 * click-select, Numpad0 view-through); this tab is purely the data UI.
 *
 * Each field commit pushes ONE undoable CameraCommand snapshotting the full
 * CameraData before/after, so undo restores the exact prior camera. The frustum
 * and the through-camera view react immediately because the renderer reads scene
 * state every frame (and the frustum VAO rebuilds when focalLength changes).
 *
 * "Set Active" changes scene.activeCameraId through its own undoable command.
 * Registered at module load like the other tabs; main.ts imports this file once.
 */

// --- Pure helpers (unit-tested indirectly via objectData / cameraFrustum) -----

/** Clone of CameraData. All fields are primitives EXCEPT `glare` (UR10-2), which
 *  is deep-copied so the undo before/after snapshots never share a reference. */
export function cloneCamera(c: CameraData): CameraData {
  return { ...c, glare: c.glare ? cloneGlare(c.glare) : undefined };
}

// --- Undo commands ------------------------------------------------------------

/**
 * One undoable edit to an object's CameraData. Snapshots the full payload
 * before/after so undo/redo restore focal length, near and far regardless of
 * which field changed. Assigns a fresh clone each direction so the live object
 * never shares a reference with the snapshots.
 */
export class CameraCommand implements Command {
  private constructor(
    readonly name: string,
    private readonly obj: SceneObject,
    private readonly before: CameraData,
    private readonly after: CameraData,
  ) {}

  /** Snapshot obj.camera, run mutate() against the live payload, snapshot again. */
  static capture(name: string, obj: SceneObject, mutate: (c: CameraData) => void): CameraCommand {
    const cam = obj.camera;
    if (!cam) throw new Error('CameraCommand.capture: object has no camera');
    const before = cloneCamera(cam);
    mutate(cam);
    const after = cloneCamera(cam);
    return new CameraCommand(name, obj, before, after);
  }

  undo(): void {
    this.obj.camera = cloneCamera(this.before);
  }

  redo(): void {
    this.obj.camera = cloneCamera(this.after);
  }
}

/** One undoable change of the scene's active camera. */
export class SetActiveCameraCommand implements Command {
  readonly name = 'Set Active Camera';
  constructor(
    private readonly scene: Scene,
    private readonly before: number | null,
    private readonly after: number | null,
  ) {}

  undo(): void {
    this.scene.activeCameraId = this.before;
  }

  redo(): void {
    this.scene.activeCameraId = this.after;
  }
}

// --- Tab ---------------------------------------------------------------------

class CameraTab {
  private readonly empty: HTMLDivElement;
  private readonly body: HTMLDivElement;
  /** Scene-level Format (output resolution) — always visible, independent of
   *  whether a camera is selected (UR5-5). */
  private readonly focalInput: HTMLInputElement;
  private readonly nearInput: HTMLInputElement;
  private readonly farInput: HTMLInputElement;
  private readonly lockInput: HTMLInputElement;
  /** DoF (UR10-2 Part C): enable checkbox + F-Stop numeric. */
  private readonly dofInput: HTMLInputElement;
  private readonly fStopInput: HTMLInputElement;
  /** Glare (UR10-2 Part B): enable checkbox + 3 numerics. */
  private readonly glareInput: HTMLInputElement;
  private readonly glareThresholdInput: HTMLInputElement;
  private readonly glareStrengthInput: HTMLInputElement;
  private readonly glareRadiusInput: HTMLInputElement;
  private readonly focusSelect: HTMLSelectElement;
  private readonly lookAtSelect: HTMLSelectElement;
  private readonly lookAtWarning: HTMLDivElement;
  private readonly activeBtn: HTMLButtonElement;
  private readonly activeBadge: HTMLSpanElement;
  /** Signature of the last-built picker option list, to skip needless rebuilds. */
  private pickerSig = '';

  constructor(
    container: HTMLElement,
    private readonly scene: Scene,
    private readonly undo: UndoStack,
  ) {
    this.empty = document.createElement('div');
    this.empty.className = 'properties-empty';
    this.empty.textContent = 'No camera selected';

    this.body = document.createElement('div');
    this.body.className = 'properties-body';

    // Format pointer (UR16-3) — the output resolution MOVED to Properties ▸ Render
    // (still scene.renderSettings). The Camera tab keeps a one-line pointer so the
    // control is discoverable where it used to live.
    const format = document.createElement('div');
    format.className = 'properties-body camera-tab-format';
    const formatTitle = document.createElement('div');
    formatTitle.className = 'properties-group-title camera-tab-format-title';
    formatTitle.textContent = 'Format';
    format.append(formatTitle);
    const formatPointer = document.createElement('div');
    formatPointer.className = 'camera-tab-format-pointer';
    formatPointer.dataset.field = 'resolution-pointer';
    formatPointer.textContent = 'Resolution → Properties ▸ Render';
    format.append(formatPointer);

    // Focal length (mm, 1..300) ---------------------------------------------
    this.focalInput = this.numberInput('focal', 1, 300, 1);
    this.focalInput.addEventListener('change', () => {
      const raw = parseFloat(this.focalInput.value);
      if (!Number.isFinite(raw)) return this.refresh();
      const focal = Math.max(1, Math.min(300, raw));
      this.commit('Set Focal Length', (c) => { c.focalLength = focal; });
    });
    this.body.append(this.labelledRow('Focal (mm)', this.focalInput));

    // Clip start / end -------------------------------------------------------
    this.nearInput = this.numberInput('near', 0.001, undefined, 0.01);
    this.nearInput.addEventListener('change', () => {
      const obj = this.activeCamera();
      const raw = parseFloat(this.nearInput.value);
      if (!obj || !obj.camera || !Number.isFinite(raw) || raw <= 0 || raw >= obj.camera.far) {
        return this.refresh();
      }
      this.commit('Set Clip Start', (c) => { c.near = raw; });
    });
    this.body.append(this.labelledRow('Clip Start', this.nearInput));

    this.farInput = this.numberInput('far', 0.002, undefined, 1);
    this.farInput.addEventListener('change', () => {
      const obj = this.activeCamera();
      const raw = parseFloat(this.farInput.value);
      if (!obj || !obj.camera || !Number.isFinite(raw) || raw <= obj.camera.near) {
        return this.refresh();
      }
      this.commit('Set Clip End', (c) => { c.far = raw; });
    });
    this.body.append(this.labelledRow('Clip End', this.farInput));

    // Lock Camera to View ----------------------------------------------------
    // When on, navigating the viewport while looking through this camera (Numpad0)
    // moves the camera instead of exiting the view (see InputManager rig).
    this.lockInput = document.createElement('input');
    this.lockInput.type = 'checkbox';
    this.lockInput.className = 'camera-tab-lock';
    this.lockInput.dataset.field = 'lockToView';
    this.lockInput.addEventListener('change', () => {
      const on = this.lockInput.checked;
      this.commit('Lock Camera to View', (c) => { c.lockToView = on; });
    });
    const lockRow = document.createElement('label');
    lockRow.className = 'camera-tab-row camera-tab-lock-row';
    const lockLabel = document.createElement('span');
    lockLabel.className = 'properties-group-title camera-tab-label';
    lockLabel.textContent = 'Lock to View';
    lockLabel.style.marginBottom = '0';
    lockRow.append(lockLabel, this.lockInput);
    this.body.append(lockRow);

    // Depth of Field (UR10-2 Part C) — enable + F-Stop. F-Stop replaces the raw
    // aperture UI: smaller = wider aperture = blurrier. aperture 0 ⇔ DoF off.
    const dofTitle = document.createElement('div');
    dofTitle.className = 'properties-group-title';
    dofTitle.textContent = 'Depth of Field';
    this.body.append(dofTitle);

    this.dofInput = document.createElement('input');
    this.dofInput.type = 'checkbox';
    this.dofInput.className = 'camera-tab-dof';
    this.dofInput.dataset.field = 'dof';
    this.dofInput.addEventListener('change', () => {
      const on = this.dofInput.checked;
      this.commit('Toggle Depth of Field', (c) => { c.dof = on; });
    });
    const dofRow = document.createElement('label');
    dofRow.className = 'camera-tab-row camera-tab-lock-row';
    const dofLabel = document.createElement('span');
    dofLabel.className = 'properties-group-title camera-tab-label';
    dofLabel.textContent = 'Enable';
    dofLabel.style.marginBottom = '0';
    dofRow.append(dofLabel, this.dofInput);
    this.body.append(dofRow);

    this.fStopInput = this.numberInput('fStop', F_STOP_MIN, F_STOP_MAX, 0.1);
    this.fStopInput.title = 'Lens f-stop — smaller = wider aperture = blurrier depth of field';
    this.fStopInput.addEventListener('change', () => {
      const raw = parseFloat(this.fStopInput.value);
      if (!Number.isFinite(raw)) return this.refresh();
      const f = clampFStop(raw);
      this.commit('Set F-Stop', (c) => { c.fStop = f; });
    });
    this.body.append(this.labelledRow('F-Stop', this.fStopInput));

    // Glare / bloom (UR10-2 Part B) — enable + threshold/strength/radius.
    const glareTitle = document.createElement('div');
    glareTitle.className = 'properties-group-title';
    glareTitle.textContent = 'Glare';
    this.body.append(glareTitle);

    this.glareInput = document.createElement('input');
    this.glareInput.type = 'checkbox';
    this.glareInput.className = 'camera-tab-glare';
    this.glareInput.dataset.field = 'glareEnabled';
    this.glareInput.addEventListener('change', () => {
      const on = this.glareInput.checked;
      this.commit('Toggle Glare', (c) => { this.ensureGlare(c).enabled = on; });
    });
    const glareRow = document.createElement('label');
    glareRow.className = 'camera-tab-row camera-tab-lock-row';
    const glareLabel = document.createElement('span');
    glareLabel.className = 'properties-group-title camera-tab-label';
    glareLabel.textContent = 'Enable';
    glareLabel.style.marginBottom = '0';
    glareRow.append(glareLabel, this.glareInput);
    this.body.append(glareRow);

    this.glareThresholdInput = this.numberInput('glareThreshold', 0, undefined, 0.05);
    this.glareThresholdInput.title = 'Luminance above which pixels bloom';
    this.glareThresholdInput.addEventListener('change', () => this.commitGlareNum('threshold', this.glareThresholdInput, 0));
    this.body.append(this.labelledRow('Threshold', this.glareThresholdInput));

    this.glareStrengthInput = this.numberInput('glareStrength', 0, undefined, 0.05);
    this.glareStrengthInput.title = 'Bloom intensity added back';
    this.glareStrengthInput.addEventListener('change', () => this.commitGlareNum('strength', this.glareStrengthInput, 0));
    this.body.append(this.labelledRow('Strength', this.glareStrengthInput));

    this.glareRadiusInput = this.numberInput('glareRadius', 0, 1, 0.01);
    this.glareRadiusInput.title = 'Blur radius as a fraction of image height';
    this.glareRadiusInput.addEventListener('change', () => this.commitGlareNum('radius', this.glareRadiusInput, 0));
    this.body.append(this.labelledRow('Radius', this.glareRadiusInput));

    // Focus Object (DoF) + Look At (orientation) object pickers (UR5-7) --------
    // Dropdowns of None + every OTHER scene object by name. Value is the object
    // id (-1 = None). Options rebuild via a signature diff in update(). Edits go
    // through the same undoable CameraCommand path as the numeric fields.
    this.focusSelect = this.objectSelect('focusObject');
    this.focusSelect.addEventListener('change', () => {
      const id = parseInt(this.focusSelect.value, 10);
      this.commit('Set Focus Object', (c) => { c.focusObjectId = id < 0 ? undefined : id; });
    });
    this.body.append(this.labelledRow('Focus Object', this.focusSelect));

    this.lookAtSelect = this.objectSelect('lookAt');
    this.lookAtSelect.addEventListener('change', () => {
      const id = parseInt(this.lookAtSelect.value, 10);
      this.commit('Set Look At', (c) => { c.lookAtId = id < 0 ? undefined : id; });
    });
    this.body.append(this.labelledRow('Look At', this.lookAtSelect));

    // Warning line: shown when Look At targets a descendant of the camera (the
    // lookAt is ignored to avoid world-matrix recursion — see Scene).
    this.lookAtWarning = document.createElement('div');
    this.lookAtWarning.className = 'camera-tab-warning';
    this.lookAtWarning.dataset.warning = 'lookat-cycle';
    this.lookAtWarning.textContent = '⚠ Look At target is a child of this camera — ignored.';
    this.lookAtWarning.style.display = 'none';
    this.body.append(this.lookAtWarning);

    // Set Active + indicator -------------------------------------------------
    const activeRow = document.createElement('div');
    activeRow.className = 'camera-tab-active';
    this.activeBtn = document.createElement('button');
    this.activeBtn.type = 'button';
    this.activeBtn.className = 'camera-tab-active-btn';
    this.activeBtn.dataset.action = 'set-active-camera';
    this.activeBtn.textContent = 'Set Active';
    this.activeBtn.addEventListener('click', () => this.setActive());
    this.activeBadge = document.createElement('span');
    this.activeBadge.className = 'camera-tab-active-badge';
    this.activeBadge.textContent = 'Active ✓';
    activeRow.append(this.activeBtn, this.activeBadge);
    this.body.append(activeRow);

    container.append(format, this.empty, this.body);
    this.update();
  }

  private numberInput(field: string, min?: number, max?: number, step?: number): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'camera-tab-input';
    input.dataset.field = field;
    if (min !== undefined) input.min = String(min);
    if (max !== undefined) input.max = String(max);
    if (step !== undefined) input.step = String(step);
    return input;
  }

  /** A bare object-picker <select> (options filled by refreshPickers). */
  private objectSelect(field: string): HTMLSelectElement {
    const select = document.createElement('select');
    select.className = 'camera-tab-select';
    select.dataset.field = field;
    return select;
  }

  /**
   * (Re)build the Focus Object / Look At option lists (None + every other scene
   * object by name) when the scene composition or the camera's own refs change,
   * and set each select's value to the camera's current ref (falling back to
   * None for a stale/deleted target — the defensive-unset behavior). Skips the
   * rebuild while the signature is unchanged so an open dropdown isn't clobbered.
   */
  private refreshPickers(cam: SceneObject): void {
    const others = this.scene.objects.filter((o) => o.id !== cam.id);
    const c = cam.camera!;
    const sig = `${others.map((o) => `${o.id}:${o.name}`).join('|')}#${c.focusObjectId ?? -1}#${c.lookAtId ?? -1}`;
    if (sig === this.pickerSig && !this.isPanelFocused()) {
      // Composition unchanged — nothing to do.
      return;
    }
    this.pickerSig = sig;
    for (const [select, current] of [
      [this.focusSelect, c.focusObjectId],
      [this.lookAtSelect, c.lookAtId],
    ] as const) {
      select.textContent = '';
      const none = document.createElement('option');
      none.value = '-1';
      none.textContent = '(None)';
      select.append(none);
      for (const o of others) {
        const opt = document.createElement('option');
        opt.value = String(o.id);
        opt.textContent = o.name;
        select.append(opt);
      }
      select.value = String(current ?? -1);
      if (select.selectedIndex < 0) select.value = '-1'; // stale/deleted → None
    }
  }

  private labelledRow(text: string, control: HTMLElement): HTMLElement {
    const row = document.createElement('label');
    row.className = 'camera-tab-row';
    const label = document.createElement('span');
    label.className = 'properties-group-title camera-tab-label';
    label.textContent = text;
    label.style.marginBottom = '0';
    row.append(label, control);
    return row;
  }

  /** The active object iff it is a camera with a payload, else null. */
  private activeCamera(): SceneObject | null {
    const obj = this.scene.activeObject;
    return obj && obj.kind === 'camera' && obj.camera ? obj : null;
  }

  update(): void {
    const obj = this.activeCamera();
    if (!obj || !obj.camera) {
      this.empty.style.display = '';
      this.body.style.display = 'none';
      return;
    }
    this.empty.style.display = 'none';
    this.body.style.display = '';

    // The active-state controls can always follow the model — they steal no focus.
    const isActive = this.scene.activeCameraId === obj.id;
    this.activeBtn.disabled = isActive;
    this.activeBadge.hidden = !isActive;

    // Object pickers + cyclic-lookAt warning always track the model (selects
    // steal no text focus; the signature diff avoids clobbering an open dropdown).
    this.refreshPickers(obj);
    this.lookAtWarning.style.display = this.scene.cameraLookAtIsCyclic(obj) ? '' : 'none';

    // Never overwrite a field the user is mid-edit in (matches the Light tab).
    if (this.isPanelFocused()) return;
    this.writeFields(obj.camera);
  }

  /** Get-or-create the camera's glare payload (first edit lazily materializes it
   *  with defaults, so pre-UR10-2 cameras stay glare-free until touched). */
  private ensureGlare(c: CameraData): GlareSettings {
    if (!c.glare) c.glare = defaultGlare();
    return c.glare;
  }

  /** Commit one glare numeric field (clamped ≥ min) via the undoable command. */
  private commitGlareNum(field: 'threshold' | 'strength' | 'radius', input: HTMLInputElement, min: number): void {
    const raw = parseFloat(input.value);
    if (!Number.isFinite(raw)) return this.refresh();
    const v = Math.max(min, raw);
    this.commit(`Set Glare ${field}`, (c) => { this.ensureGlare(c)[field] = v; });
  }

  private writeFields(c: CameraData): void {
    const focal = String(round(c.focalLength));
    if (this.focalInput.value !== focal) this.focalInput.value = focal;
    const near = String(round(c.near));
    if (this.nearInput.value !== near) this.nearInput.value = near;
    const far = String(round(c.far));
    if (this.farInput.value !== far) this.farInput.value = far;
    const lock = !!c.lockToView;
    if (this.lockInput.checked !== lock) this.lockInput.checked = lock;
    // DoF (UR10-2 Part C).
    const dof = !!c.dof;
    if (this.dofInput.checked !== dof) this.dofInput.checked = dof;
    const fStop = String(round(c.fStop ?? 2.8));
    if (this.fStopInput.value !== fStop) this.fStopInput.value = fStop;
    // Glare (UR10-2 Part B) — reflect current or default values.
    const g = c.glare ?? defaultGlare();
    if (this.glareInput.checked !== g.enabled) this.glareInput.checked = g.enabled;
    const thr = String(round(g.threshold));
    if (this.glareThresholdInput.value !== thr) this.glareThresholdInput.value = thr;
    const str = String(round(g.strength));
    if (this.glareStrengthInput.value !== str) this.glareStrengthInput.value = str;
    const rad = String(round(g.radius));
    if (this.glareRadiusInput.value !== rad) this.glareRadiusInput.value = rad;
  }

  private isPanelFocused(): boolean {
    const active = document.activeElement;
    return active instanceof HTMLInputElement && this.body.contains(active);
  }

  /** Push one undoable CameraCommand for the active camera, then refresh visuals. */
  private commit(name: string, mutate: (c: CameraData) => void): void {
    const obj = this.activeCamera();
    if (!obj) return;
    this.undo.push(CameraCommand.capture(name, obj, mutate));
    this.refresh();
  }

  /** Make the active camera the scene's active camera (undoable). */
  private setActive(): void {
    const obj = this.activeCamera();
    if (!obj) return;
    const before = this.scene.activeCameraId;
    if (before === obj.id) return;
    this.scene.activeCameraId = obj.id;
    this.undo.push(new SetActiveCameraCommand(this.scene, before, obj.id));
  }

  /** Force field values back in sync with the model (after commit / bad input). */
  private refresh(): void {
    const obj = this.activeCamera();
    if (obj && obj.camera) this.writeFields(obj.camera);
  }
}

/** Round to `decimals` places, trimming float noise for display. */
function round(n: number, decimals = 3): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

// Registered at module load so any PropertiesEditor built afterward includes it.
registerPropertiesTab({
  id: 'camera',
  icon: '🎥',
  title: 'Camera',
  build: (container, ctx) => new CameraTab(container, ctx.scene, ctx.undo),
});
