import type { Scene, SceneObject } from '../core/scene/Scene';
import type { UndoStack, Command } from '../core/undo/UndoStack';
import type { CameraData } from '../core/scene/objectData';
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

/** Shallow clone of CameraData (all fields are primitives). */
export function cloneCamera(c: CameraData): CameraData {
  return { ...c };
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
  private readonly focalInput: HTMLInputElement;
  private readonly nearInput: HTMLInputElement;
  private readonly farInput: HTMLInputElement;
  private readonly lockInput: HTMLInputElement;
  private readonly activeBtn: HTMLButtonElement;
  private readonly activeBadge: HTMLSpanElement;

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

    container.append(this.empty, this.body);
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

    // Never overwrite a field the user is mid-edit in (matches the Light tab).
    if (this.isPanelFocused()) return;
    this.writeFields(obj.camera);
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
