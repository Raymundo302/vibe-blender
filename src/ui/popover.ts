import './popover.css';

/**
 * UR16-2 — a small, self-contained popover that ALWAYS clamps itself into the
 * viewport (Ray's color-picker-off-screen bug). It is appended to `document.body`
 * with `position: fixed`, anchored below-right of a target rect, and then
 * clamped so no edge crosses the window bounds — flipping above/left when a side
 * would overflow. This is the reusable positioning helper the socket menus and
 * shader chooser share (mirrors the add-menu flyout's edge-flip idea, generalized
 * to the whole viewport instead of a host element).
 *
 * Closes on: an item click, an outside pointerdown, Escape, scroll, or blur.
 */

export interface PopoverItem {
  label: string;
  /** Marked with the active tint (the current choice). */
  active?: boolean;
  /** data-* attributes on the item button (e.g. { kind: 'image' }). */
  data?: Record<string, string>;
  run: () => void;
}

export class Popover {
  private readonly el: HTMLDivElement;
  private closed = false;
  private readonly onClose?: () => void;

  constructor(anchor: HTMLElement, items: PopoverItem[], opts: { itemClass?: string; onClose?: () => void } = {}) {
    this.onClose = opts.onClose;
    this.el = document.createElement('div');
    this.el.className = 'vb-popover';
    for (const item of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'vb-popover-item' + (item.active ? ' is-active' : '') + (opts.itemClass ? ` ${opts.itemClass}` : '');
      btn.textContent = item.label;
      if (item.data) for (const [k, v] of Object.entries(item.data)) btn.dataset[k] = v;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.close();
        item.run();
      });
      this.el.appendChild(btn);
    }
    document.body.appendChild(this.el);
    this.position(anchor);

    // Defer listener attach one frame so the opening click doesn't self-close.
    setTimeout(() => {
      if (this.closed) return;
      window.addEventListener('pointerdown', this.onOutside, true);
      window.addEventListener('keydown', this.onKey, true);
      window.addEventListener('scroll', this.onScrollBlur, true);
      window.addEventListener('blur', this.onScrollBlur);
    }, 0);
  }

  /** Anchor below-right of the target, then clamp into the viewport. */
  private position(anchor: HTMLElement): void {
    const r = anchor.getBoundingClientRect();
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const M = 4;

    // Preferred: aligned to the anchor's left, just below it.
    let left = r.left;
    let top = r.bottom + 2;

    // Horizontal clamp / flip: if it runs off the right, pull it in.
    if (left + w > vw - M) left = Math.min(r.right - w, vw - w - M);
    if (left < M) left = M;

    // Vertical: flip above if it would overflow the bottom.
    if (top + h > vh - M) {
      const above = r.top - h - 2;
      top = above >= M ? above : Math.max(M, vh - h - M);
    }
    if (top < M) top = M;

    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
  }

  private readonly onOutside = (e: PointerEvent): void => {
    if (!this.el.contains(e.target as Node)) this.close();
  };
  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); this.close(); }
  };
  private readonly onScrollBlur = (): void => this.close();

  /** The popover element (for e2e rect probes). */
  get element(): HTMLDivElement { return this.el; }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    window.removeEventListener('pointerdown', this.onOutside, true);
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('scroll', this.onScrollBlur, true);
    window.removeEventListener('blur', this.onScrollBlur);
    this.el.remove();
    this.onClose?.();
  }
}

// e2e handle: lets a suite construct a clamped popover against an arbitrary
// anchor (the reusable positioning helper the material sockets share).
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__Popover = Popover;
}
