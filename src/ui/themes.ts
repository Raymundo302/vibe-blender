/**
 * Theme system (Phase 10). A theme is plain data: CSS custom-property values
 * for the DOM (every component stylesheet references var(--vb-*) tokens) plus
 * a small set of viewport colors read by the GL passes each frame.
 *
 * The ARCHITECT ships two themes here: 'claude' (the app's original look,
 * frozen) and 'default' (closest match to real Blender 4.x). P10-3 registers
 * the six 90s themes in src/ui/themes90s.ts and builds the picker UI.
 */

export type Rgb = [number, number, number];

export interface ThemeViewport {
  /** Viewport clear color (linear-ish 0..1). */
  background: Rgb;
  /** Grid line color. */
  grid: Rgb;
  /** Floor axis line colors (world X / world Z). */
  axisX: Rgb;
  axisZ: Rgb;
  /** Selection outline + selected icon/gizmo accent. */
  selection: Rgb;
}

export interface ThemeSpec {
  id: string;
  name: string;
  /** One-line vibe, shown in the picker. */
  tagline: string;
  /**
   * CSS custom properties, WITHOUT the `--vb-` prefix. Required keys:
   * bg, panel, panel2, input, border, text, text-dim, accent,
   * accent-contrast, hover, chip. Extra keys are allowed.
   */
  css: Record<string, string>;
  viewport: ThemeViewport;
}

const registry = new Map<string, ThemeSpec>();

export function registerTheme(theme: ThemeSpec): void {
  if (!registry.has(theme.id)) registry.set(theme.id, theme);
}

export function themes(): readonly ThemeSpec[] {
  return [...registry.values()];
}

/**
 * The LIVE viewport palette. GL passes read this object every frame — never
 * hold onto a Rgb reference across applyTheme (arrays are replaced whole).
 */
export const themeViewport: ThemeViewport = {
  background: [0.227, 0.227, 0.227],
  grid: [0.32, 0.32, 0.32],
  axisX: [0.65, 0.28, 0.32],
  axisZ: [0.35, 0.55, 0.28],
  selection: [0.996, 0.451, 0.062],
};

const STORAGE_KEY = 'vibe-blender-theme';
let activeId = 'claude';

export function currentThemeId(): string {
  return activeId;
}

/** Apply a registered theme: set CSS vars on :root, swap viewport colors, persist. */
export function applyTheme(id: string): boolean {
  const theme = registry.get(id);
  if (!theme) return false;
  activeId = id;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme.css)) {
    root.style.setProperty(`--vb-${key}`, value);
  }
  Object.assign(themeViewport, {
    background: [...theme.viewport.background],
    grid: [...theme.viewport.grid],
    axisX: [...theme.viewport.axisX],
    axisZ: [...theme.viewport.axisZ],
    selection: [...theme.viewport.selection],
  });
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch { /* storage unavailable — theme just won't persist */ }
  return true;
}

/** Boot-time restore: apply the stored theme (or 'claude'). Called by main.ts. */
export function applyStoredTheme(): void {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch { /* ignore */ }
  if (!stored || !applyTheme(stored)) applyTheme('claude');
}

// --- The architect's two themes ---------------------------------------------

/** The app's original look, exactly as built through Phase 9. */
registerTheme({
  id: 'claude',
  name: 'Claude Theme',
  tagline: 'The original — built by the AI that built the app.',
  css: {
    bg: '#1d1d1d',
    panel: '#2b2b2b',
    panel2: '#343434',
    input: '#1f1f1f',
    border: '#3d3d3d',
    text: '#d0d0d0',
    'text-dim': '#8a8a8a',
    accent: '#fe730f',
    'accent-contrast': '#ffffff',
    hover: '#4a4a4a',
    chip: '#5a5a5a',
  },
  viewport: {
    background: [0.227, 0.227, 0.227],
    grid: [0.32, 0.32, 0.32],
    axisX: [0.65, 0.28, 0.32],
    axisZ: [0.35, 0.55, 0.28],
    selection: [0.996, 0.451, 0.062],
  },
});

/** Closest match to stock Blender 4.x dark. */
registerTheme({
  id: 'default',
  name: 'Default Theme',
  tagline: 'As close to real Blender as we get.',
  css: {
    bg: '#161616',
    panel: '#303030',
    panel2: '#383838',
    input: '#1d1d1d',
    border: '#242424',
    text: '#e5e5e5',
    'text-dim': '#989898',
    accent: '#4772b3',
    'accent-contrast': '#ffffff',
    hover: '#464646',
    chip: '#545454',
  },
  viewport: {
    background: [0.239, 0.239, 0.239],
    grid: [0.29, 0.29, 0.29],
    axisX: [0.596, 0.259, 0.325],
    axisZ: [0.31, 0.52, 0.235],
    selection: [0.996, 0.451, 0.062], // Blender keeps the orange outline
  },
});
