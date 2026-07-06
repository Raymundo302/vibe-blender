/**
 * A dockable panel: an element plus a per-frame update() that must no-op
 * cheaply when nothing changed. Hosted inside workspace areas (see
 * workspace.ts); previously hosted by the retired UiShell sidebar.
 */
export interface Panel {
  readonly id: string;
  readonly title: string;
  readonly element: HTMLElement;
  update(): void;
}
