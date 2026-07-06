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
import type { OperatorContext } from './core/operator/Operator';

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

new InputManager(canvas, opCtx, renderer);
const shell = new UiShell();
shell.addPanel(new OutlinerPanel(scene, undo));
shell.addPanel(new PropertiesPanel(scene, undo));
// Float the panel over the viewport's right edge rather than docking it, so the
// sidebar doesn't shrink the canvas and invalidate viewport-space coordinates
// (picking + e2e). See the .outliner-floating rule in outliner.ts for why.
shell.sidebar.classList.add('outliner-floating');

// Debug/test handle (used by e2e smoke tests; harmless in production)
(window as unknown as Record<string, unknown>).__app = { scene, camera, undo, renderer, shell };

function frame(): void {
  renderer.render(scene, camera);
  shell.update();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
