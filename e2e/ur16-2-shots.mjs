/**
 * UR16-2 — capture the redesigned Material tab for the record (Diffuse / Super /
 * emit image plane). Saves full-page PNGs to research/. Not an assertion suite.
 *   E2E_PORT=9817 node e2e/ur16-2-shots.mjs http://localhost:5199/
 */
import { runE2e } from './harness.mjs';

const solidPng = (hex, n = 8) => `(() => {
  const cv = document.createElement('canvas'); cv.width = ${n}; cv.height = ${n};
  const c = cv.getContext('2d'); c.fillStyle = '${hex}'; c.fillRect(0, 0, ${n}, ${n});
  return cv.toDataURL('image/png');
})()`;

runE2e(async (t) => {
  await t.key('Escape', 'Escape', 0);
  const saved = await t.evaluate('window.__app.io.serialize()');
  await t.evaluate(`document.querySelector('.wsp-tab[data-workspace="Layout"]')?.click()`);
  await t.sleep(150);
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.evaluate(`window.__app.scene.selectOnly(window.__app.scene.objects[0].id)`);
  await t.sleep(120);
  await t.evaluate(`document.querySelector('.properties-tab-btn[data-tab="material"]').click()`);
  await t.sleep(120);
  await t.evaluate(`document.querySelector('.material-tab-new-btn').click()`);
  await t.sleep(160);

  // Diffuse (default) with a colour gradient to show the sub-row.
  await t.evaluate(`window.__materialTab.setGradient('color', { kind: 'gradient', a: [0.9,0.2,0.3], b: [0.1,0.3,0.9], axis: 'z', offset: 0.5, scale: 0.5 })`);
  await t.sleep(140);
  await t.screenshot('research/ur16-2-diffuse.png');
  t.check('diffuse shot saved', true);

  // Super (everything) shader.
  await t.evaluate(`window.__materialTab.setChannelValue('color')`);
  await t.sleep(80);
  await t.evaluate(`window.__materialTab.setShader('super')`);
  await t.sleep(160);
  await t.screenshot('research/ur16-2-super.png');
  t.check('super shot saved', true);

  // Emit image plane.
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.sleep(80);
  const emitUrl = await t.evaluate(solidPng('#30d060'));
  await t.evaluate(`(async () => {
    const app = window.__app, s = app.scene;
    const prim = await import('/src/core/mesh/primitives.ts');
    const plane = s.add('EmitPlane', prim.makePlane(1));
    const mat = s.addMaterial('EmitImg');
    mat.shader = 'emit'; mat.shadeless = true; mat.texKind = 'image';
    mat.texDataUrl = ${JSON.stringify(emitUrl)}; mat.alwaysTextured = true; mat.baseColor = [1,1,1];
    plane.materialId = mat.id; s.selectOnly(plane.id);
  })()`);
  await t.sleep(180);
  await t.screenshot('research/ur16-2-emit-plane.png');
  t.check('emit-plane shot saved', true);

  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.evaluate(`window.__app.autosave.clear()`);
});
