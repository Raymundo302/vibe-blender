/**
 * Keyboard-shortcut cheat sheet (P3-4). F1 (or the topbar "?" button) toggles a
 * modal overlay listing every shortcut the app wires. The list lives in the
 * exported `SHORTCUTS` array — one entry per InputManager keymap branch — so it
 * stays greppable and can be cross-checked against the real handler.
 *
 * The overlay is DOM-only (no canvas changes). While it is open, InputManager
 * swallows all keyboard input so nothing leaks to the viewport (see the F1/help
 * guard at the top of InputManager.onKeyDown).
 */

export interface Shortcut {
  /** Section the entry belongs to (rendered as a column heading). */
  readonly group: string;
  /** Human-readable key combo, e.g. "Ctrl+R", "Shift+MMB drag". */
  readonly keys: string;
  /** What the shortcut does. */
  readonly description: string;
}

/**
 * Every shortcut wired in `src/input/InputManager.ts`, grouped for display.
 * Keep this in lock-step with InputManager — a missing entry is a spec violation
 * (P3-4 cross-checks by grepping the handler).
 */
export const SHORTCUTS: readonly Shortcut[] = [
  // General — handled before the mode branches, so they work in both modes.
  { group: 'General', keys: 'Tab', description: 'Toggle Edit / Object Mode' },
  { group: 'General', keys: 'Z', description: 'Cycle shading — Matcap / Wireframe / Studio / Rendered' },
  { group: 'General', keys: 'F12', description: 'Render the active camera (render engine)' },
  { group: 'General', keys: 'N', description: 'Toggle the N-panel (item transform + dims)' },
  { group: 'General', keys: 'Alt+Z', description: 'Toggle X-ray / select-through' },
  { group: 'General', keys: 'Ctrl+Alt+Numpad0', description: 'Snap the active camera to the current view' },
  { group: 'General', keys: 'Ctrl+Z', description: 'Undo' },
  { group: 'General', keys: 'Ctrl+Shift+Z', description: 'Redo' },
  { group: 'General', keys: 'F1', description: 'Toggle this shortcut sheet' },
  { group: 'General', keys: 'Enter / LMB', description: 'Confirm the active tool' },
  { group: 'General', keys: 'Esc / RMB', description: 'Cancel the active tool' },

  // Object mode
  { group: 'Object Mode', keys: 'LMB', description: 'Select object (Shift: extend)' },
  { group: 'Object Mode', keys: 'G', description: 'Move' },
  { group: 'Object Mode', keys: 'R', description: 'Rotate' },
  { group: 'Object Mode', keys: 'S', description: 'Scale' },
  { group: 'Object Mode', keys: 'Shift+A', description: 'Add menu (primitives)' },
  { group: 'Object Mode', keys: 'Shift+D', description: 'Duplicate selection (then Move)' },
  { group: 'Object Mode', keys: 'Alt+A', description: 'Deselect all' },
  { group: 'Object Mode', keys: 'M', description: 'Move selection to a collection' },
  { group: 'Object Mode', keys: 'X / Delete', description: 'Delete selection' },

  // Edit mode
  { group: 'Edit Mode', keys: 'LMB', description: 'Select element (Shift: toggle)' },
  { group: 'Edit Mode', keys: 'Alt+LMB', description: 'Loop select (Shift+Alt: add a loop)' },
  { group: 'Edit Mode', keys: '1 / 2 / 3', description: 'Vertex / Edge / Face select mode' },
  { group: 'Edit Mode', keys: 'A', description: 'Select all' },
  { group: 'Edit Mode', keys: 'Alt+A', description: 'Deselect all' },
  { group: 'Edit Mode', keys: 'B', description: 'Box select (Shift on release: remove)' },
  { group: 'Edit Mode', keys: 'Ctrl+I', description: 'Invert selection' },
  { group: 'Edit Mode', keys: 'G', description: 'Move elements' },
  { group: 'Edit Mode', keys: 'R', description: 'Rotate elements' },
  { group: 'Edit Mode', keys: 'S', description: 'Scale elements' },
  { group: 'Edit Mode', keys: 'O', description: 'Toggle proportional editing (wheel: radius)' },
  { group: 'Edit Mode', keys: 'E', description: 'Extrude faces' },
  { group: 'Edit Mode', keys: 'I', description: 'Inset faces' },
  { group: 'Edit Mode', keys: 'Ctrl+R', description: 'Loop cut' },
  { group: 'Edit Mode', keys: 'Ctrl+B', description: 'Bevel selected edges (modal width)' },
  { group: 'Edit Mode', keys: 'Ctrl+E', description: 'Edge menu — Mark / Clear Seam, Bridge edge loops' },
  { group: 'Edit Mode', keys: 'U', description: 'UV menu — Unwrap / Smart UV Project / Project From View' },
  { group: 'Edit Mode', keys: 'F', description: 'Fill face from vert / edge chain' },
  { group: 'Edit Mode', keys: 'Ctrl+D', description: 'Subdivide selected faces' },
  { group: 'Edit Mode', keys: 'Shift+E', description: 'Crease selected edges (modal weight)' },
  { group: 'Edit Mode', keys: 'Shift+N', description: 'Recalculate normals (selected / all)' },
  { group: 'Edit Mode', keys: 'X / Delete', description: 'Delete menu (verts / edges / faces)' },
  { group: 'Edit Mode', keys: 'M', description: 'Merge at center' },
  { group: 'Edit Mode', keys: 'Shift+I', description: 'Sculpt: Inflate brush (toggle; Ctrl drag: deflate)' },
  { group: 'Edit Mode', keys: 'Shift+G', description: 'Sculpt: Grab brush (toggle; LMB drag: pull)' },
  { group: 'Edit Mode', keys: '[ / ]', description: 'Sculpt brush radius (while a brush is active)' },

  // Camera navigation
  { group: 'Camera', keys: 'MMB drag', description: 'Orbit' },
  { group: 'Camera', keys: 'Shift+MMB drag', description: 'Pan' },
  { group: 'Camera', keys: 'Mouse wheel', description: 'Zoom' },
  { group: 'Camera', keys: 'Numpad0', description: 'View through the active camera (toggle). With Camera tab › Lock to View on, navigating flies the camera' },
  { group: 'Camera', keys: '. (Period)', description: 'Frame the selection' },

  // File
  { group: 'File', keys: 'Ctrl+S', description: 'Save scene (.vibe.json)' },
  { group: 'File', keys: 'Ctrl+O', description: 'Open scene' },
  { group: 'File', keys: 'Export OBJ', description: 'Export mesh to .obj (topbar button)' },
  { group: 'File', keys: 'Import OBJ', description: 'Import a .obj mesh (topbar button)' },

  // Workspaces
  { group: 'Workspaces', keys: 'Tab bar', description: 'Switch workspace (topbar tabs)' },
  { group: 'Workspaces', keys: 'Ctrl+Space', description: 'Fullscreen the area under the cursor' },
];

