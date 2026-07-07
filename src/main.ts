import { createGlContext } from './render/gl/context';
import { Renderer } from './render/Renderer';
import { Scene } from './core/scene/Scene';
import { OrbitCamera } from './camera/OrbitCamera';
import { UndoStack } from './core/undo/UndoStack';
import { makeCube } from './core/mesh/primitives';
import { InputManager } from './input/InputManager';
import { WorkspaceManager, type EditorFactory, type WorkspaceConfig } from './ui/workspace';
import { OutlinerPanel } from './ui/outliner';
import { PropertiesEditor } from './ui/propertiesEditor';
import { UVEditor } from './ui/uvEditor';
import './ui/modifierTab'; // side-effect: registers the Modifiers properties tab
import './ui/materialTab'; // side-effect: registers the Material properties tab (P8-3)
import './ui/lightTab'; // side-effect: registers the Light data tab (P8-1)
import './ui/cameraTab'; // side-effect: registers the Camera data tab (P8-2)
import './ui/worldTab'; // side-effect: registers the World tab (P10-4)
import { initRenderEngine } from './renderEngine/init'; // F12 render engine (P8-4)
import './core/modifiers/builtins'; // side-effect: registers Mirror + Array modifiers
import { Topbar } from './ui/topbar';
import { HelpOverlay } from './ui/helpOverlay';
import { NPanel } from './ui/nPanel';
import { Passepartout } from './ui/passepartout';
import { Splash } from './ui/splash';
import { serializeScene, applySceneJson } from './io/sceneJson';
import { Autosave } from './io/autosave';
import { RestoreToast } from './ui/restoreToast';
import { exportObj, parseObj } from './io/obj';
import { EditableMesh } from './core/mesh/EditableMesh';
import { AddObjectsCommand } from './core/undo/objectCommands';
import type { OperatorContext } from './core/operator/Operator';
import './ui/theme.css';
import { applyStoredTheme } from './ui/themes';
import './ui/themes90s'; // side-effect: registers the six 90s themes (P10-3)

// Apply the persisted theme before any UI builds (CSS vars land on :root).
applyStoredTheme();

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const viewportWrap = canvas.parentElement as HTMLElement;
const statusEl = document.getElementById('status') as HTMLDivElement;

const ctx = createGlContext(canvas);
const renderer = new Renderer(ctx);
const scene = new Scene();
const camera = new OrbitCamera();
const undo = new UndoStack();

// The classic starting scene
const cube = scene.add('Cube', makeCube());
scene.selectOnly(cube.id);

const opCtx: OperatorContext = {
  scene,
  camera,
  undo,
  viewportSize: () => ({ width: canvas.clientWidth, height: canvas.clientHeight }),
  setStatus: (text) => { statusEl.textContent = text; },
};

// --- Autosave + crash restore (P6-4) ---------------------------------------
// Snapshot the pristine default scene (single Cube + default camera) NOW, before
// anything can mutate it — the boot prompt only fires when a stored autosave
// differs from this. The Autosave instance owns the 30s interval + save-on-hidden.
const pristineScene = serializeScene(scene, camera);
const autosave = new Autosave({ serialize: () => serializeScene(scene, camera) });

// --- Scene save / load (P3-2) ----------------------------------------------
/** Download the current scene as a .vibe.json file. */
function saveScene(): void {
  const json = serializeScene(scene, camera);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'scene.vibe.json';
  a.click();
  URL.revokeObjectURL(url);
  // The file is now the source of truth — drop the crash-restore autosave.
  autosave.clear();
  opCtx.setStatus('Saved scene.vibe.json');
}

/** Apply a saved scene string: exit edit mode, replace scene, drop undo history. */
function loadSceneJson(json: string): void {
  if (scene.editMode) scene.exitEditMode();
  applySceneJson(json, scene, camera);
  undo.clear();
  // Loading a file replaces the working scene — the stale autosave no longer applies.
  autosave.clear();
  opCtx.setStatus('Loaded scene');
}

/** Prompt for a .json file and load it (thin, untested DOM plumbing). */
function openScene(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    file.text().then(
      (text) => {
        try {
          loadSceneJson(text);
        } catch (err) {
          opCtx.setStatus(`Load failed: ${(err as Error).message}`);
        }
      },
      () => opCtx.setStatus('Load failed: could not read file'),
    );
  });
  input.click();
}

