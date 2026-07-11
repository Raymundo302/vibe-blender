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

  // --- Menu integration: Image flyout has the single HTML/Website item. ---
  // (UR7-3 replaced the two HTML items with one dialog entry.)
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
  t.check('Image flyout has Diffuse…, Emit…, HTML / Website…: ' + JSON.stringify(imageItems),
    imageItems.includes('Diffuse…') && imageItems.includes('Emit…') &&
    imageItems.includes('HTML / Website…') && imageItems.length === 3);
  await t.key('Escape', 'Escape', 0);

  // =====================================================================
  // UR7-1 — animated re-raster + keyable Play (the page clock).
  // =====================================================================
  await t.evaluate(`(async () => {
    window.__pt = await import('/src/core/anim/pageTime.ts');
    window.__fc = await import('/src/core/anim/fcurve.ts');
  })()`);
  t.check('pageTime + fcurve modules ready', await t.until('!!window.__pt && !!window.__fc'));

  // A page whose CSS animation slides a red block left→right across the FULL
  // width (linear, forwards so it holds at the end — a clean monotonic clock).
  const ANIM_HTML =
    '<html><head><style>' +
    'html,body{margin:0;height:100%;background:#fff;}' +
    '.blk{position:absolute;top:0;left:0;width:10%;height:100%;background:rgb(220,40,40);' +
    'animation:slide 2s linear forwards;}' +
    '@keyframes slide{from{left:0;}to{left:90%;}}' +
    '</style></head><body><div class="blk"></div></body></html>';

  // Fresh scene: add the animated plane, then KEY html.playing ON at frame 10
  // (constant interp, OFF at frame 1). Slow the scene fps to 2 so a single frame
  // is a big page-clock step (clean per-frame differences in the Ctrl+F12 render).
  await t.evaluate(`(() => {
    const S = window.__app.scene, U = window.__app.undo;
    for (const o of [...S.objects]) S.remove(o.id);
    U.clear();
    S.fps = 2; S.frameStart = 1; S.frameCurrent = 1;
    window.__mkDone = null;
    window.__ANIM = ${JSON.stringify(ANIM_HTML)};
    window.__hp.addHtmlPlaneFromText(S, U, window.__ANIM, 'ticker').then((r) => {
      window.__plane = r.obj;
      // Key the Play channel: OFF before frame 10, ON from frame 10 (constant).
      r.obj.anim = { fcurves: [] };
      window.__fc.insertKey(r.obj.anim, 'html.playing', 1, 0, 'constant');
      window.__fc.insertKey(r.obj.anim, 'html.playing', 10, 1, 'constant');
      window.__mkDone = true;
    });
  })()`);
  t.check('animated + keyed HTML plane added', await t.until('!!window.__mkDone'));
  const stamp = await t.evaluate(`(() => {
    const P = window.__plane;
    return { hasHtml: !!P.html, kind: P.html && P.html.kind,
      sourceIsAnim: P.html && P.html.source === window.__ANIM,
      playing: P.html && P.html.playing, fps: P.html && P.html.fps };
  })()`);
  t.check('plane carries the html payload (kind file, source, fps 8): ' + JSON.stringify(stamp),
    stamp.hasHtml && stamp.kind === 'file' && stamp.sourceIsAnim && stamp.playing === false && stamp.fps === 8);

  // --- rasterizeHtmlAt + pageTime: frames 5 & 9 IDENTICAL, frame 40 MOVED. --
  await t.evaluate(`(() => {
    window.__probe = async (tSec) => {
      const { dataUrl } = await window.__hp.rasterizeHtmlAt(window.__ANIM, tSec, { w: 200, h: 150 });
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
      const c = document.createElement('canvas'); c.width = 200; c.height = 150;
      const cx = c.getContext('2d'); cx.drawImage(img, 0, 0);
      const at = (x, y) => { const d = cx.getImageData(x, y, 1, 1).data; return d[0] > 150 && d[0] > d[1] + 60 && d[0] > d[2] + 60; };
      // x=5 sits under the block at t=0 (block spans 0..10%); it clears once the block slides right.
      return { dataUrl, leftRed: at(5, 75) };
    };
    window.__ptOut = null;
    (async () => {
      const P = window.__plane, S = window.__app.scene;
      const pt = (f) => window.__pt.pageTime(P, f, S.fps, S.frameStart);
      const r5 = await window.__probe(pt(5));
      const r9 = await window.__probe(pt(9));
      const r40 = await window.__probe(pt(40));
      window.__ptOut = {
        pt5: pt(5), pt9: pt(9), pt40: pt(40),
        identical59: r5.dataUrl === r9.dataUrl,
        f5Left: r5.leftRed, f40Left: r40.leftRed,
        pixelsDiffer: r5.dataUrl !== r40.dataUrl,
      };
    })();
  })()`);
  t.check('pageTime probes resolved', await t.until('!!window.__ptOut', 15000));
  const pt = await t.evaluate('window.__ptOut');
  t.check('page clock is FROZEN before the play key: pageTime(5)==pageTime(9)==0: ' + JSON.stringify([pt.pt5, pt.pt9]),
    pt.pt5 === 0 && pt.pt9 === 0);
  t.check('page clock ADVANCES after the key: pageTime(40) > 0 (' + pt.pt40 + ')', pt.pt40 > 0);
  t.check('frames 5 and 9 rasterize to IDENTICAL images (frozen page)', pt.identical59 === true);
  t.check('frame 40 raster DIFFERS and the block has MOVED (left cleared)',
    pt.pixelsDiffer === true && pt.f5Left === true && pt.f40Left === false);

  // --- Live timeline scrub via __app: texDataUrl frozen 5↔9, changes at 40. -
  const texUrl = () => t.evaluate(
    `(() => { const S = window.__app.scene, P = window.__plane; return S.getMaterial(P.materialId).texDataUrl; })()`);
  const setFrame = (f) => t.evaluate(`(() => { window.__app.scene.frameCurrent = ${f}; })()`);

  await setFrame(5);
  await t.sleep(900); // driver re-rasters at pageTime(5)=0
  const url5 = await texUrl();
  await setFrame(9);
  await t.sleep(900); // pageTime(9)=0 — driver must SKIP (unchanged)
  const url9 = await texUrl();
  t.check('scrub 5→9 leaves texDataUrl UNCHANGED (page clock frozen)',
    !!url5 && url9 === url5);

  await setFrame(10);
  await t.sleep(900); // pageTime(10) still 0
  await t.evaluate(`window.__url10 = window.__app.scene.getMaterial(window.__plane.materialId).texDataUrl;`);
  await setFrame(40);
  const changed = await t.until(
    `window.__app.scene.getMaterial(window.__plane.materialId).texDataUrl !== window.__url10`, 9000);
  t.check('scrub 10→40 CHANGES texDataUrl (page clock advanced)', changed === true);

  // Eyes-on screenshot of an animated pose (Rendered mode, block mid-slide).
  await t.evaluate(`(() => {
    const cam = window.__app.camera;
    cam.yaw = 0; cam.pitch = 1.4; cam.distance = 5;
    window.__app.renderer.shadingMode = 'rendered';
    window.__app.shadePrefs.ao = false;
    window.__app.scene.deselectAll();
  })()`);
  await t.sleep(300);
  await t.screenshot('/home/raymundo/Vibe Coded Blender/research/html-plane-animated.png');

  // --- Ctrl+F12 determinism: PNG-seq, viewport engine (noise-free). ---------
  // Pre-key frames 3,4,5 (all pageTime 0) must be IDENTICAL; post-key frames
  // 10,11,12 must DIFFER — proving the keyed page clock drives the render.
  await t.evaluate(`(() => {
    window.__app.shadePrefs.ao = false;
    window.__app.scene.deselectAll();
    window.__crcOut = null;
    // Extract each PNG entry's CRC32 from a STORE-only zip Blob (local headers).
    window.__zipCrcs = async (blob) => {
      const buf = new Uint8Array(await blob.arrayBuffer());
      const dv = new DataView(buf.buffer);
      const crcs = [];
      for (let i = 0; i + 30 <= buf.length;) {
        if (dv.getUint32(i, true) !== 0x04034b50) break;
        crcs.push(dv.getUint32(i + 14, true) >>> 0);
        const nameLen = dv.getUint16(i + 26, true), extraLen = dv.getUint16(i + 28, true), sz = dv.getUint32(i + 18, true);
        i += 30 + nameLen + extraLen + sz;
      }
      return crcs;
    };
    (async () => {
      const pre = await window.__app.animRender.render({ mode: 'png', engine: 'viewport', start: 3, end: 5 });
      const post = await window.__app.animRender.render({ mode: 'png', engine: 'viewport', start: 10, end: 12 });
      window.__crcOut = { pre: await window.__zipCrcs(pre), post: await window.__zipCrcs(post) };
    })().catch((e) => { window.__crcOut = { error: String(e) }; });
  })()`);
  t.check('Ctrl+F12 PNG-seq renders resolved', await t.until('!!window.__crcOut', 40000));
  const crc = await t.evaluate('window.__crcOut');
  t.check('render did not throw: ' + JSON.stringify(crc), !crc.error);
  const uniq = (a) => new Set(a).size;
  t.check('pre-key frames 3,4,5 render IDENTICAL (page clock off): ' + JSON.stringify(crc.pre),
    crc.pre && crc.pre.length === 3 && uniq(crc.pre) === 1);
  t.check('post-key frames 10,11,12 render ALL DIFFERENT (page clock advancing): ' + JSON.stringify(crc.post),
    crc.post && crc.post.length === 3 && uniq(crc.post) === 3);

  // =====================================================================
  // UR7-2 — browse Page Mode (Tab), page-extent geometry, Properties Play.
  // =====================================================================
  await t.evaluate(`(async () => {
    window.__pm = await import('/src/tools/pageMode.ts');
    window.__prim = await import('/src/core/mesh/primitives.ts');
  })()`);
  t.check('pageMode + primitives modules ready', await t.until('!!window.__pm && !!window.__prim'));

  // A tall page: a blue header at the top and a GREEN marker way down at
  // page-y 900 (below any reasonable fold) — scrolling must reveal it.
  const MARKER_HTML =
    '<html><head><style>' +
    'html,body{margin:0;background:#fff;}' +
    '.hdr{position:absolute;top:0;left:0;width:100%;height:80px;background:rgb(40,60,220);}' +
    '.mk{position:absolute;top:900px;left:0;width:100%;height:120px;background:rgb(40,200,60);}' +
    '</style></head><body><div class="hdr"></div><div class="mk"></div></body></html>';

  // --- Part A: Tab enters Page Mode; wheel scrolls (not zoom); Tab exits. ---
  await t.evaluate(`(() => {
    const S = window.__app.scene, U = window.__app.undo;
    for (const o of [...S.objects]) S.remove(o.id);
    U.clear();
    S.frameStart = 1; S.frameCurrent = 1; S.fps = 24;
    window.__browsy = null;
    window.__MARK = ${JSON.stringify(MARKER_HTML)};
    window.__hp.addHtmlPlaneFromText(S, U, window.__MARK, 'browsy').then((r) => { window.__browsy = r.obj; });
  })()`);
  t.check('browse HTML plane added + auto-selected', await t.until(
    '!!window.__browsy && window.__app.scene.activeObject === window.__browsy'));

  // Tab → Page Mode (NOT edit mode). Status chip + module state probe.
  await t.key('Tab', 'Tab', 0);
  const enter = await t.evaluate(`(() => ({
    inPage: window.__pm.pageModeState.object === window.__browsy,
    editMode: window.__app.scene.editMode !== null,
    status: (document.getElementById('status') || {}).textContent || '',
  }))()`);
  t.check('Tab on an HTML plane enters Page Mode (not edit mode): ' + JSON.stringify(enter),
    enter.inPage === true && enter.editMode === false);
  t.check('status chip reads the Page Mode prompt: ' + JSON.stringify(enter.status),
    enter.status === 'Page Mode — scroll to browse, Tab/Esc to exit');

  // Wheel over the viewport scrolls the page (html.scrollY) and re-rasters;
  // the camera distance must be UNCHANGED (zoom suppressed).
  await t.evaluate(`(() => {
    const app = window.__app;
    app.camera.distance = 5;
    window.__preDist = app.camera.distance;
    window.__preScroll = window.__browsy.html.scrollY;
    window.__preTex = app.scene.getMaterial(window.__browsy.materialId).texDataUrl;
    const canvas = document.getElementById('viewport');
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 880, cancelable: true, bubbles: true }));
  })()`);
  const scrolled = await t.until(
    `window.__browsy.html.scrollY > window.__preScroll + 800 &&
     window.__app.scene.getMaterial(window.__browsy.materialId).texDataUrl !== window.__preTex`, 6000);
  t.check('wheel in Page Mode scrolls the page (scrollY jumped ~880) and re-rasters', scrolled === true);
  const dist = await t.evaluate('({ pre: window.__preDist, now: window.__app.camera.distance })');
  t.check('camera distance UNCHANGED by the wheel in Page Mode (zoom suppressed): ' + JSON.stringify(dist),
    dist.now === dist.pre);

  // Deterministic pixel probe: the page-y 900 marker is OFF-screen at scrollY 0
  // and COMES INTO VIEW once scrolled to it (proves scrollWrap consumption).
  await t.evaluate(`(() => {
    window.__mkProbe = async (scrollY, x, y) => {
      const { dataUrl } = await window.__hp.rasterizeHtmlAt(window.__MARK, 0, { w: 400, h: 400, scrollY });
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
      const c = document.createElement('canvas'); c.width = 400; c.height = 400;
      const cx = c.getContext('2d'); cx.drawImage(img, 0, 0);
      const d = cx.getImageData(x, y, 1, 1).data;
      return d[1] > 150 && d[1] > d[0] + 60 && d[1] > d[2] + 60; // green?
    };
    window.__mkOut = null;
    (async () => {
      const off = await window.__mkProbe(0, 200, 200);   // mid-page, white gap
      const on  = await window.__mkProbe(880, 200, 40);  // marker scrolled up to ~y20-140
      window.__mkOut = { off, on };
    })();
  })()`);
  t.check('marker probe resolved', await t.until('!!window.__mkOut', 15000));
  const mk = await t.evaluate('window.__mkOut');
  t.check('page-y 900 marker is HIDDEN at scrollY 0 and APPEARS after scrolling: ' + JSON.stringify(mk),
    mk.off === false && mk.on === true);

  // Eyes-on: Page Mode scrolled halfway (marker mid-viewport), Rendered mode.
  await t.evaluate(`(() => {
    window.__browsy.html.scrollY = 516; // ~halfway to the page-900 marker (768-tall raster)
    const app = window.__app, cam = app.camera;
    cam.yaw = 0; cam.pitch = 1.4; cam.distance = 5;
    app.renderer.shadingMode = 'rendered';
    app.shadePrefs.ao = false;
    app.scene.deselectAll();
  })()`);
  await t.sleep(500);
  await t.screenshot('/home/raymundo/Vibe Coded Blender/research/html-plane-pagemode.png');

  // Tab exits Page Mode.
  await t.evaluate(`window.__app.scene.selectOnly(window.__browsy.id);`);
  await t.key('Tab', 'Tab', 0);
  t.check('Tab exits Page Mode', await t.evaluate('window.__pm.pageModeState.object === null'));

  // Regression: Tab on a PLAIN cube still enters mesh Edit Mode.
  await t.evaluate(`(() => {
    const S = window.__app.scene, U = window.__app.undo;
    for (const o of [...S.objects]) S.remove(o.id);
    U.clear();
    const cube = S.add('Cube', window.__prim.makeCube(1));
    S.selectOnly(cube.id);
    window.__cube = cube;
  })()`);
  await t.key('Tab', 'Tab', 0);
  t.check('Tab on a plain cube still enters mesh Edit Mode (regression)',
    await t.evaluate('window.__app.scene.editMode !== null && window.__pm.pageModeState.object === null'));
  await t.key('Tab', 'Tab', 0); // back to Object Mode
  t.check('Tab exits mesh Edit Mode', await t.evaluate('window.__app.scene.editMode === null'));

  // --- Part B: page-extent geometry — pageH 768→1536 extends bottom down. ---
  await t.evaluate(`(() => {
    const S = window.__app.scene, U = window.__app.undo;
    for (const o of [...S.objects]) S.remove(o.id);
    U.clear();
    window.__ext = null;
    window.__hp.addHtmlPlaneFromText(S, U, '<html><body><div style="height:100%;background:#3366cc"></div></body></html>', 'extent').then((r) => { window.__ext = r.obj; });
  })()`);
  t.check('extent HTML plane added', await t.until('!!window.__ext'));
  const beforeGeo = await t.evaluate(`(() => {
    const ys = [...window.__ext.mesh.verts.values()].map((v) => v.co.y);
    const xs = [...window.__ext.mesh.verts.values()].map((v) => v.co.x);
    return { top: Math.max(...ys), bottom: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs),
      pageH: window.__ext.html.pageH };
  })()`);
  t.check('initial extent: pageH 768, top +1, bottom −1: ' + JSON.stringify(beforeGeo),
    beforeGeo.pageH === 768 && Math.abs(beforeGeo.top - 1) < 1e-6 && Math.abs(beforeGeo.bottom + 1) < 1e-6);

  await t.evaluate(`(() => {
    const U = window.__app.undo;
    window.__hp.setHtmlPageExtent(window.__ext, U, window.__ext.html.pageW, 1536); // 768→1536
  })()`);
  const afterGeo = await t.evaluate(`(() => {
    const ys = [...window.__ext.mesh.verts.values()].map((v) => v.co.y);
    const xs = [...window.__ext.mesh.verts.values()].map((v) => v.co.x);
    return { top: Math.max(...ys), bottom: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs),
      pageH: window.__ext.html.pageH };
  })()`);
  t.check('pageH 768→1536: TOP edge fixed, WIDTH unchanged: ' + JSON.stringify(afterGeo),
    Math.abs(afterGeo.top - beforeGeo.top) < 1e-6 && Math.abs(afterGeo.width - beforeGeo.width) < 1e-6);
  t.check('pageH 768→1536: BOTTOM edge extends DOWNWARD (height doubled)',
    afterGeo.bottom < beforeGeo.bottom - 1e-6 &&
    Math.abs((afterGeo.top - afterGeo.bottom) - 2 * (beforeGeo.top - beforeGeo.bottom)) < 1e-6 &&
    afterGeo.pageH === 1536);

  await t.evaluate('window.__app.undo.undo();');
  const undoneGeo = await t.evaluate(`(() => {
    const ys = [...window.__ext.mesh.verts.values()].map((v) => v.co.y);
    return { top: Math.max(...ys), bottom: Math.min(...ys), pageH: window.__ext.html.pageH };
  })()`);
  t.check('one undo reverts BOTH geometry AND pageH: ' + JSON.stringify(undoneGeo),
    Math.abs(undoneGeo.bottom - beforeGeo.bottom) < 1e-6 &&
    Math.abs(undoneGeo.top - beforeGeo.top) < 1e-6 && undoneGeo.pageH === 768);

  // --- Part C: Properties Web Page section — ▶ toggles playing, ● keys it. --
  await t.evaluate(`(() => {
    const S = window.__app.scene;
    S.frameCurrent = 20;
    S.selectOnly(window.__ext.id); // ensure the html plane is the active object
    window.__app.workspaces.update(); // let the Object tab build/show the section
  })()`);
  await t.sleep(200);
  const hasSection = await t.until(
    `!!document.querySelector('[data-action="play-toggle"]') &&
     document.querySelector('.web-page-section') &&
     getComputedStyle(document.querySelector('.web-page-section')).display !== 'none'`);
  t.check('Web Page section is shown for the active HTML plane', hasSection === true);

  const playBefore = await t.evaluate('window.__ext.html.playing');
  await t.evaluate(`document.querySelector('[data-action="play-toggle"]').click();`);
  const playAfter = await t.evaluate('window.__ext.html.playing');
  t.check('▶ Play/Pause toggle flips html.playing: ' + JSON.stringify([playBefore, playAfter]),
    playBefore === false && playAfter === true);

  await t.evaluate(`document.querySelector('[data-action="play-key"]').click();`);
  await t.sleep(80);
  const keyProbe = await t.evaluate(`(() => {
    const c = window.__ext.anim && window.__fc.findCurve(window.__ext.anim, 'html.playing');
    if (!c) return { has: false };
    const k = c.keys.find((kk) => kk.frame === 20);
    return { has: !!k, value: k && k.value, interp: k && k.interp, count: c.keys.length };
  })()`);
  t.check('● key inserts a key on html.playing at frameCurrent=20 (constant, value 1): ' + JSON.stringify(keyProbe),
    keyProbe.has === true && keyProbe.value === 1 && keyProbe.interp === 'constant');

  // ● is undoable (one entry).
  await t.evaluate('window.__app.undo.undo();');
  const afterUndoKey = await t.evaluate(`(() => {
    const c = window.__ext.anim && window.__fc.findCurve(window.__ext.anim, 'html.playing');
    return c ? c.keys.length : 0;
  })()`);
  t.check('undo removes the inserted Play key', afterUndoKey === 0);
});
