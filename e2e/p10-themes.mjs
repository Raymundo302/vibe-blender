/**
 * P10-3 e2e — theme system. Verifies:
 *  1. Claude theme (default boot) is pixel-identical to today in the key spots:
 *     topbar bg, panel bg, accent color (getComputedStyle) + viewport clear pixel.
 *  2. The picker switches themes live: ice-blue → light DOM + light viewport
 *     pixel; retro-dos → dark green; reload persists; back to claude → originals.
 *
 * Run with the dev server up:  flock /tmp/vibe-blender-e2e.lock node e2e/p10-themes.mjs
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  // Read a --vb-<token> from :root (the live theme source of truth).
  const cssVar = (name) =>
    t.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--vb-${name}').trim().toLowerCase()`);
  // Computed background-color of a selector, as an "rgb(r, g, b)" string.
  const bgOf = (sel) =>
    t.evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).backgroundColor`);
  // Render one frame and read a corner pixel of the WebGL viewport (the clear
  // color). preserveDrawingBuffer is false, so read in the same synchronous turn.
  const readCorner = () => t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const px = new Uint8Array(4);
    gl.readPixels(2, c.height - 3, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // top-left = sky/bg
    return [px[0], px[1], px[2]];
  })()`);
  // Open the picker and click a theme row.
  const pick = async (id) => {
    await t.evaluate(`document.querySelector('.topbar-btn[data-action="theme-picker"]').click()`);
    const opened = await t.until(`!!document.querySelector('.theme-picker')`, 3000);
    t.check(`picker opens for ${id}`, opened);
    await t.evaluate(`document.querySelector('.theme-picker-row[data-theme=${JSON.stringify(id)}]').click()`);
    await t.sleep(150);
    t.check(`picker closes after choosing ${id}`,
      await t.evaluate(`!document.querySelector('.theme-picker')`));
  };
  const isGrey = (p, lo, hi) =>
    p.every((c) => c >= lo && c <= hi) && Math.abs(p[0] - p[1]) < 12 && Math.abs(p[1] - p[2]) < 12;

  // ---------------------------------------------------------------- baseline
  // Fresh profile boots to the Claude theme. Assert the checked spots.
  t.check('boots on the Claude theme', (await t.evaluate('!!window.__app')) === true);

  t.check('topbar bg is Claude #1d1d1d', (await bgOf('#topbar')) === 'rgb(29, 29, 29)');
  t.check('panel (sidebar) bg is Claude #2b2b2b', (await bgOf('.wsp-area')) === 'rgb(43, 43, 43)');
  t.check('accent var is Claude orange #fe730f', (await cssVar('accent')) === '#fe730f');

  // The active outliner row paints with the accent — a concrete accent element.
  const activeRowBg = await t.evaluate(
    `(() => { const r = document.querySelector('.outliner-row.outliner-active'); return r ? getComputedStyle(r).backgroundColor : null; })()`);
  if (activeRowBg !== null) {
    t.check('active outliner row uses accent (rgb(254, 115, 15))', activeRowBg === 'rgb(254, 115, 15)');
  } else {
    console.log('SKIP  no active outliner row present — accent-element check skipped (var asserted)');
  }

  const claudeCorner = await readCorner();
  t.check('viewport corner is Claude grey (~58)', isGrey(claudeCorner, 44, 92), claudeCorner.join(', '));

  // The picker button exists with a stable data-action hook.
  t.check('theme-picker button present',
    await t.evaluate(`!!document.querySelector('.topbar-btn[data-action="theme-picker"]')`));

  // Picker highlights the current theme (claude) as active with a check mark.
  await t.evaluate(`document.querySelector('.topbar-btn[data-action="theme-picker"]').click()`);
  await t.until(`!!document.querySelector('.theme-picker')`, 3000);
  t.check('picker lists all 8 themes',
    (await t.evaluate(`document.querySelectorAll('.theme-picker-row').length`)) === 8);
  t.check('current theme (claude) row is highlighted active',
    await t.evaluate(`document.querySelector('.theme-picker-row[data-theme="claude"]').classList.contains('theme-picker-active')`));
  // Escape closes it (does not change theme).
  await t.key('Escape', 'Escape', 0);
  await t.sleep(80);
  t.check('Escape closes the picker', await t.evaluate(`!document.querySelector('.theme-picker')`));
  t.check('Escape left the theme unchanged (still claude accent)', (await cssVar('accent')) === '#fe730f');

  // ------------------------------------------------------------- ice-blue (light)
  await pick('ice-blue');
  t.check('ice-blue: topbar bg → light #dfe6ee', (await bgOf('#topbar')) === 'rgb(223, 230, 238)');
  t.check('ice-blue: panel bg → light #f2f5f9', (await bgOf('.wsp-area')) === 'rgb(242, 245, 249)');
  t.check('ice-blue: accent var → #4a90e2', (await cssVar('accent')) === '#4a90e2');
  const iceCorner = await readCorner();
  t.check('ice-blue: viewport corner reads light grey (all channels > 150)',
    iceCorner.every((c) => c > 150), iceCorner.join(', '));

  // ------------------------------------------------------------- retro-dos (dark green)
  await pick('retro-dos');
  t.check('retro-dos: panel bg → #101a10', (await bgOf('.wsp-area')) === 'rgb(16, 26, 16)');
  t.check('retro-dos: text var → phosphor green #7dff7d', (await cssVar('text')) === '#7dff7d');
  const dosCorner = await readCorner();
  t.check('retro-dos: viewport corner is dark green (g >= r, g >= b, dark)',
    dosCorner[1] >= dosCorner[0] && dosCorner[1] >= dosCorner[2] && dosCorner[0] < 45 && dosCorner[2] < 45,
    dosCorner.join(', '));

  // ------------------------------------------------------------- persistence
  t.check('retro-dos persisted to localStorage',
    (await t.evaluate(`localStorage.getItem('vibe-blender-theme')`)) === 'retro-dos');
  await t.reload();
  t.check('after reload: still retro-dos panel bg #101a10', (await bgOf('.wsp-area')) === 'rgb(16, 26, 16)');
  t.check('after reload: accent var → retro-dos #33ff33', (await cssVar('accent')) === '#33ff33');
  const dosCorner2 = await readCorner();
  t.check('after reload: viewport corner still dark green',
    dosCorner2[1] >= dosCorner2[0] && dosCorner2[1] >= dosCorner2[2] && dosCorner2[0] < 45,
    dosCorner2.join(', '));

  // ------------------------------------------------------------- back to claude
  await pick('claude');
  t.check('back to claude: topbar bg → #1d1d1d', (await bgOf('#topbar')) === 'rgb(29, 29, 29)');
  t.check('back to claude: panel bg → #2b2b2b', (await bgOf('.wsp-area')) === 'rgb(43, 43, 43)');
  t.check('back to claude: accent var → #fe730f', (await cssVar('accent')) === '#fe730f');
  const claudeCorner2 = await readCorner();
  t.check('back to claude: viewport corner matches the original claude pixel',
    Math.abs(claudeCorner2[0] - claudeCorner[0]) <= 2 &&
    Math.abs(claudeCorner2[1] - claudeCorner[1]) <= 2 &&
    Math.abs(claudeCorner2[2] - claudeCorner[2]) <= 2,
    `${claudeCorner2.join(', ')} vs ${claudeCorner.join(', ')}`);

  // Theme choice is NOT undoable (app preference) — Ctrl+Z must not revert it.
  await pick('carbon-fusion');
  t.check('carbon-fusion applied', (await cssVar('accent')) === '#ff2d55');
  await t.key('z', 'KeyZ', 2); // ctrl+z
  await t.sleep(100);
  t.check('Ctrl+Z does NOT revert the theme (still carbon-fusion)', (await cssVar('accent')) === '#ff2d55');

  // Leave storage on claude so a later suite boots from the frozen look.
  await pick('claude');
  await t.evaluate(`localStorage.setItem('vibe-blender-theme', 'claude')`);
});
