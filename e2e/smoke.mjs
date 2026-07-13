/**
 * Headless end-to-end smoke test driven over the Chrome DevTools Protocol.
 * No dependencies — uses Node's built-in WebSocket (Node 22+).
 *
 * Usage: start the dev server, then `node e2e/smoke.mjs [url]`.
 * Checks: app boots, cube selected, G-translate moves it, LMB confirms,
 * Ctrl+Z restores, Ctrl+Shift+Z re-applies.
 */
import { spawn } from 'node:child_process';

const APP_URL = process.argv[2] ?? 'http://localhost:5199/';
const PORT = 9222;
const CHROME = process.env.CHROME_BIN ?? 'google-chrome-stable';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--use-angle=swiftshader',
  `--remote-debugging-port=${PORT}`, '--window-size=1280,800',
  `--user-data-dir=/tmp/vibe-blender-e2e-profile-${process.pid}`, 'about:blank',
], { stdio: 'ignore' });

const cleanup = () => {
  try { chrome.kill(); } catch { /* already dead */ }
  import('node:fs').then((fs) => fs.rmSync(`/tmp/vibe-blender-e2e-profile-${process.pid}`, { recursive: true, force: true })).catch(() => {});
};
process.on('exit', cleanup);

async function waitForDevtools() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://localhost:${PORT}/json/version`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Chrome devtools endpoint never came up');
}

let msgId = 0;
const pending = new Map();
let ws;

function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression, returnByValue: true,
  });
  if (exceptionDetails) throw new Error(`page threw: ${exceptionDetails.text} ${expression}`);
  return result.value;
}

async function mouse(type, x, y, button = 'none', extra = {}) {
  await send('Input.dispatchMouseEvent', {
    type, x, y, button,
    clickCount: type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0,
    ...extra,
  });
}

async function key(keyName, code, modifiers = 0, extra = {}) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, modifiers, ...extra });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, modifiers, ...extra });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

try {
  await waitForDevtools();
  const target = await (await fetch(`http://localhost:${PORT}/json/new?${encodeURIComponent(APP_URL)}`, { method: 'PUT' })).json();

  ws = new WebSocket(target.webSocketDebuggerUrl);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

  await send('Runtime.enable');
  // Wait for the app to boot
  let booted = false;
  for (let i = 0; i < 50 && !booted; i++) {
    booted = await evaluate('!!window.__app');
    if (!booted) await sleep(200);
  }
  check('app boots and exposes __app', booted);
  if (!booted) throw new Error('app never booted');

  const pos = () => evaluate('(() => { const p = window.__app.scene.objects[0].transform.position; return [p.x, p.y, p.z]; })()');
  // Canvas-relative click points — the workspace layout means the canvas no
  // longer spans the whole window, so never hardcode page coordinates.
  const rect = await evaluate('(() => { const r = document.querySelector("canvas").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()');
  const cv = (fx, fy) => [Math.round(rect.x + rect.w * fx), Math.round(rect.y + rect.h * fy)];
  const [bgX, bgY] = cv(0.08, 0.12);       // empty corner
  const [cubeX, cubeY] = cv(0.5, 0.48);    // cube sits at canvas center
  const [dragX, dragY] = [cubeX + 100, cubeY]; // move target
  const status = () => evaluate('document.getElementById("status").textContent');

  check('default scene (Cube + Camera + Spot), cube selected',
    await evaluate('window.__app.scene.objects.length === 3 && window.__app.scene.objects[0].name === "Cube" && window.__app.scene.selection.has(window.__app.scene.objects[0].id)'));

  const start = await pos();
  check('cube starts at origin', start.every((v) => v === 0), start.join(','));

  // Click empty space deselects, click cube re-selects
  await mouse('mouseMoved', bgX, bgY);
  await mouse('mousePressed', bgX, bgY, 'left');
  await mouse('mouseReleased', bgX, bgY, 'left');
  await sleep(150);
  check('click on background deselects', await evaluate('window.__app.scene.selection.size === 0'));

  await mouse('mouseMoved', cubeX, cubeY);
  await mouse('mousePressed', cubeX, cubeY, 'left');
  await mouse('mouseReleased', cubeX, cubeY, 'left');
  await sleep(150);
  check('click on cube selects it', await evaluate('window.__app.scene.selection.size === 1'));

  // G → move mouse → status shows modal state → LMB confirms
  await key('g', 'KeyG');
  await sleep(100);
  await mouse('mouseMoved', dragX, dragY);
  await sleep(100);
  check('G starts Move operator', (await status()).startsWith('Move'), await status());

  const during = await pos();
  check('pointer move translates the cube', Math.abs(during[0]) + Math.abs(during[1]) + Math.abs(during[2]) > 0.1, during.map((v) => v.toFixed(2)).join(','));

  await mouse('mousePressed', dragX, dragY, 'left');
  await mouse('mouseReleased', dragX, dragY, 'left');
  await sleep(100);
  const confirmed = await pos();
  check('LMB confirms the move', JSON.stringify(confirmed) === JSON.stringify(during), '');
  check('status cleared after confirm', (await status()) === '');

  // Undo / redo
  await key('z', 'KeyZ', 2); // ctrl
  await sleep(100);
  const undone = await pos();
  check('Ctrl+Z restores origin', undone.every((v) => Math.abs(v) < 1e-6), undone.join(','));

  await key('z', 'KeyZ', 2 | 8); // ctrl+shift
  await sleep(100);
  const redone = await pos();
  check('Ctrl+Shift+Z re-applies', Math.abs(redone[0] - confirmed[0]) < 1e-6, '');

  // G then Escape cancels
  await key('g', 'KeyG');
  await mouse('mouseMoved', cubeX - 80, cubeY - 60);
  await sleep(100);
  await key('Escape', 'Escape');
  await sleep(100);
  const cancelled = await pos();
  check('Esc cancels a move', Math.abs(cancelled[0] - redone[0]) < 1e-6, '');

  const errors = await evaluate('window.__vibeErrors ?? 0');
  void errors; // page-level error hook not installed; rely on exceptions surfacing via evaluate

  console.log(failures === 0 ? '\nAll e2e checks passed.' : `\n${failures} e2e check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
} catch (err) {
  console.error('E2E harness error:', err.message);
  process.exit(2);
} finally {
  cleanup();
}
