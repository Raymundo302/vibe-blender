import type { Scene, SceneObject } from '../core/scene/Scene';
import type { UndoStack } from '../core/undo/UndoStack';
import { PRIMITIVES, type PrimitiveDef } from '../core/mesh/primitives';
import { AddObjectsCommand } from '../core/undo/objectCommands';
import { CAMERA_SPAWN_ROTATION, type LightType } from '../core/scene/objectData';
import { curvePreset, type CurvePreset } from '../core/curve/presets';
import { pickImagePlane, type ImagePlaneMode } from '../tools/imagePlane';
import { regenerateTextMesh } from '../tools/textObject';
import { WebAddDialog } from './webAddDialog';
import { OpPanel } from './opPanel';

/**
 * The redo panel for the LATEST add, if any. Module-level so a new add (or a
 * non-mesh add) dismisses the previous panel — only one is ever on screen.
 */
let activeOpPanel: OpPanel | null = null;

const LIGHTS: { name: string; type: LightType }[] = [
  { name: 'Point', type: 'point' },
  { name: 'Sun', type: 'sun' },
  { name: 'Spot', type: 'spot' },
  { name: 'Area', type: 'area' },
];

/** How long the flyout lingers after the pointer leaves it (gap-forgiveness). */
const FLYOUT_CLOSE_DELAY_MS = 150;

/** Everything the popup needs; kept free of InputManager internals. */
export interface AddMenuOptions {
  /** Positioned host — the pointer coords are relative to this element. */
  parent: HTMLElement;
  /** Pointer position (parent-local CSS px) where the menu should appear. */
  x: number;
  y: number;
  scene: Scene;
  undo: UndoStack;
  setStatus: (text: string) => void;
  /** Fired exactly once when the menu tears down (so the owner drops its ref). */
  onClose: () => void;
}

/**
 * Blender's Shift-A "Add" popup. A self-contained DOM widget: it owns its
 * element and all listeners, and removes every one of them on close so the
 * InputManager never has to. All styling lives in the shared theme.css (P1-7).
 *
 * UR3-4: the root shows CATEGORY rows — **Mesh ▸**, **Light ▸**, **Camera** —
 * and hovering a category pops its items out in a submenu to the RIGHT of the
 * row (Blender-style). Camera is a direct item (single entry). The flyout is a
 * child of `root`, so `onOutsidePointer` still treats it as "inside".
 */
export class AddMenu {
  private readonly root: HTMLDivElement;
  private closed = false;

