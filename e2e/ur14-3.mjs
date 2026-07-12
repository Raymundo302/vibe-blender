/**
 * UR14-3 — panel polish batch acceptance checks.
 *
 *  (1) Web Page section labels no longer OVERLAP their inputs — Ray's exact
 *      repro: select an HTML plane, build the Object tab's Web Page section,
 *      and probe every label rect against its row's control rect for
 *      intersection (the old bug clipped "Page Width" etc. across the field).
 *  (2) A styled tooltip appears when hovering a toolbar button (~150ms).
 *  (3) The Properties panel header names the active tab ("Properties · Object",
 *      updating when the tab switches).
 *  (4) N-panel vertical tab hit targets are ≥24px.
 *
 * Run: E2E_PORT=9769 node e2e/ur14-3.mjs   (dev server on :5199)
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  await t.key('Escape', 'Escape', 0); // dismiss splash
  t.check('app booted', await t.until('!!window.__app'));

  // =====================================================================
  // (1) Web Page section — labels do NOT overlap their inputs.
  // =====================================================================
  await t.evaluate(`(async () => {
    window.__hp = await import('/src/tools/htmlPlane.ts');
  })()`);
  t.check('htmlPlane module ready', await t.until('!!window.__hp'));

  await t.evaluate(`(() => {
    const S = window.__app.scene, U = window.__app.undo;
    // Clean slate so the added plane is the sole, active object.
    for (const o of [...S.objects]) S.remove(o.id);
    U.clear();
    window.__wpDone = null;
    const html = '<!DOCTYPE html><html><head><title>Bouncy Ball</title></head>' +
      '<body><div class="ball"></div></body></html>';
    window.__hp.addHtmlPlaneFromText(S, U, html, 'bouncy-ball').then((r) => {
      S.selectOnly(r.obj.id);
      window.__wp = r.obj;
      window.__wpDone = true;
    }).catch((e) => { window.__wpDone = { error: String(e) }; });
  })()`);
  t.check('HTML plane added + selected', await t.until('window.__wpDone === true'));

  // Let the frame loop build/show the Web Page section for the active plane.
  await t.evaluate('window.__app.workspaces.update();');
  await t.sleep(250);
  t.check('Web Page section is shown',
    await t.until(`(() => { const s = document.querySelector('.web-page-section');
      return !!s && getComputedStyle(s).display !== 'none'; })()`));

  // Rect-intersection probe: for every labelled row, the label must not overlap
  // the row's control (input). Reports the worst offender if any intersect.
  const overlap = await t.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.web-page-section .web-page-row')];
    const intersects = (a, b) => !(a.right <= b.left || a.left >= b.right ||
                                    a.bottom <= b.top || a.top >= b.bottom);
    const offenders = [];
    for (const row of rows) {
      const label = row.querySelector('.web-page-label');
      const control = row.querySelector('input, select, button');
      if (!label || !control) continue;
      const lr = label.getBoundingClientRect();
      const cr = control.getBoundingClientRect();
      // ignore hidden zero-size rows
      if (lr.width === 0 || cr.width === 0) continue;
      if (intersects(lr, cr)) offenders.push({
        text: label.textContent,
        label: { l: Math.round(lr.left), r: Math.round(lr.right), t: Math.round(lr.top), b: Math.round(lr.bottom) },
        control: { l: Math.round(cr.left), r: Math.round(cr.right), t: Math.round(cr.top), b: Math.round(cr.bottom) },
      });
    }
    return { rowCount: rows.length, offenders };
  })()`);
  console.log('web-page overlap probe: ' + JSON.stringify(overlap));
  t.check('Web Page rows exist to probe', overlap.rowCount >= 4, JSON.stringify(overlap));
  t.check("NO Web Page label overlaps its input (Ray's repro)",
    overlap.offenders.length === 0, JSON.stringify(overlap.offenders));

  await t.screenshot('/tmp/ur14-3-webpage-fixed.png');

  // The ▶ / ● / Re-rasterize buttons are labelled (text or title/tip).
  const btnLabels = await t.evaluate(`(() => {
    const b = (a) => document.querySelector('.web-page-section [data-action="' + a + '"]');
    const lbl = (el) => el && (el.textContent.trim() || el.title || el.dataset.tip || '');
    return { play: lbl(b('play-toggle')), key: lbl(b('play-key')), reraster: lbl(b('reraster')) };
  })()`);
  t.check('▶/●/Re-rasterize buttons carry labels/tooltips: ' + JSON.stringify(btnLabels),
    !!btnLabels.play && !!btnLabels.key && !!btnLabels.reraster);

  // =====================================================================
  // (2) Toolbar hover shows a styled tooltip after ~150ms.
  // =====================================================================
  // Object mode so the Move tool button is present.
  await t.evaluate(`(() => { const S = window.__app.scene; if (S.editMode) S.exitEditMode(); })()`);
  await t.sleep(80);
  t.check('toolbar Move button present',
    await t.until(`!!document.querySelector('.viewport-toolbar [data-tool-id="move"]')`));
  const moveCenter = await t.evaluate(`(() => {
    const r = document.querySelector('.viewport-toolbar [data-tool-id="move"]').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  // No tooltip before hovering.
  t.check('tooltip hidden before hover',
    (await t.evaluate(`!!window.__tooltip && window.__tooltip.visible()`)) !== true);
  await t.mouse('mouseMoved', moveCenter.x, moveCenter.y);
  await t.sleep(300); // > 150ms show delay
  const tipShown = await t.evaluate(`(() => window.__tooltip ? {
    visible: window.__tooltip.visible(), text: window.__tooltip.text() } : null)()`);
  console.log('toolbar tooltip: ' + JSON.stringify(tipShown));
  t.check('styled tooltip appears on toolbar hover',
    !!tipShown && tipShown.visible === true && /Move/.test(tipShown.text), JSON.stringify(tipShown));
  t.check('tooltip includes the shortcut chip (G)', !!tipShown && /G/.test(tipShown.text), JSON.stringify(tipShown));
  // Move the pointer away → tooltip hides.
  await t.mouse('mouseMoved', 5, 5);
  await t.sleep(120);
  t.check('tooltip hides when pointer leaves',
    (await t.evaluate(`window.__tooltip.visible()`)) === false);

  // =====================================================================
  // (3) Properties panel header names the active tab.
  // =====================================================================
  const propTitle = () => t.evaluate(`(() => {
    const h = [...document.querySelectorAll('.panel-title')].find((n) => n.textContent.startsWith('Properties'));
    return h ? h.textContent : null;
  })()`);
  await t.evaluate('window.__app.workspaces.update();');
  await t.sleep(60);
  const initTitle = await propTitle();
  t.check('Properties header names the active tab (starts "Properties · ")',
    typeof initTitle === 'string' && initTitle.startsWith('Properties · ') && initTitle.length > 'Properties · '.length,
    String(initTitle));

  // Switch to a second tab and confirm the header follows its title.
  const switched = await t.evaluate(`(() => {
    const btns = [...document.querySelectorAll('.properties-tab-btn')];
    const active = document.querySelector('.properties-tab-btn.properties-tab-active');
    const other = btns.find((b) => b !== active);
    if (!other) return null;
    other.click();
    return other.title || other.dataset.tip || '';
  })()`);
  await t.evaluate('window.__app.workspaces.update();');
  await t.sleep(120);
  const afterTitle = await propTitle();
  console.log('properties header: ' + JSON.stringify({ initTitle, switched, afterTitle }));
  t.check('header updates to the newly selected tab',
    !switched || (typeof afterTitle === 'string' && afterTitle === 'Properties · ' + switched),
    JSON.stringify({ switched, afterTitle }));

  // =====================================================================
  // (4) N-panel vertical tab hit targets ≥24px.
  // =====================================================================
  await t.evaluate(`(() => { const s = window.__app.scene; if (s.editMode) s.exitEditMode();
    if (s.objects[0]) s.selectOnly(s.objects[0].id); })()`);
  await t.sleep(80);
  // Open the N-panel if not already open.
  const isOpen = await t.evaluate(`(() => { const p = document.querySelector('.n-panel');
    return !!p && p.style.display !== 'none'; })()`);
  if (!isOpen) { await t.key('n', 'KeyN'); await t.sleep(150); }
  t.check('N-panel open with tabs',
    await t.until(`document.querySelectorAll('.n-panel-tab').length >= 2`));
  const tabRects = await t.evaluate(`(() => [...document.querySelectorAll('.n-panel-tab')].map((el) => {
    const r = el.getBoundingClientRect();
    return { tab: el.dataset.tab, w: Math.round(r.width), h: Math.round(r.height) };
  }))()`);
  console.log('n-panel tab rects: ' + JSON.stringify(tabRects));
  t.check('every N-panel tab hit target is ≥24px (width & height)',
    tabRects.length >= 2 && tabRects.every((r) => r.w >= 24 && r.h >= 24), JSON.stringify(tabRects));

  await t.screenshot('/tmp/ur14-3-npanel.png');
});