/** Unique group names in first-seen order (drives the render order). */
function groupOrder(): string[] {
  const seen: string[] = [];
  for (const s of SHORTCUTS) if (!seen.includes(s.group)) seen.push(s.group);
  return seen;
}

/**
 * The shortcut overlay. Mounted lazily on open, removed on close — the DOM only
 * exists while visible so `document.querySelector('.help-overlay')` is an exact
 * open/closed probe (used by e2e).
 */
export class HelpOverlay {
  private el: HTMLElement | null = null;

  constructor(private readonly parent: HTMLElement) {}

  isOpen(): boolean {
    return this.el !== null;
  }

  toggle(): void {
    if (this.isOpen()) this.close();
    else this.open();
  }

  open(): void {
    if (this.el) return;

    const backdrop = document.createElement('div');
    backdrop.className = 'help-overlay';
    // Click on the dim backdrop (but not the card) closes.
    backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === backdrop) this.close();
    });

    const card = document.createElement('div');
    card.className = 'help-card';

    const header = document.createElement('div');
    header.className = 'help-header';
    const title = document.createElement('span');
    title.className = 'help-title';
    title.textContent = 'Keyboard Shortcuts';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'help-close';
    closeBtn.textContent = '×'; // ×
    closeBtn.title = 'Close (F1 / Esc)';
    closeBtn.addEventListener('click', () => this.close());
    header.append(title, closeBtn);

    const grid = document.createElement('div');
    grid.className = 'help-grid';
    for (const group of groupOrder()) {
      const section = document.createElement('div');
      section.className = 'help-section';

      const heading = document.createElement('div');
      heading.className = 'help-group';
      heading.textContent = group;
      section.append(heading);

      const table = document.createElement('div');
      table.className = 'help-table';
      for (const s of SHORTCUTS.filter((x) => x.group === group)) {
        const keys = document.createElement('kbd');
        keys.className = 'help-keys';
        keys.textContent = s.keys;
        const desc = document.createElement('span');
        desc.className = 'help-desc';
        desc.textContent = s.description;
        table.append(keys, desc);
      }
      section.append(table);
      grid.append(section);
    }

    const foot = document.createElement('div');
    foot.className = 'help-foot';
    foot.textContent = 'Press F1 or Esc to close';

    card.append(header, grid, foot);
    backdrop.append(card);
    this.parent.append(backdrop);
    this.el = backdrop;
  }

  close(): void {
    this.el?.remove();
    this.el = null;
  }
}