  /** The one flyout currently on screen (only ever one), and which category. */
  private flyout: HTMLDivElement | null = null;
  private flyoutCategory: string | null = null;
  /** Pending delayed-close so a pointer can cross the row→flyout gap.  */
  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: AddMenuOptions) {
    this.root = document.createElement('div');
    this.root.className = 'add-menu';

    // Root rows: two category flyouts + one direct item.
    this.category('Mesh', () =>
      PRIMITIVES.map((def) => ({ label: def.name, run: () => this.addPrimitive(def) })));
    this.category('Light', () =>
      LIGHTS.map(({ name, type }) => ({
        label: name,
        run: () => this.commitAdd(name, this.opts.scene.addLight(name, type)),
      })));
    // Image ▸ (UR4-3): each item opens a file picker; the chosen image becomes a
    // textured plane. Diffuse = lit, Emit = shadeless (renders exactly as the
    // image looks). UR7-3: ONE "HTML / Website…" item opens a dialog — Load an
    // address (live iframe portal) or Open… a local .html file (UR4-4/UR7-1).
    this.category('Image', () => [
      { label: 'Diffuse…', run: () => this.pickImage('diffuse') },
      { label: 'Emit…', run: () => this.pickImage('emit') },
      { label: 'HTML / Website…', run: () => this.openWebDialog() },
    ]);
    // Curve ▸ (UR11-1): Bezier / Circle / NURBS presets, spawned at the cursor.
    this.category('Curve', () =>
      (['bezier', 'circle', 'nurbs'] as CurvePreset[]).map((preset) => ({
        label: preset === 'bezier' ? 'Bezier' : preset === 'circle' ? 'Circle' : 'NURBS',
        run: () => this.addCurve(preset),
      })));
    this.directItem('Camera', () =>
      this.commitAdd('Camera', this.opts.scene.addCamera('Camera')));
    // Empty (UR5-7): a null object for rigging/targeting (DoF focus, look-at).
    this.directItem('Empty', () =>
      this.commitAdd('Empty', this.opts.scene.addEmpty('Empty')));
    // Text (UR8-2): a text object spawning "Text" (face style, thickness 0.05).
    // Generate its mesh right away so it appears immediately (canvas is live in
    // the UI; the frame-loop driver keeps it in sync on later edits).
    this.directItem('Text', () => {
      const obj = this.opts.scene.addText('Text');
      regenerateTextMesh(obj);
      this.commitAdd('Text', obj);
    });

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

  /**
   * A category row (`Mesh ▸`, `Light ▸`). Hovering or clicking it opens a
   * flyout listing `items()` to the row's right. The row itself carries the
   * `.add-menu-item` class so a plain `click()` on the leaf still works once
   * the flyout is open (e2e compatibility).
   */
  private category(
    name: string,
    items: () => { label: string; run: () => void }[],
  ): void {
    const row = document.createElement('button');
    row.className = 'add-menu-item add-menu-category';
    row.type = 'button';
    row.dataset.category = name;
    const label = document.createElement('span');
    label.className = 'add-menu-label';
    label.textContent = name;
    const arrow = document.createElement('span');
    arrow.className = 'add-menu-arrow';
    arrow.textContent = '▸'; // ▸
    row.append(label, arrow);

    const open = (): void => {
      this.cancelClose();
      this.openFlyout(name, row, items());
    };
    row.addEventListener('mouseenter', open);
    row.addEventListener('click', open);
    row.addEventListener('mouseleave', this.scheduleClose);
    this.root.appendChild(row);
  }

  /** A direct root item (Camera). Hovering it dismisses any open flyout. */
  private directItem(label: string, run: () => void): void {
    const item = document.createElement('button');
    item.className = 'add-menu-item';
    item.type = 'button';
    item.textContent = label;
    item.addEventListener('mouseenter', this.scheduleClose);
    item.addEventListener('click', run);
    this.root.appendChild(item);
  }

  /**
   * Open (or switch to) the flyout for `category`, anchored to `row`. Positioned
   * at the root's right edge with its top aligned to the row; flips to the LEFT
   * if it would overflow the host's right edge, and is clamped vertically inside
   * the host — the same clamping idea the root already uses.
   */
  private openFlyout(
    category: string,
    row: HTMLElement,
    items: { label: string; run: () => void }[],
  ): void {
    if (this.flyoutCategory === category && this.flyout) return;
    this.closeFlyout();

    const fly = document.createElement('div');
    fly.className = 'add-menu add-menu-flyout';
    for (const { label, run } of items) {
      const btn = document.createElement('button');
      btn.className = 'add-menu-item';
      btn.type = 'button';
      btn.textContent = label;
      btn.addEventListener('click', run);
      fly.appendChild(btn);
    }
    fly.addEventListener('mouseenter', this.cancelCloseHandler);
    fly.addEventListener('mouseleave', this.scheduleClose);

    // Child of root, so onOutsidePointer's root.contains() treats it as inside.
    this.root.appendChild(fly);
    this.flyout = fly;
    this.flyoutCategory = category;

    // Measure, then position (all math in host-local coords, applied relative
    // to root since the flyout is absolutely positioned within root).
    const host = this.opts.parent;
    const rootLeft = this.root.offsetLeft;
    const rootTop = this.root.offsetTop;
    const rootW = this.root.offsetWidth;
    const flyW = fly.offsetWidth;
    const flyH = fly.offsetHeight;

    // Horizontal: right of root, else flip to the left if it overflows the host.
    let hostX = rootLeft + rootW;
    if (hostX + flyW > host.clientWidth) hostX = rootLeft - flyW;
    if (hostX < 0) hostX = 0;

    // Vertical: top aligned to the row, clamped to stay inside the host.
    const desiredTop = rootTop + row.offsetTop;
    const maxTop = Math.max(0, host.clientHeight - flyH);
    const hostY = Math.min(Math.max(desiredTop, 0), maxTop);

    fly.style.left = `${hostX - rootLeft}px`;
    fly.style.top = `${hostY - rootTop}px`;
  }

  private closeFlyout(): void {
    this.cancelClose();
    if (this.flyout) {
      this.flyout.remove();
      this.flyout = null;
      this.flyoutCategory = null;
    }
  }

  private readonly scheduleClose = (): void => {
    this.cancelClose();
    this.closeTimer = setTimeout(() => this.closeFlyout(), FLYOUT_CLOSE_DELAY_MS);
  };

  private readonly cancelCloseHandler = (): void => this.cancelClose();

  private cancelClose(): void {
    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
  }

  /**
   * Close the menu, then open the image file picker (UR4-3). The add commits
   * only when a file is chosen (inside imagePlane.ts) — cancelling does nothing.
   * Closing here keeps the AddMenu teardown contract (one menu on screen).
   */
  private pickImage(mode: ImagePlaneMode): void {
    const { scene, undo, setStatus } = this.opts;
    this.close();
    pickImagePlane(scene, undo, mode, setStatus);
  }

  /**
   * Close the menu, then open the "HTML / Website…" dialog (UR7-3 A): Load a web
   * address (a live iframe portal plane) or Open… a local .html file (the UR4-4 /
   * UR7-1 file plane, keeping the on-disk live-reload watcher where supported).
   */
  private openWebDialog(): void {
    const { parent, scene, undo, setStatus } = this.opts;
    this.close();
    new WebAddDialog({ parent, scene, undo, setStatus, onClose: () => {} });
  }

  private addCurve(preset: CurvePreset): void {
    const { name, data } = curvePreset(preset);
    const obj = this.opts.scene.addCurve(name, data);
    this.commitAdd(name, obj);
  }

  private addPrimitive(def: PrimitiveDef): void {
    const obj = this.opts.scene.add(def.name, def.make());
    this.commitAdd(def.name, obj);
    // Mount the "Adjust Last Operation" redo panel for this add (parametric
    // primitives only). It regenerates obj's mesh in place — no extra undo step.
    activeOpPanel = new OpPanel({
      parent: this.opts.parent,
      def,
      obj,
      onClose: () => { activeOpPanel = null; },
    });
  }

  /** Select the freshly added object, push ONE undo entry, close. */
  private commitAdd(name: string, obj: SceneObject): void {
    const { scene, undo, setStatus } = this.opts;
    // Blender semantics (P12): new objects spawn at the 3D cursor.
    obj.transform = obj.transform.withPosition(scene.cursor);
    // Cameras spawn looking toward the horizon (world +Y), not the floor (UR5-5,
    // Part B). Only the add-menu spawn carries this rotation — scene loads /
    // Camera-to-View set their own transform, so they must not be rotated here.
    if (obj.kind === 'camera') obj.transform = obj.transform.withRotation(CAMERA_SPAWN_ROTATION);
    // Any add supersedes the previous redo panel — only the latest add shows one.
    activeOpPanel?.close();
    scene.selectOnly(obj.id);
    // Construct AFTER scene.add so the command captures the real list index.
    undo.push(new AddObjectsCommand('Add ' + name, scene, [obj]));
    setStatus(`Added ${name}`);
    this.close();
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
    this.cancelClose();
    this.closeFlyout();
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('pointerdown', this.onOutsidePointer, true);
    this.root.remove();
    this.opts.onClose();
  }
}
