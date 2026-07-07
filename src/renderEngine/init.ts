import type { Scene } from '../core/scene/Scene';
import type { OrbitCamera } from '../camera/OrbitCamera';
import { RenderWindow } from './renderWindow';
import { buildSnapshot } from './snapshot';

/** Everything the render engine needs from the app shell. */
export interface RenderEngineContext {
  scene: Scene;
  camera: OrbitCamera;
  setStatus: (text: string) => void;
  /** Host element the render-result window mounts into (document.body). */
  host: HTMLElement;
}

/**
 * Wire up the F12 render engine (P8-4). F12 toggles a progressive path-traced
 * render of the scene (from the active camera, else the viewport view) in a
 * DOM window; the heavy tracing runs in a Web Worker so the app stays live.
 * While the window is open, Esc closes it (stopPropagation so it doesn't leak
 * into other window-level handlers); F12 always toggles.
 */
/** Controls handed back to the app shell (topbar Render button). */
export interface RenderEngineControls {
  /** Open + start a render, or close the window if it is open (F12 behavior). */
  toggle(): void;
}

export function initRenderEngine(ctx: RenderEngineContext): RenderEngineControls {
  const win = new RenderWindow(ctx.host);
  let worker: Worker | null = null;
  let startTime = 0;

  const stopWorker = (): void => {
    if (worker) {
      worker.postMessage({ type: 'stop' });
      worker.terminate();
      worker = null;
    }
  };

  const startRender = (): void => {
    stopWorker();
    const snapshot = buildSnapshot(ctx.scene, ctx.camera);
    // Depth of field: aperture from the render window, focus distance from the
    // window if the user set one, else the snapshot's auto (bounding-box) value.
    snapshot.camera.aperture = win.aperture;
    win.showAutoFocus(snapshot.camera.focusDistance ?? 5);
    if (win.focusDistance !== null) snapshot.camera.focusDistance = win.focusDistance;
    win.open();
    win.reset();
    startTime = performance.now();
    const camLabel = ctx.scene.activeCamera ? 'active camera' : 'viewport view';
    ctx.setStatus(`Rendering (${camLabel})…`);

    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg && msg.type === 'frame') {
        win.updateFrame(msg.accum as Float32Array, msg.sample as number, performance.now() - startTime);
      }
    };
    worker.postMessage({
      type: 'start',
      snapshot,
      width: win.width,
      height: win.height,
      seed: 0x1234567,
    });
  };

  const close = (): void => {
    stopWorker();
    win.close();
    ctx.setStatus('Render closed');
  };

  win.onClose = close;
  // Changing aperture / focus distance re-renders from scratch (worker restart).
  win.onParamsChange = () => { if (win.isOpen) startRender(); };

  window.addEventListener('keydown', (e) => {
    if (e.key === 'F12') {
      e.preventDefault();
      if (win.isOpen) close();
      else startRender();
      return;
    }
    if (win.isOpen && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });

  // Debug handle for e2e (mirrors the __app pattern; harmless in production).
  (window as unknown as Record<string, unknown>).__renderEngine = {
    isOpen: () => win.isOpen,
    sample: () => win.sample,
    canvas: () => win.canvas,
    start: startRender,
    close,
    /** Set aperture radius (0 = pinhole) and re-render if open. */
    setAperture: (v: number) => { win.setAperture(v); if (win.isOpen) startRender(); },
    /** Set focus distance (null = auto) and re-render if open. */
    setFocusDistance: (v: number | null) => { win.setFocusDistance(v); if (win.isOpen) startRender(); },
  };

  return { toggle: () => (win.isOpen ? close() : startRender()) };
}
