import type { Scene } from '../core/scene/Scene';
import type { OrbitCamera } from '../camera/OrbitCamera';

/** Everything the render engine needs from the app shell. */
export interface RenderEngineContext {
  scene: Scene;
  camera: OrbitCamera;
  setStatus: (text: string) => void;
  /** Host element the render-result window mounts into (document.body). */
  host: HTMLElement;
}

/**
 * Wire up the F12 render engine (P8-4). STUB — the P8-4 worker owns this
 * directory. Must install its own window keydown listener for F12 (and Esc
 * while its window is open); it does NOT touch InputManager.
 */
export function initRenderEngine(_ctx: RenderEngineContext): void {
  // P8-4 fills this in.
}
