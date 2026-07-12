/**
 * UR12-3 — one shared GpuTracer (one WebGL2 context) reused across every GPU
 * render: the F12 render window AND the Ctrl+F12 animation path both call
 * getGpuTracer(), so the app never allocates more than a single offscreen GL
 * context / program / accumulation buffer for path tracing. Lazily constructed
 * on first use; the two render entry points never run concurrently (both are
 * modal), so sharing the accumulation state is safe — each render calls
 * beginProgressive()/setSnapshot() which resets it.
 */

import { GpuTracer } from './gpuTracer';

let instance: GpuTracer | null = null;

/** The process-wide GpuTracer, constructed on first call. */
export function getGpuTracer(): GpuTracer {
  if (!instance) instance = new GpuTracer();
  return instance;
}
