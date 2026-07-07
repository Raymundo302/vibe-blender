/**
 * Shared headless-Chrome CDP harness for e2e tests. No dependencies —
 * Node 22+ built-in WebSocket + fetch.
 *
 * Usage:
 *   import { runE2e } from './harness.mjs';
 *   runE2e(async (t) => {
 *     t.check('label', await t.evaluate('1+1') === 2);
 *   });
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const PORT = 9222;

export function runE2e(testFn, { url = process.argv[2] ?? 'http://localhost:5199/' } = {}) {
  main(testFn, url).catch((err) => {
    console.error('E2E harness error:', err.message);
    process.exit(2);
  });
}

async function main(testFn, url) {
  const chrome = spawn(process.env.CHROME_BIN ?? 'google-chrome-stable', [
    '--headless=new', '--disable-gpu', '--use-angle=swiftshader',
    `--remote-debugging-port=${PORT}`, '--window-size=1280,800',
    `--user-data-dir=/tmp/vibe-blender-e2e-profile-${process.pid}`, 'about:blank',
  ], { stdio: 'ignore' });
  // MUST be synchronous: async work scheduled inside 'exit' never runs, which
  // used to leak one ~100MB chrome profile per run until /tmp (tmpfs) filled.
  const cleanup = () => {
    try { chrome.kill(); } catch { /* already dead */ }
    try { rmSync(`/tmp/vibe-blender-e2e-profile-${process.pid}`, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  process.on('exit', cleanup);

  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://localhost:${PORT}/json/version`)).ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }

  const target = await (
    await fetch(`http://localhost:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
  ).json();

  let msgId = 0;
  const pending = new Map();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

  const send = (method, params = {}) => {
    const id = ++msgId;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };

  await send('Runtime.enable');
  await send('Page.enable');

  let failures = 0;
  const t = {
    send,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),

    async evaluate(expression) {
      const { result, exceptionDetails } = await send('Runtime.evaluate', {
        expression, returnByValue: true,
      });
      if (exceptionDetails) throw new Error(`page threw: ${exceptionDetails.text} ${expression}`);
      return result.value;
    },

    async mouse(type, x, y, button = 'none', extra = {}) {
      await send('Input.dispatchMouseEvent', {
        type, x, y, button,
        clickCount: type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0,
        ...extra,
      });
    },

    async click(x, y, button = 'left', modifiers = 0) {
      await t.mouse('mouseMoved', x, y, 'none', { modifiers });
      await t.mouse('mousePressed', x, y, button, { modifiers });
      await t.mouse('mouseReleased', x, y, button, { modifiers });
      await t.sleep(120);
    },

    /** modifiers bitmask: alt=1, ctrl=2, meta=4, shift=8 */
    async key(keyName, code, modifiers = 0, extra = {}) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, modifiers, ...extra });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, modifiers, ...extra });
      await t.sleep(100);
    },

    async screenshot(path) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path, Buffer.from(data, 'base64'));
      return path;
    },

    check(label, ok, detail = '') {
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
      if (!ok) failures++;
    },

    /**
     * Reload the page SAFELY: waits for the new document's load event before
     * polling for __app, so until() can never sample the stale pre-reload
     * context (it stays alive for a beat after Page.reload acks — sampling it
     * returns a false "ready" and later evaluates hit a destroyed context).
     */
    async reload() {
      const loaded = new Promise((resolve) => {
        const onMsg = (ev) => {
          if (JSON.parse(ev.data).method === 'Page.loadEventFired') {
            ws.removeEventListener('message', onMsg);
            resolve();
          }
        };
        ws.addEventListener('message', onMsg);
      });
      await send('Page.reload', {});
      await loaded;
      await t.until('!!window.__app');
      await t.sleep(100); // frame loop + panels settle
    },

    /** Wait until an evaluated expression is truthy (app boot, async UI).
     * Evaluate errors are retried, not thrown — Runtime.evaluate fails
     * transiently while a Page.reload navigation is in flight. */
    async until(expression, timeoutMs = 10000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          if (await t.evaluate(expression)) return true;
        } catch { /* navigation in flight — retry */ }
        await t.sleep(200);
      }
      return false;
    },
  };

  try {
    t.check('app boots and exposes __app', await t.until('!!window.__app'));
    await testFn(t);
  } catch (err) {
    // A suite abort must read as a failure — without this, an exception
    // mid-suite skips remaining checks and still prints "All passed".
    console.error(`SUITE ABORTED: ${err.message}`);
    failures++;
  } finally {
    console.log(failures === 0 ? '\nAll e2e checks passed.' : `\n${failures} e2e check(s) FAILED.`);
    cleanup();
    process.exit(failures === 0 ? 0 : 1);
  }
}
