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

const MAX_SAMPLES = 512;

let running = false;
let scene: TraceScene | null = null;
let accum: Float32Array | null = null;
let width = 0;
let height = 0;
let seed = 1;
let sample = 0;

interface StartMsg {
  type: 'start';
  snapshot: Snapshot;
  width: number;
  height: number;
  seed?: number;
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
  scene = prepareScene(msg.snapshot);
  accum = new Float32Array(width * height * 3);
  loop();
}

function loop(): void {
  if (!running || !scene || !accum) return;
  renderSample(scene, accum, width, height, sample, seed);
  sample++;
  // Post a copy so we can keep accumulating into the live buffer.
  const frame = accum.slice();
  ctx.postMessage(
    { type: 'frame', accum: frame, sample, width, height },
    [frame.buffer],
  );
  if (running && sample < MAX_SAMPLES) {
    // Yield so 'stop' messages are processed between passes.
    setTimeout(loop, 0);
  }
}
