import { createGlContext } from './render/gl/context';
import { Renderer } from './render/Renderer';
import { Scene } from './core/scene/Scene';
import { OrbitCamera } from './camera/OrbitCamera';
import { UndoStack } from './core/undo/UndoStack';
import { makeCube } from './core/mesh/primitives';
import { InputManager } from './input/InputManager';
import { UiShell } from './ui/shell';
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

// Debug/test handle (used by e2e smoke tests; harmless in production)
(window as unknown as Record<string, unknown>).__app = { scene, camera, undo, renderer, shell };

function frame(): void {
  renderer.render(scene, camera);
  shell.update();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
