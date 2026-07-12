/**
 * Modal-key hint bar (UR14-1, item 1) — a persistent one-line strip along the
 * viewport bottom that rewrites per context: idle Object Mode, idle Edit Mode
 * (per element mode), or the live keymap for whatever modal op / special mode is
 * running. Blender's status-bar keymap strip, distilled.
 *
 * Lives inside #viewport-wrap, muted, `pointer-events: none` so it never
 * intercepts pointers. Ticked every frame from main.ts's loop; it diffs its own
 * text so a no-change frame is a cheap string compare.
 *
 * The per-operator strings come from a static map keyed by the active operator's
 * `name` (InputManager.activeOperatorName). Keeping the registry here — rather
 * than a hints() on every operator — keeps the touchpoints minimal (spec scope).
 */

import type { Scene } from '../core/scene/Scene';
import type { InputManager } from '../input/InputManager';
import { pageModeState } from '../tools/pageMode';
import { textEditState } from '../tools/textEdit';

/** Per-operator hint strings, keyed by Operator.name. Keep them SHORT. */
const OP_HINTS: Record<string, string> = {
  'Move': 'X/Y/Z axis · Shift precise · G slide · type number · LMB confirm · Esc cancel',
  'Rotate': 'X/Y/Z axis · Shift precise · type angle · LMB confirm · Esc cancel',
  'Scale': 'X/Y/Z axis · Shift precise · type factor · LMB confirm · Esc cancel',
  'Edge Slide': 'Move to slide · Shift precise · G cycle mode · LMB confirm · Esc cancel',
  'Normal Move': 'Move along normals · Shift precise · G cycle mode · LMB confirm · Esc cancel',
  'Extrude': 'Move to extrude · X/Y/Z axis · type number · LMB confirm · Esc cancel',
  'Inset': 'Move to inset · Shift precise · type number · LMB confirm · Esc cancel',
  'Bevel': 'Move to widen · wheel segments · LMB confirm · Esc cancel',
  'Knife': 'Click to add cuts · Enter confirm · Esc cancel',
  'Loop Cut': 'Move to place · wheel adds cuts · LMB confirm · Esc cancel',
  'Circle Select': 'Paint to select · wheel radius · LMB add · Esc finish',
  'Box Select': 'Drag a box · Shift extend · Esc cancel',
  'Lasso Select': 'Draw a lasso · Shift extend · Esc cancel',
  'Crease': 'Move to set crease · type number · LMB confirm · Esc cancel',
};

/** Fallback when a modal op has no registered hint. */
const OP_FALLBACK = 'LMB confirm · Esc cancel';

const OBJECT_IDLE = 'G move · R rotate · S scale · Tab edit · Shift+A add · X delete';

const EDIT_IDLE: Record<string, string> = {
  vert: '1/2/3 vert·edge·face · G/R/S transform · E extrude · Ctrl+R loop cut · Tab exit',
  edge: '1/2/3 vert·edge·face · G/R/S transform · Ctrl+E edge · E extrude · Tab exit',
  face: '1/2/3 vert·edge·face · G/R/S transform · I inset · E extrude · Tab exit',
};

const PAGE_IDLE = 'Scroll to browse the page · Tab / Esc exit';
const CURVE_IDLE = 'Click points · G move · Ctrl+click add · X delete · Tab exit';
const TEXT_IDLE = 'Type to edit text · Tab / Esc exit';

export class HintBar {
  readonly element: HTMLElement;
  private last = '';

  constructor(
    parent: HTMLElement,
    private readonly scene: Scene,
    private readonly input: InputManager,
  ) {
    const el = document.createElement('div');
    el.id = 'hint-bar';
    parent.appendChild(el);
    this.element = el;
    this.update();
  }

  /** Resolve the hint text for the current context (exposed for e2e/tests). */
  hintText(): string {
    // 1. An active modal operator wins — show its live keymap.
    const op = this.input.activeOperatorName;
    if (op) return OP_HINTS[op] ?? OP_FALLBACK;

    // 2. Special typing / browsing modes.
    if (textEditState.session) return TEXT_IDLE;
    if (pageModeState.object) return PAGE_IDLE;
    if (this.scene.curveEdit) return CURVE_IDLE;

    // 3. Edit mode idle, per element mode.
    const edit = this.scene.editMode;
    if (edit) return EDIT_IDLE[edit.elementMode] ?? EDIT_IDLE.vert;

    // 4. Object mode idle.
    return OBJECT_IDLE;
  }

  update(): void {
    const text = this.hintText();
    if (text === this.last) return;
    this.last = text;
    this.element.textContent = text;
  }
}
