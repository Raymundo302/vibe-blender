/**
 * First-visit splash card (P3-4). Shows once, then dismisses on the first user
 * interaction (any click or key — wired in main.ts), remembering via
 * localStorage so it never reappears.
 *
 * Mounted inside #viewport-wrap and set `pointer-events: none` (theme.css) so it
 * can never swallow a canvas click: the click passes through to the canvas
 * (which reacts normally) and the same event auto-dismisses the splash. This is
 * what keeps the splash a no-op for the smoke/edit e2e flows — they interact
 * immediately, so the splash is gone before any state is asserted.
 */

/** localStorage key remembering the splash was seen. */
export const SPLASH_SEEN_KEY = 'vibe-blender-splash-seen';

export class Splash {
  private el: HTMLElement | null = null;

  /** Renders the splash only if it has never been dismissed before. */
  constructor(parent: HTMLElement) {
    if (localStorage.getItem(SPLASH_SEEN_KEY)) return;

    const el = document.createElement('div');
    el.className = 'splash';

    const card = document.createElement('div');
    card.className = 'splash-card';

    const title = document.createElement('div');
    title.className = 'splash-title';
    title.textContent = 'Vibe Blender';

    const pitch = document.createElement('div');
    pitch.className = 'splash-pitch';
    pitch.textContent = 'A Blender-style modeler, hand-built in TypeScript + WebGL2';

    const list = document.createElement('ul');
    list.className = 'splash-list';
    for (const [keys, text] of [
      ['MMB drag', 'orbit the camera'],
      ['Tab', 'toggle Edit Mode'],
      ['F1', 'keyboard shortcuts'],
    ] as const) {
      const li = document.createElement('li');
      const kbd = document.createElement('kbd');
      kbd.className = 'splash-keys';
      kbd.textContent = keys;
      const span = document.createElement('span');
      span.textContent = ` ${text}`;
      li.append(kbd, span);
      list.append(li);
    }

    const foot = document.createElement('div');
    foot.className = 'splash-foot';
    foot.textContent = 'Click anywhere to begin';

    card.append(title, pitch, list, foot);
    el.append(card);
    parent.append(el);
    this.el = el;
  }

  /** True while the splash is on screen. */
  get shown(): boolean {
    return this.el !== null;
  }

  /** Remove the splash and remember it — idempotent, safe to call repeatedly. */
  dismiss(): void {
    if (!this.el) return;
    this.el.remove();
    this.el = null;
    localStorage.setItem(SPLASH_SEEN_KEY, '1');
  }
}
