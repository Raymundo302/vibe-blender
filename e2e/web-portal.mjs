/**
 * UR7-3 — URL web planes: add dialog, live iframe portal, pause.
 *
 * Verifies (against the vite dev server serving /research/bouncy-ball.html, a
 * same-origin page):
 *  (1) Shift+A ▸ Image ▸ HTML / Website… opens the dialog; typing an address +
 *      Load creates a URL plane and a live portal <iframe> carrying a matrix3d
 *      transform; orbiting the camera CHANGES the matrix (frame-matched sync).
 *  (2) Tab (Page Mode) gives the iframe pointer-events; Tab out removes them.
 *  (3) Pause hides the portal and rasters the same-origin page onto the plane
 *      (pixel probe); Play brings the portal back.
 *  (4) Scene save→load: the plane is present + PAUSED with no iframe until ▶.
 *
 * The UR7-1/2 file-plane checks live in e2e/html-plane.mjs (still green).
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  await t.key('Escape', 'Escape', 0); // dismiss splash

  // Clean scene + a camera pose that frames the ground plane at an angle.
  await t.evaluate(`(() => {
    const S = window.__app.scene;
    for (const o of [...S.objects]) S.remove(o.id);
    window.__app.undo.clear();
    const cam = window.__app.camera;
    cam.yaw = 0.7; cam.pitch = 0.95; cam.distance = 7;
    cam.target && cam.target.set ? cam.target.set(0,0,0) : null;
    window.__app.renderer.cameraViewId = null;
    window.__URL = location.origin + '/research/bouncy-ball.html';
  })()`);

  // ── (1) Dialog opens via Shift+A ▸ Image ▸ HTML / Website… ────────────────
  await t.evaluate(`(() => {
    const wrap = document.querySelector('#viewport-wrap') || document.querySelector('canvas').parentElement;
    const r = wrap.getBoundingClientRect();
    window.__app.input.pointer.x = r.width/2; window.__app.input.pointer.y = r.height/2;
  })()`);
  await t.key('a', 'KeyA', 8); // Shift+A
  await t.sleep(60);
  await t.evaluate(`(() => {
    const row = document.querySelector('.add-menu-category[data-category="Image"]');
    row.dispatchEvent(new MouseEvent('mouseenter'));
  })()`);
  await t.sleep(40);
  const opened = await t.evaluate(`(() => {
    const items = [...document.querySelectorAll('.add-menu-flyout .add-menu-item')];
    const item = items.find((b) => b.textContent === 'HTML / Website…');
    if (!item) return { found: false };
    item.click();
    return { found: true, dialog: !!document.querySelector('.web-add-dialog'),
      input: !!document.querySelector('.web-add-input'),
      loadBtn: !!document.querySelector('.web-add-load'),
      openBtn: !!document.querySelector('.web-add-open'),
      menuGone: !document.querySelector('.add-menu-category') };
  })()`);
  t.check('Image flyout has the HTML / Website… item', opened.found === true);
  t.check('clicking it opens the centered dialog with input + Load + Open… (menu closed): ' + JSON.stringify(opened),
    opened.dialog && opened.input && opened.loadBtn && opened.openBtn && opened.menuGone);

  // Type the same-origin address and click Load.
  await t.evaluate(`(() => {
    const input = document.querySelector('.web-add-input');
    input.value = window.__URL;
    document.querySelector('.web-add-load').click();
  })()`);

  // The URL plane is added asynchronously (card rasterizes first).
  t.check('Load creates a URL plane (kind url, playing true by default)',
    await t.until(`(() => {
      const S = window.__app.scene;
      const p = S.objects.find((o) => o.html && o.html.kind === 'url');
      return !!p && p.html.playing === true;
    })()`, 10000));
  const planeInfo = await t.evaluate(`(() => {
    const S = window.__app.scene;
    const p = S.objects.find((o) => o.html && o.html.kind === 'url');
    return { kind: p.html.kind, source: p.html.source, playing: p.html.playing,
      shadeless: !!S.getMaterial(p.materialId).shadeless, id: p.id };
  })()`);
  t.check('URL plane payload: kind url, address stored, playing, shadeless emit: ' + JSON.stringify(planeInfo),
    planeInfo.kind === 'url' && planeInfo.source === (await t.evaluate('window.__URL')) &&
    planeInfo.playing === true && planeInfo.shadeless === true);
  t.check('dialog closed after Load', await t.evaluate('!document.querySelector(".web-add-dialog")'));

  // Portal iframe exists with a sandbox + matrix3d transform.
  t.check('a live portal <iframe> is overlaid with a matrix3d transform',
    await t.until(`(() => {
      const f = document.querySelector('#html-portal-layer iframe.html-portal');
      return !!f && f.style.display !== 'none' && f.style.transform.includes('matrix3d');
    })()`, 8000));
  const frameAttrs = await t.evaluate(`(() => {
    const f = document.querySelector('#html-portal-layer iframe.html-portal');
    return { sandbox: f.getAttribute('sandbox'), referrer: f.getAttribute('referrerpolicy'),
      src: f.src, w: f.style.width, h: f.style.height };
  })()`);
  t.check('iframe is sandboxed (scripts/same-origin/forms, no top-nav/popups) + no-referrer: ' + JSON.stringify(frameAttrs),
    frameAttrs.sandbox === 'allow-scripts allow-same-origin allow-forms' &&
    frameAttrs.referrer === 'no-referrer' && frameAttrs.src.includes('bouncy-ball.html') &&
    frameAttrs.w === '1024px' && frameAttrs.h === '768px');

  // Orbit the camera → the matrix3d CHANGES (frame-matched CSS3D sync).
  const m1 = await t.evaluate(`document.querySelector('#html-portal-layer iframe.html-portal').style.transform`);
  await t.evaluate('window.__app.camera.yaw += 0.6; window.__app.camera.pitch += 0.15;');
  await t.sleep(120); // let the frame loop re-sync
  const m2 = await t.evaluate(`document.querySelector('#html-portal-layer iframe.html-portal').style.transform`);
  t.check('portal matrix3d CHANGES when the camera orbits', m1 !== m2 && m2.includes('matrix3d'));

  // ── (2) Page Mode → iframe gets pointer-events; Tab out → none ────────────
  await t.evaluate(`(() => {
    const S = window.__app.scene;
    const p = S.objects.find((o) => o.html && o.html.kind === 'url');
    S.selectOnly(p.id);
  })()`);
  await t.sleep(40);
  await t.key('Tab', 'Tab', 0); // enter Page Mode
  await t.sleep(120);
  const pmOn = await t.evaluate(`(() => {
    const f = document.querySelector('#html-portal-layer iframe.html-portal');
    return { pe: f.style.pointerEvents, interactive: f.classList.contains('interactive'),
      inPage: !!window.__app.input && !!window.__app.scene };
  })()`);
  t.check('Page Mode gives the iframe pointer-events:auto (interactive site): ' + JSON.stringify(pmOn),
    pmOn.pe === 'auto' && pmOn.interactive === true);
  await t.key('Tab', 'Tab', 0); // exit Page Mode
  await t.sleep(120);
  const pmOff = await t.evaluate(`document.querySelector('#html-portal-layer iframe.html-portal').style.pointerEvents`);
  t.check('Tab out removes the iframe pointer-events (viewport input back): ' + JSON.stringify(pmOff),
    pmOff === 'none');

  // ── (3) Pause hides the portal + rasters the page; Play brings it back ────
  const cardUrl = await t.evaluate(`(() => {
    const S = window.__app.scene;
    const p = S.objects.find((o) => o.html && o.html.kind === 'url');
    return S.getMaterial(p.materialId).texDataUrl;
  })()`);
  await t.evaluate(`(() => {
    const S = window.__app.scene;
    const p = S.objects.find((o) => o.html && o.html.kind === 'url');
    p.html.playing = false; // pause
  })()`);
  t.check('Pause hides the portal iframe',
    await t.until(`document.querySelector('#html-portal-layer iframe.html-portal').style.display === 'none'`, 4000));

  // The same-origin page is CORS-fetched + rastered onto the plane texture:
  // the texDataUrl changes from the neutral card to a page-coloured image.
  t.check('paused: the same-origin page rasters onto the plane (texDataUrl changed from the card)',
    await t.until(`(() => {
      const S = window.__app.scene;
      const p = S.objects.find((o) => o.html && o.html.kind === 'url');
      const u = S.getMaterial(p.materialId).texDataUrl;
      return typeof u === 'string' && u.startsWith('data:image/png') && u !== window.__cardUrl;
    })()`.replace('window.__cardUrl', JSON.stringify(cardUrl)), 10000));

  // Pixel probe: decode the paused texture and confirm a strongly-BLUE pixel
  // (the bouncy-ball page's #0f3460 gradient) — the grey card has none.
  await t.evaluate(`(() => {
    window.__pxOut = null;
    const S = window.__app.scene;
    const p = S.objects.find((o) => o.html && o.html.kind === 'url');
    const u = S.getMaterial(p.materialId).texDataUrl;
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const cx = c.getContext('2d'); cx.drawImage(img, 0, 0);
      const d = cx.getImageData(0, 0, c.width, c.height).data;
      let blue = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i+2] > d[i] + 30 && d[i+2] > d[i+1] + 10 && d[i+2] > 60) { blue++; }
      }
      window.__pxOut = { blue, total: d.length/4 };
    };
    img.onerror = () => { window.__pxOut = { error: true }; };
    img.src = u;
  })()`);
  t.check('paused texture pixel probe resolved', await t.until('!!window.__pxOut', 8000));
  const px = await t.evaluate('window.__pxOut');
  t.check('paused plane shows the PAGE (blue gradient pixels present, not the grey card): ' + JSON.stringify(px),
    !px.error && px.blue > 200);

  // Play again → the portal returns (iframe visible with a matrix3d transform).
  await t.evaluate(`(() => {
    const S = window.__app.scene;
    const p = S.objects.find((o) => o.html && o.html.kind === 'url');
    p.html.playing = true;
  })()`);
  t.check('Play brings the portal back (iframe visible again)',
    await t.until(`(() => {
      const f = document.querySelector('#html-portal-layer iframe.html-portal');
      return !!f && f.style.display !== 'none' && f.style.transform.includes('matrix3d');
    })()`, 4000));

  // Eyes-on: the portal showing bouncy-ball.html on the plane at an angle.
  await t.sleep(400); // let the iframe load its content for the shot
  await t.screenshot('/home/raymundo/Vibe Coded Blender/research/web-portal.png');

  // ── (4) Save → load: plane present, PAUSED, no iframe until ▶ ─────────────
  const saved = await t.evaluate('window.__app.io.serialize()');
  await t.evaluate(`window.__saved = ${JSON.stringify(saved)}`);
  await t.evaluate('window.__app.io.apply(window.__saved)');
  await t.sleep(200); // frame loop settles after load
  const afterLoad = await t.evaluate(`(() => {
    const S = window.__app.scene;
    const p = S.objects.find((o) => o.html && o.html.kind === 'url');
    const frames = document.querySelectorAll('#html-portal-layer iframe.html-portal');
    // Count only the VISIBLE portals (a hidden pooled iframe would still be display:none).
    let visible = 0;
    frames.forEach((f) => { if (f.style.display !== 'none') visible++; });
    return { present: !!p, playing: p ? p.html.playing : null, visiblePortals: visible };
  })()`);
  t.check('after load: the URL plane is present and PAUSED (playing false): ' + JSON.stringify(afterLoad),
    afterLoad.present === true && afterLoad.playing === false);
  t.check('after load: NO live portal iframe until ▶ (no surprise network on file open)',
    afterLoad.visiblePortals === 0);

  // Pressing ▶ (playing = true) brings the portal up (network happens now, not on open).
  await t.evaluate(`(() => {
    const S = window.__app.scene;
    const p = S.objects.find((o) => o.html && o.html.kind === 'url');
    S.selectOnly(p.id);
    p.html.playing = true;
  })()`);
  t.check('▶ after load creates + shows the portal',
    await t.until(`(() => {
      const f = document.querySelector('#html-portal-layer iframe.html-portal');
      return !!f && f.style.display !== 'none' && f.style.transform.includes('matrix3d');
    })()`, 6000));
});
