/**
 * UR4-4 — Shift+A ▸ Image ▸ HTML Snapshot… / HTML Live… (rasterized HTML planes).
 *
 * Drives htmlPlane.ts's exported addHtmlPlaneFromText / pickHtmlLive directly
 * (bypassing the native file picker) and asserts:
 *  - a solid-red-div HTML string rasterizes through the REAL SVG-foreignObject
 *    pipeline into an emit plane; a Rendered-mode pixel probe shows the red;
 *  - messy real-world (non-XML) HTML is sanitized and rasterizes ok:true, NOT an
 *    exception, and still adds exactly one plane;
 *  - in headless (no showOpenFilePicker) the Live path gracefully falls back to
 *    snapshot behaviour with the documented status note;
 *  - the Shift+A ▸ Image flyout exposes HTML Snapshot… and HTML Live…;
 *  - a Rendered-mode screenshot of an HTML plane for eyes-on.
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  await t.key('Escape', 'Escape', 0); // dismiss splash

  // Expose the module (Vite serves the TS source).
  await t.evaluate(`(async () => {
    window.__hp = await import('/src/tools/htmlPlane.ts');
  })()`);
  t.check('htmlPlane module ready', await t.until('!!window.__hp'));

  // Clean slate so nothing occludes the sampled pixels.
  await t.evaluate(`(() => {
    const S = window.__app.scene;
    for (const o of [...S.objects]) S.remove(o.id);
    window.__app.undo.clear();
  })()`);

  // --- Rasterize a solid-red div filling the body. ------------------------
  await t.evaluate(`(() => {
    window.__hpDone = null;
    const S = window.__app.scene, U = window.__app.undo;
    const html = '<html><body><div style="width:100%;height:100%;background:rgb(220,40,40)"></div></body></html>';
    window.__hp.addHtmlPlaneFromText(S, U, html, 'redcard').then((r) => {
      window.__hpDone = { ok: r.ok, name: r.obj.name, kind: r.obj.kind,
        mats: S.materials.length, objs: S.objects.length,
        shadeless: !!S.getMaterial(r.obj.materialId).shadeless,
        texKind: S.getMaterial(r.obj.materialId).texKind,
        isDataUrl: (S.getMaterial(r.obj.materialId).texDataUrl || '').startsWith('data:image/png'),
      };
    }).catch((e) => { window.__hpDone = { error: String(e) }; });
  })()`);
  t.check('addHtmlPlaneFromText resolved', await t.until('!!window.__hpDone'));
  const red = await t.evaluate('window.__hpDone');
  t.check('rasterized without throwing: ' + JSON.stringify(red), !red.error);
  t.check('red HTML parsed ok (ok=true)', red.ok === true);
  t.check('one emit image plane added (mesh, named)',
    red.objs === 1 && red.mats === 1 && red.kind === 'mesh' &&
    red.name === 'redcard' && red.shadeless === true && red.texKind === 'image');
  t.check('material carries a rasterized PNG data URL', red.isDataUrl === true);

  // --- Rendered-mode pixel probe: the plane shows red. --------------------
  await t.evaluate(`(() => {
    const cam = window.__app.camera;
    cam.yaw = 0; cam.pitch = 1.4; cam.distance = 5;
    window.__app.renderer.shadingMode = 'rendered';
    window.__app.shadePrefs.ao = false;
    window.__app.scene.deselectAll(); // gizmo arrows converge at the origin
  })()`);

  t.check('HTML plane rasterizes RED in Rendered mode (texture uploads)',
    await t.until(`(() => {
      const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
      app.renderer.render(app.scene, app.camera);
      const m = app.renderer.currentViewProj(app.scene, app.camera).m;
      const px = Math.round((m[12]/m[15]*0.5+0.5) * c.width);
      const py = Math.round((m[13]/m[15]*0.5+0.5) * c.height);
      const out = new Uint8Array(4);
      gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
      return out[0] > 150 && out[0] > out[1] + 60 && out[0] > out[2] + 60;
    })()`));

  const redPx = await t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const m = app.renderer.currentViewProj(app.scene, app.camera).m;
    const px = Math.round((m[12]/m[15]*0.5+0.5) * c.width);
    const py = Math.round((m[13]/m[15]*0.5+0.5) * c.height);
    const out = new Uint8Array(4);
    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return [out[0], out[1], out[2]];
  })()`);
  t.check('center pixel is bright red (unlit emit): ' + JSON.stringify(redPx),
    redPx[0] > 180 && redPx[1] < 110 && redPx[2] < 110);

  // Eyes-on screenshot of the HTML plane in Rendered mode.
  await t.screenshot('/home/raymundo/Vibe Coded Blender/research/html-plane-rendered.png');

  // --- Real-world non-XML HTML → sanitized and rasterized OK (Ray's bug ----
  // 2026-07-11: unclosed <br>/<img>, &nbsp;, mismatched tags used to hit the
  // "HTML failed to parse" error card; sanitizeToXhtml now round-trips them
  // through the lenient HTML parser). Must succeed AND never throw.
  await t.evaluate(`(() => {
    const S = window.__app.scene;
    for (const o of [...S.objects]) S.remove(o.id);
    window.__app.undo.clear();
    window.__hpGarbage = null;
    const messy = '<p>a<br>b&nbsp;&mdash;c</p><div><span>oops</div></p>' +
      '<img src=missing.png width=100><script>document.write("nope")</scr' + 'ipt>';
    window.__hp.addHtmlPlaneFromText(S, window.__app.undo, messy, 'messy').then((r) => {
      window.__hpGarbage = { ok: r.ok, objs: S.objects.length, kind: r.obj.kind,
        texKind: S.getMaterial(r.obj.materialId).texKind };
    }).catch((e) => { window.__hpGarbage = { error: String(e) }; });
  })()`);
  t.check('messy HTML resolved', await t.until('!!window.__hpGarbage'));
  const junk = await t.evaluate('window.__hpGarbage');
  t.check('messy input did NOT throw: ' + JSON.stringify(junk), !junk.error);
  t.check('messy real-world HTML rasterizes OK (ok=true, sanitized), one plane added',
    junk.ok === true && junk.objs === 1 && junk.kind === 'mesh' && junk.texKind === 'image');

  // --- Live path in headless: graceful snapshot fallback + status. --------
  await t.evaluate(`(() => {
    const S = window.__app.scene;
    for (const o of [...S.objects]) S.remove(o.id);
    window.__app.undo.clear();
    // Remove any stray hidden file inputs from earlier picker calls.
    document.querySelectorAll('input[type=file]').forEach((n) => n.remove());
    // Force the fallback branch: headless already lacks it, but be explicit.
    try { delete window.showOpenFilePicker; } catch (e) {}
    window.__hpLiveStatus = '';
    window.__hp.pickHtmlLive(S, window.__app.undo, (s) => { window.__hpLiveStatus = s; });
  })()`);
  await t.sleep(80);
  const liveStatus = await t.evaluate('window.__hpLiveStatus');
  t.check('Live falls back with status "Live HTML unavailable — added snapshot": ' +
    JSON.stringify(liveStatus), liveStatus === 'Live HTML unavailable — added snapshot');
  t.check('fallback opened the snapshot file picker (input[type=file] present)',
    await t.evaluate(`!!document.querySelector('input[type=file][accept*="html"]')`));
  t.check('no live plane is polling (headless has no live handle)',
    await t.evaluate('window.__hp.liveHtmlPlaneCount() === 0'));

  // --- Menu integration: Image flyout has the two HTML items. -------------
  await t.evaluate(`(() => {
    const S = window.__app.scene; for (const o of [...S.objects]) S.remove(o.id);
    document.querySelectorAll('input[type=file]').forEach((n) => n.remove());
    window.__app.undo.clear();
    window.__app.renderer.shadingMode = 'matcap';
    const wrap = document.querySelector('#viewport-wrap') || document.querySelector('canvas').parentElement;
    const r = wrap.getBoundingClientRect();
    window.__app.input.pointer.x = r.width/2; window.__app.input.pointer.y = r.height/2;
  })()`);
  await t.key('a', 'KeyA', 8); // Shift+A
  await t.sleep(60);
  const imageItems = await t.evaluate(`(() => {
    const row = document.querySelector('.add-menu-category[data-category="Image"]');
    row.dispatchEvent(new MouseEvent('mouseenter'));
    return [...document.querySelectorAll('.add-menu-flyout .add-menu-item')].map((b) => b.textContent);
  })()`);
  t.check('Image flyout has Diffuse…, Emit…, HTML Snapshot…, HTML Live…: ' + JSON.stringify(imageItems),
    imageItems.includes('Diffuse…') && imageItems.includes('Emit…') &&
    imageItems.includes('HTML Snapshot…') && imageItems.includes('HTML Live…') &&
    imageItems.length === 4);
  await t.key('Escape', 'Escape', 0);
});
