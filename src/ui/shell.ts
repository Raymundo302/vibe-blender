/**
 * UI shell: owns the #topbar and #sidebar DOM mount points so panels never
 * touch index.html. Panels register once; update() runs every frame from the
 * render loop — panels should internally no-op when nothing they show changed
 * (cheap signature diffing), and never rebuild DOM that holds focus.
 */
export interface Panel {
  readonly id: string;
  readonly title: string;
  /** Root element, appended inside the panel's <section>. */
  readonly element: HTMLElement;
  /** Called every animation frame. Must be cheap when nothing changed. */
  update(): void;
}

export class UiShell {
  readonly topbar: HTMLElement;
  readonly sidebar: HTMLElement;
  private readonly panels: Panel[] = [];

  constructor() {
    this.topbar = document.getElementById('topbar') as HTMLElement;
    this.sidebar = document.getElementById('sidebar') as HTMLElement;
  }

  addPanel(panel: Panel): void {
    const section = document.createElement('section');
    section.className = 'panel';
    section.dataset.panelId = panel.id;
    const title = document.createElement('h3');
    title.className = 'panel-title';
    title.textContent = panel.title;
    section.append(title, panel.element);
    this.sidebar.appendChild(section);
    this.panels.push(panel);
  }

  update(): void {
    for (const p of this.panels) p.update();
  }
}
