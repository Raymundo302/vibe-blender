import type { Scene } from '../core/scene/Scene';

/**
 * The application header bar. Fills the existing #topbar mount with an app
 * title, a hardcoded "Object Mode" chip (Phase 2 will add Edit Mode), and a
 * live right-side status showing the active object name + object count.
 *
 * Not a shell Panel — it lives outside the sidebar — so main.ts calls update()
 * directly in the frame loop. update() uses the same signature-diff pattern the
 * panels use: it only rewrites the status text when the name or count changed.
 */
export class Topbar {
  private readonly statusEl: HTMLSpanElement;
  private lastSig = '';

  constructor(private readonly scene: Scene) {
    const root = document.getElementById('topbar') as HTMLElement;
    root.replaceChildren();

    const title = document.createElement('span');
    title.className = 'topbar-title';
    title.textContent = 'Vibe Blender';

    const chip = document.createElement('span');
    chip.className = 'topbar-chip';
    chip.textContent = 'Object Mode';

    const spacer = document.createElement('div');
    spacer.className = 'topbar-spacer';

    this.statusEl = document.createElement('span');
    this.statusEl.className = 'topbar-status';

    root.append(title, chip, spacer, this.statusEl);
    this.update();
  }

  /** Called every animation frame; cheap no-op when nothing visible changed. */
  update(): void {
    const active = this.scene.activeObject;
    const count = this.scene.objects.length;
    const sig = `${active ? active.name : ''}#${count}`;
    if (sig === this.lastSig) return;
    this.lastSig = sig;

    const noun = count === 1 ? 'object' : 'objects';
    this.statusEl.textContent = active
      ? `${active.name} — ${count} ${noun}`
      : `${count} ${noun}`;
  }
}
