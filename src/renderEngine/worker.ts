import type { Snapshot } from './snapshot';
import { prepareScene, renderSample, type TraceScene } from './tracer';

/**
 * Path-tracing Web Worker (P8-4). Receives a plain Snapshot + output size,
 * then loops sample passes, posting the running accumulation buffer + sample
 * count back to the main thread after each pass. A 'stop' message halts the
 * loop so the worker can be terminated cleanly.
 *
 * Typed against DOM's `Worker` interface (postMessage(message, transfer?) with
 * no targetOrigin) since the WebWorker lib isn't in tsconfig; at runtime `self`
 * is the dedicated worker global.
 */
const ctx = self as unknown as Worker;

const DEFAULT_MAX_SAMPLES = 512;

let running = false;
let scene: TraceScene | null = null;
let accum: Float32Array | null = null;
/** Transparent-film coverage (UR16-3), allocated only when the snapshot asks. */
let coverage: Float32Array | null = null;
let width = 0;
let height = 0;
let seed = 1;
let sample = 0;
let maxSamples = DEFAULT_MAX_SAMPLES;

interface StartMsg {
  type: 'start';
  snapshot: Snapshot;
  width: number;
  height: number;
  seed?: number;
  /** F12 samples cap (UR16-3). Absent → 512 (historical default). */
  maxSamples?: number;
}
interface StopMsg { type: 'stop'; }
type InMsg = StartMsg | StopMsg;

ctx.onmessage = (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  if (msg.type === 'start') {
    start(msg);
  } else if (msg.type === 'stop') {
    running = false;
  }
};

function start(msg: StartMsg): void {
  running = true;
  width = msg.width;
  height = msg.height;
  seed = (msg.seed ?? 1) >>> 0;
  sample = 0;
  maxSamples = Math.max(1, Math.round(msg.maxSamples ?? DEFAULT_MAX_SAMPLES));
  scene = prepareScene(msg.snapshot);
  accum = new Float32Array(width * height * 3);
  // Transparent film (UR16-3): accumulate coverage alongside radiance so the
  // main thread can present straight alpha. Only when the snapshot asks for it.
  coverage = scene.transparent ? new Float32Array(width * height) : null;
  loop();
}

function loop(): void {
  if (!running || !scene || !accum) return;
  renderSample(scene, accum, width, height, sample, seed, coverage ?? undefined);
  sample++;
  // Post a copy so we can keep accumulating into the live buffer. When
  // transparent, ship a coverage copy too (transferred alongside).
  const frame = accum.slice();
  const transfer: ArrayBuffer[] = [frame.buffer as ArrayBuffer];
  let cov: Float32Array | undefined;
  if (coverage) { cov = coverage.slice(); transfer.push(cov.buffer as ArrayBuffer); }
  ctx.postMessage(
    { type: 'frame', accum: frame, sample, width, height, coverage: cov },
    transfer,
  );
  if (running && sample < maxSamples) {
    // Yield so 'stop' messages are processed between passes.
    setTimeout(loop, 0);
  }
}