// --- OBJ export / import (P3-1) ---------------------------------------------
/** Download all visible objects as a world-space Wavefront .obj file. */
function exportObjFile(): void {
  const text = exportObj(scene);
  const blob = new Blob([text], { type: 'model/obj' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'scene.obj';
  a.click();
  URL.revokeObjectURL(url);
  opCtx.setStatus('Exported scene.obj');
}

/**
 * Apply a .obj string: parse it, add each object with identity transform (verts
 * are already world-space), select them (last = active), and push ONE undoable
 * AddObjectsCommand for the whole import. Throws on malformed input.
 */
function importObjText(text: string): void {
  const parsed = parseObj(text);
  const added = parsed.map((o) => scene.add(o.name, EditableMesh.fromData(o.positions, o.faces)));
  scene.selection.clear();
  for (const obj of added) scene.selection.add(obj.id);
  scene.activeId = added.at(-1)?.id ?? null;
  undo.push(new AddObjectsCommand('Import OBJ', scene, added));
  opCtx.setStatus(`Imported ${added.length} object${added.length === 1 ? '' : 's'}`);
}

/** Prompt for a .obj file and import it (thin, untested DOM plumbing). */
function importObjFile(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.obj';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    file.text().then(
      (text) => {
        try {
          importObjText(text);
        } catch (err) {
          opCtx.setStatus(`Import failed: ${(err as Error).message}`);
        }
      },
      () => opCtx.setStatus('Import failed: could not read file'),
    );
  });
  input.click();
}

// Shortcut cheat-sheet (F1 / "?" button). Mounted on <body> so it covers the
// whole window while open; InputManager swallows the keyboard while it is up.
const helpOverlay = new HelpOverlay(document.body);

// Viewport N-panel (P6-2): a slim Item sidebar overlaid on the viewport's right
// edge, toggled with N. Lives inside #viewport-wrap, not a workspace area.
const nPanel = new NPanel(viewportWrap, scene, undo);

// Passepartout (P10-2): darkens the viewport outside the 16:9 render frame while
// looking through a camera. Driven from the frame loop (like the panels below).
const passepartout = new Passepartout(viewportWrap, renderer, canvas);

new InputManager(canvas, opCtx, renderer, { save: saveScene, open: openScene }, helpOverlay, nPanel);

// F12 render engine (P8-4): owns its own keydown listener + result window.
// Browsers reserve F12 for devtools, so the topbar Render button drives the
// same toggle through the returned controls.
const renderEngine = initRenderEngine({ scene, camera, setStatus: opCtx.setStatus, host: document.body });

// First-visit splash inside #viewport-wrap. It auto-dismisses on the first canvas
// pointer event or any key (listeners below); dismiss() is idempotent so these
// fire harmlessly for the rest of the session.
const splash = new Splash(viewportWrap);
const dismissSplash = (): void => splash.dismiss();
canvas.addEventListener('pointerdown', dismissSplash);
window.addEventListener('keydown', dismissSplash);

// Idle hint sitting beside the status readout — a persistent nudge toward the
// shortcut sheet. Kept out of #status so it never collides with tool status text.
const idleHint = document.createElement('div');
idleHint.id = 'idle-hint';
idleHint.textContent = 'F1 — shortcuts';
viewportWrap.append(idleHint);

// --- ?scene=<url> deep link -------------------------------------------------
// Loads a scene file served relative to the app (e.g. ?scene=research/donut.
// vibe.json under the dev server). Skips the autosave-restore prompt: an
// explicit deep link IS the chosen scene. Fetch failures fall through to a
// normal boot with a status message.
const sceneParam = new URLSearchParams(location.search).get('scene');
if (sceneParam) {
  fetch(sceneParam)
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((text) => {
      loadSceneJson(text);
      opCtx.setStatus(`Loaded ${sceneParam.split('/').pop()}`);
    })
    .catch((err) => opCtx.setStatus(`Scene link failed: ${(err as Error).message}`));
}

