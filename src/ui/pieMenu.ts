import './pieMenu.css';

/** One selectable wedge. `disabled` renders it greyed + inert. */
export interface PieItem {
  label: string;
  disabled?: boolean;
  action: () => void;
}

export interface PieMenuOptions {
  /** Positioned host — (x, y) are parent-local CSS px. */
  parent: HTMLElement;
  x: number;
  y: number;
  /** Chip label shown at the pie's center. */
  title: string;
  /** Up to 8 wedges, laid out in Blender order (see below). */
  items: PieItem[];
  /** Fired exactly once on teardown so the owner drops its reference. */
  onClose: () => void;
}

/** Radius (px) from the center to each wedge button's center. */
const RADIUS = 78;

/**
 * Blender wedge order for items 0..7: W, E, S, N, NW, NE, SW, SE. Angles are in
 * degrees clockwise from the +X axis (screen space, y-down), so S = +90.
 */
const ANGLES = [180, 0, 90, 270, 225, 315, 135, 45];

/**
 * A generic radial pie menu (P12). Up to 8 wedge buttons in a ring around a
 * center title chip. Click a wedge → run its action + close; Escape or a click
 * outside → close; disabled wedges are greyed and inert. Owns its element and
 * every listener and removes them all on close (mirrors AddMenu). Reused by
 * P13+; keep it free of any snap/scene specifics.
 */
export class PieMenu {
  private readonly root: HTMLDivElement;
  private closed = false;

  constructor(private readonly opts: PieMenuOptions) {
    this.root = document.createElement('div');
    this.root.className = 'pie-menu';

    const chip = document.createElement('div');
    chip.className = 'pie-menu-title';
    chip.textContent = opts.title;
    this.root.appendChild(chip);

    opts.items.slice(0, 8).forEach((item, i) => this.wedge(item, i));

    // Position the ring's CENTER at (x, y), then clamp so the whole ring stays
    // inside the host. The root spans 2*RADIUS + button size; place by top-left.
    opts.parent.appendChild(this.root);
    const w = this.root.offsetWidth;
    const h = this.root.offsetHeight;
    const left = clamp(opts.x - w / 2, 0, Math.max(0, opts.parent.clientWidth - w));
    const top = clamp(opts.y - h / 2, 0, Math.max(0, opts.parent.clientHeight - h));
    this.root.style.left = `${left}px`;
    this.root.style.top = `${top}px`;

    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('pointerdown', this.onOutsidePointer, true);
  }

  private wedge(item: PieItem, index: number): void {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pie-menu-wedge';
    btn.textContent = item.label;
    if (item.disabled) {
      btn.classList.add('disabled');
      btn.disabled = true;
    }
    const rad = (ANGLES[index] * Math.PI) / 180;
    const cx = Math.cos(rad) * RADIUS;
    const cy = Math.sin(rad) * RADIUS;
    // Center of the ring is the root's center (50%/50%); offset each button by
    // its own half-size via translate(-50%,-50%) plus the polar offset.
    btn.style.left = `calc(50% + ${cx}px)`;
    btn.style.top = `calc(50% + ${cy}px)`;
    if (!item.disabled) {
      btn.addEventListener('click', () => {
        item.action();
        this.close();
      });
    }
    this.root.appendChild(btn);
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
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('pointerdown', this.onOutsidePointer, true);
    this.root.remove();
    this.opts.onClose();
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}
