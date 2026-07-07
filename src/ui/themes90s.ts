/**
 * The six 90s themes from Ray's reference sheet (P10-3). Each registers a
 * ThemeSpec: the 11 CSS tokens (bg, panel, panel2, input, border, text,
 * text-dim, accent, accent-contrast, hover, chip) plus the viewport palette
 * (background/grid/axisX/axisZ/selection) read by the GL passes every frame.
 *
 * Starting palettes come from the spec; a few hexes were malformed there and
 * sanitized to the obvious intent (see the P10-3 Result for the list). Where the
 * spec omitted floor axis colors, muted red/green axes matching the theme were
 * chosen so the world X/Z lines stay legible.
 *
 * Imported for its side effect from main.ts (before applyStoredTheme), so a
 * persisted 90s theme is registered in time to be re-applied at boot.
 */
import { registerTheme } from './themes';

registerTheme({
  id: 'retro-dos',
  name: 'Retro DOS',
  tagline: 'Green phosphor CRT.',
  css: {
    bg: '#0a0f0a',
    panel: '#101a10',
    panel2: '#162416', // spec had "#16241 6" — stray space
    input: '#060b06',
    border: '#1e3a1e',
    text: '#7dff7d',
    'text-dim': '#3f7a3f',
    accent: '#33ff33',
    'accent-contrast': '#041004',
    hover: '#1c341c',
    chip: '#234023',
  },
  viewport: {
    background: [0.03, 0.05, 0.03],
    grid: [0.10, 0.22, 0.10],
    axisX: [0.35, 0.6, 0.2],
    axisZ: [0.2, 0.5, 0.15],
    selection: [0.2, 1, 0.2],
  },
});

registerTheme({
  id: 'sunset-grid',
  name: 'Sunset Grid',
  tagline: 'Synthwave purple & orange.',
  css: {
    bg: '#14041f',
    panel: '#22093a',
    panel2: '#2c0f4a',
    input: '#0d0216',
    border: '#3a1a5e',
    text: '#f0d8ff',
    'text-dim': '#9a70c0',
    accent: '#ff7a1a',
    'accent-contrast': '#1a0a00',
    hover: '#38175c',
    chip: '#452170', // spec had "#45217" — one digit short
  },
  viewport: {
    background: [0.08, 0.02, 0.12],
    grid: [0.25, 0.10, 0.35],
    axisX: [0.85, 0.25, 0.45],
    axisZ: [0.95, 0.5, 0.15],
    selection: [1, 0.48, 0.1],
  },
});

registerTheme({
  id: 'teal-machine',
  name: 'Teal Machine',
  tagline: 'Industrial steel.',
  css: {
    bg: '#10171a',
    panel: '#1b262b',
    panel2: '#223038',
    input: '#0b1114',
    border: '#2c3d45',
    text: '#cfe6e6',
    'text-dim': '#7a9a9a',
    accent: '#2fd8c8',
    'accent-contrast': '#06211e',
    hover: '#2a3a42',
    chip: '#33474f',
  },
  viewport: {
    background: [0.07, 0.10, 0.11],
    grid: [0.16, 0.24, 0.26],
    axisX: [0.55, 0.30, 0.32], // muted red
    axisZ: [0.30, 0.48, 0.30], // muted green
    selection: [0.18, 0.85, 0.78],
  },
});

registerTheme({
  id: 'grunge-console',
  name: 'Grunge Console',
  tagline: '90s game dev.',
  css: {
    bg: '#12120c',
    panel: '#1e1d14',
    panel2: '#262418',
    input: '#0c0c08',
    border: '#34321e',
    text: '#cfc9a8',
    'text-dim': '#837e60',
    accent: '#c8b93c',
    'accent-contrast': '#171505',
    hover: '#302e1c',
    chip: '#3b3823',
  },
  viewport: {
    background: [0.07, 0.07, 0.05],
    grid: [0.18, 0.17, 0.11],
    axisX: [0.55, 0.38, 0.22], // muted olive-red
    axisZ: [0.42, 0.46, 0.22], // muted olive-green
    selection: [0.85, 0.78, 0.24],
  },
});

registerTheme({
  id: 'ice-blue',
  name: 'Ice Blue',
  tagline: 'Soft light UI.',
  css: {
    bg: '#dfe6ee',
    panel: '#f2f5f9',
    panel2: '#e7edf4',
    input: '#ffffff',
    border: '#b9c4d1',
    text: '#2a3440',
    'text-dim': '#6b7a8c',
    accent: '#4a90e2',
    'accent-contrast': '#ffffff',
    hover: '#cdd8e4',
    chip: '#b9c7d6',
  },
  viewport: {
    background: [0.82, 0.86, 0.90],
    grid: [0.62, 0.67, 0.73],
    axisX: [0.80, 0.35, 0.40],
    axisZ: [0.35, 0.62, 0.30],
    selection: [0.29, 0.56, 0.89],
  },
});

registerTheme({
  id: 'carbon-fusion',
  name: 'Carbon Fusion',
  tagline: 'High contrast, hot accents.',
  css: {
    bg: '#0b0b0d',
    panel: '#151518',
    panel2: '#1c1c20',
    input: '#050506',
    border: '#26262c',
    text: '#e8e8ea',
    'text-dim': '#8e8e96',
    accent: '#ff2d55',
    'accent-contrast': '#ffffff',
    hover: '#232329',
    chip: '#2e2e36',
  },
  viewport: {
    background: [0.04, 0.04, 0.05],
    grid: [0.14, 0.14, 0.16],
    axisX: [0.55, 0.22, 0.28], // muted red
    axisZ: [0.28, 0.42, 0.25], // muted green
    selection: [1, 0.18, 0.33],
  },
});
