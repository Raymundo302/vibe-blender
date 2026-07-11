/**
 * UR8-4 — Extract Element (Page Mode → pull a page element onto its own plane).
 *
 * Loads a two-element page (a bouncy-ball wrapper + a green "rest" marker outside
 * it, distinct colors, plain light background), enters Page Mode, starts the
 * Extract Element tool, drives a synthetic pointer over the wrapper, and asserts:
 *   - a highlight rectangle appears over the viewport (DOM probe),
 *   - clicking extracts: (1) a NEW transparent-cropped plane exists whose raster
 *     contains the ball color and is transparent at its corners;
 *   - (2) the ORIGINAL plane's raster no longer shows the ball at its old spot but
 *     STILL shows the rest;
 *   - (3) the new plane sits IN FRONT along the source normal (+0.01);
 *   - (4) ONE undo restores the original text + removes the extracted plane;
 *   - (5) save→load round-trips both planes (the source's visibility rule serializes).
 *   - Screenshot of the extracted ball hovering in front, matcap + Always Textured.
 */
import { runE2e } from './harness.mjs';

const PAGE =
  '<html><head><style>' +
  'html,body{margin:0;background:rgb(230,230,235);}' +
  '#wrap{position:absolute;left:262px;top:134px;width:500px;height:500px;}' +
  '#ball{position:absolute;left:0;top:0;width:180px;height:180px;border-radius:50%;' +
  'background:rgb(240,70,70);animation:bob 1s ease-in-out infinite alternate;}' +
  '#shadow{position:absolute;left:20px;top:210px;width:150px;height:40px;border-radius:50%;' +
  'background:rgba(0,0,0,0.4);filter:blur(8px);}' +
  '#rest{position:absolute;left:820px;top:60px;width:150px;height:150px;background:rgb(40,180,90);}' +
  '@keyframes bob{from{transform:translateY(0);}to{transform:translateY(-30px);}}' +
  '</style></head><body>' +
  '<div id="rest"></div>' +
  '<div id="wrap"><div id="ball"></div><div id="shadow"></div></div>' +
  '</body></html>';

