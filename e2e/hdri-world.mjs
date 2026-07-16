/**
 * World HDRI backdrop e2e (Ray's report, 2026-07-16: "hdri isn't showing up in
 * the rendering, live or raytraced"). A synthetic red/blue equirect is set as
 * the world HDRI, then the backdrop corner is pixel-probed in (1) Rendered ->
 * Live, (2) Rendered -> Raytraced (the GPU kernel's new equirect path — the v1
 * kernel silently fell back to the gradient), and (3) live again after a full
 * save -> load round trip (hdriImage rebuild).
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  await t.key('Escape', 'Escape');
  // Synthetic equirect: left half red, right half blue (any direction hits color).
  await t.evaluate(`(() => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 32;
    const x = c.getContext('2d');
    x.fillStyle = '#ff2010'; x.fillRect(0, 0, 32, 32);
    x.fillStyle = '#1020ff'; x.fillRect(32, 0, 32, 32);
    window.__hdriUrl = c.toDataURL('image/png');
  })()`);
  // Apply through the world payload like the tab does.
  await t.evaluate(`(async () => {
    const wd = await import('/src/core/scene/worldData.ts');
    window.__wd = wd;
    const S = window.__app.scene;
    const decoded = await wd.decodeHdriDataUrl(window.__hdriUrl);
    S.world.mode = 'hdri';
    S.world.hdri = window.__hdriUrl;   // packed data URL (the serialized field)
    S.world.hdriImage = decoded;       // decoded runtime cache
    window.__hdriSet = true;
  })().catch(e => { window.__hdriErr = String(e); window.__hdriSet = 'err'; })`);
  await t.until(`window.__hdriSet !== undefined`);
  const err = await t.evaluate(`window.__hdriErr ?? null`);
  t.check(`hdri decoded + set on world (${err ?? 'ok'})`, err === null);

  const probeCorner = () => t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const buf = new Uint8Array(16 * 16 * 4);
    gl.readPixels(8, c.height - 80, 16, 16, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < buf.length; i += 4) { r += buf[i]; g += buf[i+1]; b += buf[i+2]; }
    const n = buf.length / 4;
    return { r: r/n, g: g/n, b: b/n };
  })()`);

  await t.evaluate(`window.__app.renderer.shadingMode = 'rendered'`);
  await t.sleep(120);
  const live = await probeCorner();
  t.check(`LIVE rendered backdrop shows the HDRI (r=${live.r.toFixed(0)} g=${live.g.toFixed(0)} b=${live.b.toFixed(0)})`,
    (live.r > 100 && live.b < 90) || (live.b > 100 && live.r < 90));

  // Raytraced viewport
  await t.evaluate(`window.__app.shadePrefs.renderedMode = 'ray'`);
  let ray = null;
  for (let i = 0; i < 50; i++) {
    ray = await probeCorner();
    if ((ray.r > 100 && ray.b < 90) || (ray.b > 100 && ray.r < 90)) break;
    await t.sleep(200);
  }
  t.check(`RAY viewport backdrop shows the HDRI (r=${ray.r.toFixed(0)} g=${ray.g.toFixed(0)} b=${ray.b.toFixed(0)})`,
    (ray.r > 100 && ray.b < 90) || (ray.b > 100 && ray.r < 90));
  await t.evaluate(`window.__app.shadePrefs.renderedMode = 'live'`);

  // Save → load: hdriImage must rebuild from the packed data URL.
  await t.evaluate(`(() => {
    const json = window.__app.io.serialize();
    window.__app.io.apply(json);
    window.__loaded = true;
  })()`);
  await t.until('window.__loaded === true');
  // decode is async on load — poll until the backdrop returns.
  let re = null;
  for (let i = 0; i < 40; i++) {
    re = await probeCorner();
    if ((re.r > 100 && re.b < 90) || (re.b > 100 && re.r < 90)) break;
    await t.sleep(150);
  }
  t.check(`LIVE backdrop survives save->load (r=${re.r.toFixed(0)} b=${re.b.toFixed(0)})`,
    (re.r > 100 && re.b < 90) || (re.b > 100 && re.r < 90));
});
