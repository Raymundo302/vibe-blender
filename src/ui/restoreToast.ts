/**
 * Crash-restore toast (P6-4). A small non-blocking card shown on boot when an
 * autosave exists that differs from the pristine default scene:
 *
 *   Restore previous session?  [Restore] [Discard]
 *
 * The card container is `pointer-events: none` (theme.css) so it never swallows
 * viewport/topbar clicks — only the two buttons are interactive. Both buttons
 * dismiss the toast, then run their callback. `dismiss()` is idempotent.
 */

export interface RestoreToastCallbacks {
  onRestore: () => void;
  onDiscard: () => void;
}

export class RestoreToast {
  private el: HTMLElement | null = null;

  constructor(parent: HTMLElement, cb: RestoreToastCallbacks) {
    const el = document.createElement('div');
    el.className = 'restore-toast';

    const msg = document.createElement('span');
    msg.className = 'restore-toast-msg';
    msg.textContent = 'Restore previous session?';

    const restore = this.makeButton('Restore', 'restore');
    restore.addEventListener('click', () => {
      this.dismiss();
      cb.onRestore();
    });

    const discard = this.makeButton('Discard', 'discard');
    discard.addEventListener('click', () => {
      this.dismiss();
      cb.onDiscard();
    });

    el.append(msg, restore, discard);
    parent.append(el);
    this.el = el;
  }

  private makeButton(label: string, action: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'restore-toast-btn';
    btn.dataset.action = action;
    btn.textContent = label;
    return btn;
  }

  /** True while the toast is on screen. */
  get shown(): boolean {
    return this.el !== null;
  }

  /** Remove the toast — idempotent, safe to call repeatedly. */
  dismiss(): void {
    if (!this.el) return;
    this.el.remove();
    this.el = null;
  }
}