runE2e(async (t) => {
  await t.key('Escape', 'Escape', 0); // dismiss splash

  await t.evaluate(`(async () => {
    window.__hp = await import('/src/tools/htmlPlane.ts');
    window.__pm = await import('/src/tools/pageMode.ts');
    window.__ex = await import('/src/tools/extractElement.ts');
  })()`);
  t.check('modules ready', await t.until('!!window.__hp && !!window.__pm && !!window.__ex'));

  // --- Fresh scene: add the page plane, face it, enter Page Mode. -----------
  await t.evaluate(`(() => {
    const S = window.__app.scene, U = window.__app.undo;
    for (const o of [...S.objects]) S.remove(o.id);
    U.clear();
    window.__src = null;
    window.__hp.addHtmlPlaneFromText(S, U, ${JSON.stringify(PAGE)}, 'page').then((r) => { window.__src = r.obj; });
  })()`);
  t.check('page plane added (full doc, not cropped)', await t.until(
    '!!window.__src && window.__src.html && window.__src.html.autoCrop !== true'));

  await t.evaluate(`(() => {
    const S = window.__app.scene, cam = window.__app.camera;
    S.selectOnly(window.__src.id);
    cam.yaw = 0; cam.pitch = 1.4; cam.distance = 4;
    window.__pm.pageModeState.object = window.__src; // enter Page Mode
    window.__app.renderer.shadingMode = 'matcap';
    window.__app.shadePrefs.ao = false;
  })()`);

  // Toolbar shows the Extract Element button in Page Mode.
  await t.sleep(120);
  t.check('toolbar shows Extract Element button in Page Mode',
    await t.until(`!!document.querySelector('.viewport-tool-btn[data-tool-id="extract"]')`));

  // --- Start the tool + wait for the DOM mirror to load. --------------------
  await t.evaluate('window.__app.input.startExtractElement();');
  t.check('extract controller active + mirror ready', await t.until(
    '!!window.__ex.extractState.controller && window.__ex.extractState.controller.ready()', 8000));

  // --- Synthetic pointer over the wrapper center → highlight appears. -------
  await t.evaluate(`(() => {
    const canvas = document.getElementById('viewport');
    const cx = canvas.clientWidth / 2, cy = canvas.clientHeight / 2;
    window.__cc = { cx, cy };
    window.__ex.extractState.controller.moveTo(cx, cy);
  })()`);
  await t.sleep(60);
  const hover = await t.evaluate(`(() => {
    const poly = document.querySelector('.extract-highlight-layer polygon');
    return { hasPoly: !!poly, polyPoints: poly ? poly.getAttribute('points') : '' };
  })()`);
  t.check('highlight rectangle appears over the hovered element (DOM probe): ' + JSON.stringify(hover.hasPoly),
    hover.hasPoly === true && hover.polyPoints.split(' ').length === 4);

  // --- Click → extract. Wait for the new plane (transparent + cropped). -----
  await t.evaluate(`(() => {
    window.__before = { objs: window.__app.scene.objects.length, src: window.__src.html.source };
    window.__ex.extractState.controller.click(false);
  })()`);
  t.check('extraction added a NEW plane and ended the tool', await t.until(
    'window.__app.scene.objects.length === window.__before.objs + 1 && window.__ex.extractState.controller === null', 15000));

  // Identify the new plane (the one that is NOT the source) + capture its state.
  const created = await t.evaluate(`(() => {
    const S = window.__app.scene;
    const nw = S.objects.find((o) => o !== window.__src);
    window.__new = nw;
    const mat = S.getMaterial(nw.materialId);
    return {
      hasHtml: !!nw.html, autoCrop: nw.html && nw.html.autoCrop, transparent: nw.html && nw.html.transparent,
      alphaBlend: !!mat.alphaBlend, alwaysTextured: !!mat.alwaysTextured, shadeless: !!mat.shadeless,
      texKind: mat.texKind, isPng: (mat.texDataUrl||'').startsWith('data:image/png'),
      posZ: nw.transform.position.z,
    };
  })()`);
  t.check('new plane is a transparent auto-cropped fragment (UR8-3 look): ' + JSON.stringify(created),
    created.hasHtml && created.autoCrop === true && created.transparent === true &&
    created.alphaBlend === true && created.alwaysTextured === true && created.shadeless === true &&
    created.texKind === 'image' && created.isPng === true);

  // (3) The new plane sits IN FRONT of the source along its +Z normal (~+0.01).
  t.check('(3) new plane nudged in front along the source normal (posZ ≈ +0.01): ' + created.posZ,
    Math.abs(created.posZ - 0.01) < 0.004 && created.posZ > 0);

  // (1) The new plane's RASTER contains the ball red and is TRANSPARENT at corners.
  await t.evaluate(`(() => {
    window.__rp = null;
    const mat = window.__app.scene.getMaterial(window.__new.materialId);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const cx = c.getContext('2d'); cx.drawImage(img, 0, 0);
      const d = cx.getImageData(0, 0, c.width, c.height).data;
      let red = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i+3] > 200 && d[i] > 180 && d[i] > d[i+1] + 70 && d[i] > d[i+2] + 70) red++;
      }
      const cornerA = (x, y) => d[(y*c.width + x)*4 + 3];
      const corners = [cornerA(0,0), cornerA(c.width-1,0), cornerA(0,c.height-1), cornerA(c.width-1,c.height-1)];
      window.__rp = { w: c.width, h: c.height, red, corners };
    };
    img.onerror = () => { window.__rp = { error: true }; };
    img.src = mat.texDataUrl;
  })()`);
  t.check('new-plane raster decoded', await t.until('!!window.__rp'));
  const rasterProbe = await t.evaluate('window.__rp');
  t.check('(1) new plane raster CONTAINS the ball red: ' + JSON.stringify(rasterProbe),
    !rasterProbe.error && rasterProbe.red > 100);
  t.check('(1) new plane raster is TRANSPARENT at all four corners (not the page bg): ' + JSON.stringify(rasterProbe.corners),
    rasterProbe.corners.every((a) => a < 20));

  // (2) The ORIGINAL source text now HIDES the ball at its old spot but keeps the
  // rest. Rasterize the current source and probe deterministically (page px →
  // image px). Ball old spot ≈ page(352,224); rest ≈ page(895,135).
  await t.evaluate(`(() => {
    window.__sp = null;
    const src = window.__src.html.source;
    const hasRule = /visibility:\\s*hidden/.test(src) && /data-vibe-extract/.test(src);
    window.__hp.rasterizeHtml(src, 1024, 768).then(({ dataUrl }) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas'); c.width = 1024; c.height = 768;
        const cx = c.getContext('2d'); cx.drawImage(img, 0, 0);
        const at = (x, y) => { const p = cx.getImageData(x, y, 1, 1).data; return [p[0], p[1], p[2]]; };
        window.__sp = { hasRule, ball: at(352, 224), rest: at(895, 135) };
      };
      img.onerror = () => { window.__sp = { error: true }; };
      img.src = dataUrl;
    });
  })()`);
  t.check('source re-raster decoded', await t.until('!!window.__sp', 15000));
  const srcProbe = await t.evaluate('window.__sp');
  t.check('(2) source text carries the data attribute + visibility:hidden rule: ' + JSON.stringify(srcProbe.hasRule),
    srcProbe.hasRule === true);
  const ballGone = Math.abs(srcProbe.ball[0] - srcProbe.ball[1]) < 25 && Math.abs(srcProbe.ball[1] - srcProbe.ball[2]) < 25;
  t.check('(2) ORIGINAL raster no longer shows the ball at its old spot (page bg, not red): ' + JSON.stringify(srcProbe.ball),
    ballGone && !(srcProbe.ball[0] > 180 && srcProbe.ball[0] > srcProbe.ball[1] + 60));
  t.check('(2) ORIGINAL raster STILL shows the rest (green marker intact): ' + JSON.stringify(srcProbe.rest),
    srcProbe.rest[1] > 120 && srcProbe.rest[1] > srcProbe.rest[0] + 50 && srcProbe.rest[1] > srcProbe.rest[2] + 50);

  // Screenshot: the extracted ball hovering IN FRONT of its page (push it out
  // along the normal — the parallax "add depth" Ray would do by hand), viewed at
  // an angle, matcap + Always Textured.
  await t.evaluate(`(async () => {
    const V = (await import('/src/core/math/vec3.ts')).Vec3;
    const p = window.__new.transform.position;
    window.__new.transform = window.__new.transform.withPosition(new V(p.x, p.y, 0.7));
    const cam = window.__app.camera; cam.yaw = 0.5; cam.pitch = 1.0; cam.distance = 5;
    window.__app.renderer.shadingMode = 'matcap';
    window.__app.shadePrefs.ao = false;
    window.__app.scene.deselectAll();
    window.__app.renderer.render(window.__app.scene, window.__app.camera);
  })()`);
  await t.sleep(300);
  await t.screenshot('/home/raymundo/Vibe Coded Blender/research/ur8-4-extract.png');

  // (4) ONE undo restores the original text + removes the extracted plane.
  await t.evaluate('window.__app.undo.undo();');
  const undone = await t.evaluate(`(() => ({
    objs: window.__app.scene.objects.length,
    before: window.__before.objs,
    srcRestored: window.__src.html.source === window.__before.src,
    hasRule: /data-vibe-extract/.test(window.__src.html.source),
    newGone: !window.__app.scene.objects.includes(window.__new),
  }))()`);
  t.check('(4) ONE undo removes the extracted plane and restores the source text: ' + JSON.stringify(undone),
    undone.objs === undone.before && undone.srcRestored === true &&
    undone.hasRule === false && undone.newGone === true);

  // Redo re-extracts so the round-trip test has both planes.
  await t.evaluate('window.__app.undo.redo();');
  t.check('redo re-extracts the plane',
    await t.until('window.__app.scene.objects.length === window.__before.objs + 1'));

  // (5) save→load round-trips BOTH planes (source visibility rule serializes).
  const round = await t.evaluate(`(() => {
    const json = window.__app.io.serialize();
    window.__app.io.apply(json);
    const S = window.__app.scene;
    const src = S.objects.find((o) => o.html && !o.html.autoCrop);
    const frag = S.objects.find((o) => o.html && o.html.autoCrop);
    return {
      objs: S.objects.length,
      hasSrc: !!src, hasFrag: !!frag,
      srcHasRule: !!src && /visibility:\\s*hidden/.test(src.html.source) && /data-vibe-extract/.test(src.html.source),
      fragTransparent: !!frag && frag.html.transparent === true && frag.html.autoCrop === true,
    };
  })()`);
  t.check('(5) save→load round-trips BOTH planes with the source visibility rule intact: ' + JSON.stringify(round),
    round.objs === 2 && round.hasSrc && round.hasFrag && round.srcHasRule === true && round.fragTransparent === true);
});
