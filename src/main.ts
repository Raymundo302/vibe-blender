import { createGlContext } from './render/gl/context';
import { Renderer } from './render/Renderer';
import { Scene } from './core/scene/Scene';
import { OrbitCamera } from './camera/OrbitCamera';
import { UndoStack } from './core/undo/UndoStack';
import { makeCube } from './core/mesh/primitives';
import { InputManager } from './input/InputManager';
import { UiShell } from './ui/shell';
import { OutlinerPanel } from './ui/outliner';
import { PropertiesPanel } from './ui/properties';
import { Topbar } from './ui/topbar';
import { serializeScene, applySceneJson } from './io/sceneJson';
import { exportObj, parseObj } from './io/obj';
import { EditableMesh } from './core/mesh/EditableMesh';
import { AddObjectsCommand } from './core/undo/objectCommands';
import type { OperatorContext } from './core/operator/Operator';
import './ui/theme.css';

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
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
  opCtx.setStatus('Saved scene.vibe.json');
}

/** Apply a saved scene string: exit edit mode, replace scene, drop undo history. */
function loadSceneJson(json: string): void {
  if (scene.editMode) scene.exitEditMode();
  applySceneJson(json, scene, camera);
  undo.clear();
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

new InputManager(canvas, opCtx, renderer, { save: saveScene, open: openScene });
const shell = new UiShell();
shell.addPanel(new OutlinerPanel(scene, undo));
shell.addPanel(new PropertiesPanel(scene, undo));
// Float the panel over the viewport's right edge rather than docking it, so the
// sidebar doesn't shrink the canvas and invalidate viewport-space coordinates
// (picking + e2e). See the .outliner-floating rule in outliner.ts for why.
shell.sidebar.classList.add('outliner-floating');

// The header bar is not a sidebar Panel — it fills #topbar and is updated
// directly in the frame loop alongside shell.update().
const topbar = new Topbar(scene, {
  saveScene, openScene,
  exportObj: exportObjFile,
  importObj: importObjFile,
});

// Debug/test handle (used by e2e smoke tests; harmless in production).
// __app.io exposes the same serialize/apply the buttons use, for e2e.
(window as unknown as Record<string, unknown>).__app = {
  scene, camera, undo, renderer, shell,
  io: {
    serialize: () => serializeScene(scene, camera),
    apply: (json: string) => loadSceneJson(json),
    exportObj: () => exportObj(scene),
    importObj: (text: string) => importObjText(text),
  },
};

function frame(): void {
  renderer.render(scene, camera);
  shell.update();
  topbar.update();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
