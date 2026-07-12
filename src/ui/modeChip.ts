/**
 * One mode chip (UR14-1, item 15) — a single top-left viewport chip that
 * announces the current SPECIAL mode + its exit key. Replaces the scattered
 * per-feature chips by routing every "what mode am I in" string through one
 * component (the underlying feature logic is untouched — this only reads state).
 *
 * States, highest priority first:
 *   - Viewing Camera (Numpad0)   → "Viewing Camera — Numpad0 exits"
 *   - Extract Element (Page Mode) → "Extract Element — Esc exits"
 *   - Page Mode                   → "Page Mode — Tab exits"
 *   - Text Edit                   → "Text Edit — Tab exits"
 *   - Curve Edit                  → "Curve Edit — Tab exits"
 *   - (none)                      → hidden
 *
 * Lives inside #viewport-wrap, `pointer-events: none`. Ticked every frame.
 */

import type { Scene } from '../core/scene/Scene';
import type { Renderer } from '../render/Renderer';
import { pageModeState } from '../tools/pageMode';
import { textEditState } from '../tools/textEdit';
import { extractState } from '../tools/extractElement';

export class ModeChip {
  readonly element: HTMLElement;
  private last = '';

  constructor(
    parent: HTMLElement,
    private readonly scene: Scene,
    private readonly renderer: Renderer,
  ) {
    const el = document.createElement('div');
    el.id = 'mode-chip';
    el.hidden = true;
    parent.appendChild(el);
    this.element = el;
    this.update();
  }

  /** The chip text for the current special mode, or '' when none (for e2e). */
  chipText(): string {
    if (this.renderer.cameraViewId !== null) return 'Viewing Camera — Numpad0 exits';
    if (extractState.controller) return 'Extract Element — Esc exits';
    if (pageModeState.object) return 'Page Mode — Tab exits';
    if (textEditState.session) return 'Text Edit — Tab exits';
    if (this.scene.curveEdit) return 'Curve Edit — Tab exits';
    return '';
  }

  update(): void {
    const text = this.chipText();
    if (text === this.last) return;
    this.last = text;
    this.element.textContent = text;
    this.element.hidden = text === '';
  }
}