// Crash-restore prompt: if a stored autosave exists and differs from the pristine
// default scene, offer to restore it. Mounted on <body> (non-blocking — see
// theme.css) so it coexists with the splash without racing its dismissal.
const storedAutosave = autosave.load();
if (!sceneParam && storedAutosave && storedAutosave.scene !== pristineScene) {
  new RestoreToast(document.body, {
    onRestore: () => {
      try {
        if (scene.editMode) scene.exitEditMode();
        applySceneJson(storedAutosave.scene, scene, camera);
        undo.clear();
        opCtx.setStatus('Restored previous session');
      } catch (err) {
        opCtx.setStatus(`Restore failed: ${(err as Error).message}`);
      }
    },
    onDiscard: () => {
      autosave.clear();
      opCtx.setStatus('Discarded autosave');
    },
  });
}
autosave.start();

// --- Workspaces (P4-1) -------------------------------------------------------
// The screen is a grid of areas, each hosting a switchable editor. The 3D
// viewport is a singleton editor wrapping #viewport-wrap (the WebGL canvas
// survives reparenting); panels are created fresh per area.
const editorFactories: EditorFactory[] = [
  {
    type: 'viewport',
    title: '3D Viewport',
    singleton: true,
    create: () => ({ element: viewportWrap, update: () => {} }),
  },
  {
    type: 'outliner',
    title: 'Outliner',
    create: () => {
      const panel = new OutlinerPanel(scene, undo);
      return wrapPanel('Outliner', panel);
    },
  },
  {
    type: 'properties',
    title: 'Properties',
    create: () => {
      const editor = new PropertiesEditor({ scene, undo });
      return wrapPanel('Properties', editor);
    },
  },
  {
    type: 'uv',
    title: 'UV Editor',
    create: () => new UVEditor({ scene, undo }),
  },
];

/** Adapt a Panel (element + update) into an editor instance with a title bar. */
function wrapPanel(title: string, panel: { element: HTMLElement; update(): void }) {
  const el = document.createElement('div');
  el.className = 'wsp-panel-host';
  const h = document.createElement('h3');
  h.className = 'panel-title';
  h.textContent = title;
  el.append(h, panel.element);
  return { element: el, update: () => panel.update() };
}

const DEFAULT_WORKSPACES: WorkspaceConfig[] = [
  {
    name: 'Layout',
    columns: [
      { size: 0.78, areas: [{ editor: 'viewport', size: 1 }] },
      { size: 0.22, areas: [{ editor: 'outliner', size: 0.38 }, { editor: 'properties', size: 0.62 }] },
    ],
  },
  {
    name: 'Modeling',
    columns: [
      { size: 0.84, areas: [{ editor: 'viewport', size: 1 }] },
      { size: 0.16, areas: [{ editor: 'properties', size: 1 }] },
    ],
  },
  // NOTE: a dedicated 'UV Editing' workspace is intentionally NOT added — the
  // frozen workspace e2e asserts exactly two tabs. The 'UV Editor' is reachable
  // from any area's editor dropdown instead (like switching any editor type).
];

const workspaceRoot = document.getElementById('workspace-root') as HTMLElement;
const workspaces = new WorkspaceManager(workspaceRoot, editorFactories, DEFAULT_WORKSPACES);

// The header bar fills #topbar and is updated directly in the frame loop
// alongside workspaces.update().
const topbar = new Topbar(scene, renderer, {
  saveScene, openScene,
  exportObj: exportObjFile,
  importObj: importObjFile,
  toggleHelp: () => helpOverlay.toggle(),
  toggleRender: () => renderEngine.toggle(),
});
topbar.mountTabs(workspaces.createTabs());

// Debug/test handle (used by e2e smoke tests; harmless in production).
// __app.io exposes the same serialize/apply the buttons use, for e2e.
(window as unknown as Record<string, unknown>).__app = {
  scene, camera, undo, renderer, workspaces, nPanel,
  autosave: {
    saveNow: () => autosave.saveNow(),
    clear: () => autosave.clear(),
  },
  io: {
    serialize: () => serializeScene(scene, camera),
    apply: (json: string) => loadSceneJson(json),
    exportObj: () => exportObj(scene),
    importObj: (text: string) => importObjText(text),
  },
};

function frame(): void {
  renderer.render(scene, camera);
  workspaces.update();
  topbar.update();
  nPanel.update();
  passepartout.update();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
