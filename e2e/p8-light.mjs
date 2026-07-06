/**
 * P8-1 e2e — Light properties tab. Adds a light through __app, switches the
 * Properties panel to the Light tab, and exercises the fields + undo. Run with
 * the dev server up (under flock): `flock /tmp/vibe-blender-e2e.lock node e2e/p8-light.mjs`.
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  // Force the Layout workspace so the Properties panel is on screen.
  await t.evaluate(`document.querySelector('.wsp-tab[data-workspace="Layout"]')?.click()`);
  await t.sleep(150);

  // Add a Point light through __app and make it the active object.
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    const l = s.addLight('Point', 'point');
    s.selectOnly(l.id);
  })()`);
  await t.sleep(120);
  t.check('active object is a light',
    (await t.evaluate('window.__app.scene.activeObject.kind')) === 'light');

  // The Light tab button exists (💡, tooltip 'Light'); switch to it.
  t.check('Light tab button present',
    await t.evaluate(`!!document.querySelector('.properties-tab-btn[data-tab="light"]')`));
  t.check('Light tab tooltip reads "Light"',
    (await t.evaluate(`document.querySelector('.properties-tab-btn[data-tab="light"]').title`)) === 'Light');
  await t.evaluate(`document.querySelector('.properties-tab-btn[data-tab="light"]').click()`);
  await t.sleep(140);

  // Empty state is hidden and all core fields are present.
  t.check('type/color/power fields present',
    await t.evaluate(`(() => {
      const p = document.querySelector('.properties-pane[data-tab="light"]');
      return !!p.querySelector('[data-field="type"]') &&
             !!p.querySelector('[data-field="color"]') &&
             !!p.querySelector('[data-field="power"]');
    })()`));

  // Spot fields are hidden while type is Point.
  t.check('spot fields hidden for a point light',
    await t.evaluate(`(() => {
      const b = document.querySelector('.properties-pane[data-tab="light"] .light-tab-spot');
      return !!b && b.hidden === true;
    })()`));

  // Power field reflects the model (point default = 100).
  t.check('power field shows the model value (100)',
    (await t.evaluate(`document.querySelector('.properties-pane[data-tab="light"] [data-field="power"]').value`)) === '100');

  const power = () => t.evaluate('window.__app.scene.activeObject.light.power');

  // Edit power → model updates.
  await t.evaluate(`(() => {
    const inp = document.querySelector('.properties-pane[data-tab="light"] [data-field="power"]');
    inp.value = '250';
    inp.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(120);
  t.check('power edit updates the light (100 → 250)', Math.abs((await power()) - 250) < 1e-6);

  // Ctrl+Z restores the prior power.
  await t.key('z', 'KeyZ', 2); // ctrl+z
  await t.sleep(120);
  t.check('Ctrl+Z restores power to 100', Math.abs((await power()) - 100) < 1e-6);

  // Ctrl+Shift+Z redoes the power edit.
  await t.key('z', 'KeyZ', 2 | 8); // ctrl+shift+z
  await t.sleep(120);
  t.check('Ctrl+Shift+Z re-applies power 250', Math.abs((await power()) - 250) < 1e-6);

  // Color edit → model updates (hex treated as linear rgb).
  await t.evaluate(`(() => {
    const inp = document.querySelector('.properties-pane[data-tab="light"] [data-field="color"]');
    inp.value = '#ff0000';
    inp.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(120);
  const color = await t.evaluate('window.__app.scene.activeObject.light.color');
  t.check('color edit sets a red-dominant color',
    Math.abs(color[0] - 1) < 1e-6 && color[1] < 1e-6 && color[2] < 1e-6, color.join(', '));

  // Switch type to Spot → spot fields (angle + blend) appear, color/power kept.
  await t.evaluate(`(() => {
    const sel = document.querySelector('.properties-pane[data-tab="light"] [data-field="type"]');
    sel.value = 'spot';
    sel.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(140);
  t.check('type switched to spot', (await t.evaluate('window.__app.scene.activeObject.light.type')) === 'spot');
  t.check('spot fields become visible',
    await t.evaluate(`(() => {
      const p = document.querySelector('.properties-pane[data-tab="light"]');
      const b = p.querySelector('.light-tab-spot');
      return b.hidden === false && !!p.querySelector('[data-field="angle"]') && !!p.querySelector('[data-field="blend"]');
    })()`));
  t.check('type change kept color (still red) and power (250)',
    await t.evaluate(`(() => {
      const l = window.__app.scene.activeObject.light;
      return l.color[0] > 0.99 && Math.abs(l.power - 250) < 1e-6;
    })()`));

  // Angle field shows degrees, model stores radians. Edit angle → radians match.
  await t.evaluate(`(() => {
    const inp = document.querySelector('.properties-pane[data-tab="light"] [data-field="angle"]');
    inp.value = '90';
    inp.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(120);
  t.check('angle field (90°) stores π/2 radians in the model',
    Math.abs((await t.evaluate('window.__app.scene.activeObject.light.spotAngle')) - Math.PI / 2) < 1e-4);

  // Undo the angle edit — spotAngle returns to the 45° default (π/4).
  await t.key('z', 'KeyZ', 2); // ctrl+z
  await t.sleep(120);
  t.check('Ctrl+Z restores spot angle to 45° (π/4)',
    Math.abs((await t.evaluate('window.__app.scene.activeObject.light.spotAngle')) - Math.PI / 4) < 1e-4);

  // Empty state shows when a non-light becomes active (the default Cube).
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    const cube = s.objects.find((o) => o.kind === 'mesh');
    if (cube) s.selectOnly(cube.id);
  })()`);
  await t.sleep(120);
  t.check('empty state shown when a mesh is active',
    await t.evaluate(`(() => {
      const p = document.querySelector('.properties-pane[data-tab="light"]');
      const empty = p.querySelector('.properties-empty');
      return !!empty && empty.style.display !== 'none';
    })()`));

  await t.screenshot('/tmp/p8-1-light.png');
});
