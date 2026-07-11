import type { Scene } from '../core/scene/Scene';
import type { UndoStack } from '../core/undo/UndoStack';
import type { InputManager } from '../input/InputManager';
import { TranslateOperator } from '../tools/translate';
import { RotateOperator } from '../tools/rotate';
import { ScaleOperator } from '../tools/scale';
import { runIntersectTool } from '../tools/intersectTool';

/**
 * A tool-palette entry (UR3-1). One button in the viewport's left-edge strip.
 * `run()` does EXACTLY what pressing the tool's shortcut does — the modal-tool
 * entries route through the same InputManager code path the keyboard uses.
 * `opName`, when set, is the `Operator.name` that marks this button "active"
 * while that operator is the running modal op (polled in `update()`).
 */
export interface ToolDef {
  id: string;
  label: string;
  icon: string;
  shortcut: string;
  modes: ('object' | 'edit')[];
  run(): void;
  opName?: string;
}

/**
 * The viewport tool palette — Blender's T-toolbar. A slim vertical column of
 * one-shot tool buttons docked on the LEFT edge of the 3D Viewport, showing
 * object-mode tools in object mode and mesh-edit tools in edit mode. Clicking a
 * button starts the same modal operator (or runs the same action) the tool's
 * keyboard shortcut does.
 *
 * Mounted inside #viewport-wrap (like the N-panel + splash); the container is
 * pointer-events:none so only the buttons intercept pointers — viewport drags in
 * the gaps pass straight through to the canvas.
 */
export class Toolbar {
  private readonly element: HTMLDivElement;
  private readonly tools: ToolDef[];
  /** Currently-mounted buttons, paired with their tool for the active-poll. */
  private buttons: { el: HTMLButtonElement; tool: ToolDef }[] = [];
  /** The mode the button list was last built for; null = never built. */
  private builtMode: 'object' | 'edit' | null = null;

  constructor(
    private readonly parent: HTMLElement,
    private readonly scene: Scene,
    private readonly undo: UndoStack,
    private readonly input: InputManager,
    private readonly setStatus: (s: string) => void,
  ) {
    this.element = document.createElement('div');
    this.element.className = 'viewport-toolbar';
    this.tools = this.buildTools();
    this.parent.appendChild(this.element);

    // e2e handle (like window.__timeline / window.__graph).
    if (typeof window !== 'undefined') {
      (window as unknown as Record<string, unknown>).__toolbar = this;
    }
  }

  /** The full, typed tool registry. Built once; buttons filter it per mode. */
  private buildTools(): ToolDef[] {
    const im = this.input;
    return [
      // --- Object mode -------------------------------------------------------
      { id: 'move', label: 'Move', icon: '✥', shortcut: 'G', modes: ['object'], opName: 'Move',
        run: () => im.startOperator(new TranslateOperator()) },
      { id: 'rotate', label: 'Rotate', icon: '⟳', shortcut: 'R', modes: ['object'], opName: 'Rotate',
        run: () => im.startOperator(new RotateOperator()) },
      { id: 'scale', label: 'Scale', icon: '⤢', shortcut: 'S', modes: ['object'], opName: 'Scale',
        run: () => im.startOperator(new ScaleOperator()) },
      { id: 'duplicate', label: 'Duplicate', icon: '⧉', shortcut: 'Shift+D', modes: ['object'],
        run: () => im.duplicateSelected() },
      { id: 'intersect', label: 'Intersect', icon: '∩', shortcut: '', modes: ['object'],
        run: () => runIntersectTool(this.scene, this.undo, this.setStatus) },
      // --- Edit mode ---------------------------------------------------------
      { id: 'edit-move', label: 'Move', icon: '✥', shortcut: 'G', modes: ['edit'], opName: 'Move',
        run: () => im.startEditMove() },
      { id: 'edit-rotate', label: 'Rotate', icon: '⟳', shortcut: 'R', modes: ['edit'], opName: 'Rotate',
        run: () => im.startEditRotate() },
      { id: 'edit-scale', label: 'Scale', icon: '⤢', shortcut: 'S', modes: ['edit'], opName: 'Scale',
        run: () => im.startEditScale() },
      { id: 'extrude', label: 'Extrude', icon: '↥', shortcut: 'E', modes: ['edit'], opName: 'Extrude',
        run: () => im.startExtrude() },
      { id: 'inset', label: 'Inset', icon: '▣', shortcut: 'I', modes: ['edit'], opName: 'Inset',
        run: () => im.startInset() },
      { id: 'bevel', label: 'Bevel', icon: '⬖', shortcut: 'Ctrl+B', modes: ['edit'], opName: 'Bevel',
        run: () => im.startBevel() },
      { id: 'loopcut', label: 'Loop Cut', icon: '▤', shortcut: 'Ctrl+R', modes: ['edit'], opName: 'Loop Cut',
        run: () => im.startLoopCut() },
      { id: 'knife', label: 'Knife', icon: '✂', shortcut: 'K', modes: ['edit'], opName: 'Knife',
        run: () => im.startKnife() },
      { id: 'edgeslide', label: 'Edge Slide', icon: '↔', shortcut: 'GG', modes: ['edit'], opName: 'Edge Slide',
        run: () => im.startEdgeSlide() },
    ];
  }

  /** Rebuild the button list for `mode` (cheap; only called on a mode change). */
  private rebuild(mode: 'object' | 'edit'): void {
    this.element.textContent = '';
    this.buttons = [];
    for (const tool of this.tools) {
      if (!tool.modes.includes(mode)) continue;
      const btn = document.createElement('button');
      btn.className = 'viewport-tool-btn';
      btn.textContent = tool.icon;
      btn.dataset.toolId = tool.id;
      btn.title = tool.shortcut ? `${tool.label} (${tool.shortcut})` : tool.label;
      btn.addEventListener('click', () => tool.run());
      this.element.appendChild(btn);
      this.buttons.push({ el: btn, tool });
    }
  }

  /**
   * Frame-loop tick: rebuild the button set when the mode flips (cheap no-op
   * when unchanged), then paint the active-operator highlight.
   */
  update(): void {
    const mode = this.scene.mode; // 'object' | 'edit'
    if (mode !== this.builtMode) {
      this.rebuild(mode);
      this.builtMode = mode;
    }
    const active = this.input.activeOperatorName;
    for (const { el, tool } of this.buttons) {
      el.classList.toggle('active', !!tool.opName && tool.opName === active);
    }
  }
}
