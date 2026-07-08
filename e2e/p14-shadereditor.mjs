/**
 * Shader Editor e2e (P14-1). Switches a workspace area to the 'Shader Editor',
 * assigns a fresh material to the active cube, enables Use Nodes, then drives:
 * Shift+A add a Value node (keydown over the canvas), a value→roughness wire
 * via synthesized pointer events at computed socket positions, a param edit,
 * Ctrl+Z revert of the link, and delete semantics (value deletable, principled
 * refused). Coordinates come from window.__shaderEditor.socketPos — never
 * hardcoded pixels.
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  // 1. Give the active cube a fresh material.
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    const obj = s.activeObject;
    const mat = s.addMaterial('ShaderMat');
    obj.materialId = mat.id;
  })()`);

  // 2. Switch the WIDE viewport area to the Shader Editor (so the Principled
  //    node at graph x≈380 and its sockets stay on-screen — the narrow side
  //    columns would push it off-window under the param strip).
  t.check("'Shader Editor' offered in area dropdowns",
    await t.evaluate(`[...document.querySelectorAll('.wsp-area-select option')].some(o => o.value === 'shader')`));
  await t.evaluate(`(() => {
    const sel = [...document.querySelectorAll('.wsp-area-select')].find(s => s.value === 'viewport')
      || document.querySelector('.wsp-area-select');
    sel.value = 'shader';
    sel.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(300);
  t.check('shader editor canvas mounted', await t.evaluate(`!!document.querySelector('.shader-editor-canvas')`));
  t.check('header shows the material name',
    await t.evaluate(`document.querySelector('.shader-editor-matname').textContent === 'ShaderMat'`));

  // 3. Enable Use Nodes → an emptyGraph (just Principled) is created.
  await t.evaluate(`(() => {
    const cb = document.querySelector('.shader-editor-usenodes input');
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(200);
  const graphInfo = await t.evaluate(`(() => {
    const m = window.__app.scene.materials.find(m => m.name === 'ShaderMat');
    return { useNodes: m.useNodes, count: m.nodeGraph ? m.nodeGraph.nodes.length : 0,
      hasPrincipled: m.nodeGraph ? m.nodeGraph.nodes.some(n => n.type === 'principled') : false,
      ver: m.nodeGraphVersion || 0 };
  })()`);
  t.check('Use Nodes created a graph with a Principled output',
    graphInfo.useNodes && graphInfo.count === 1 && graphInfo.hasPrincipled, JSON.stringify(graphInfo));

  const matId = await t.evaluate(`window.__app.scene.materials.find(m => m.name === 'ShaderMat').id`);
  const gjson = () => `(() => { const m = window.__app.scene.getMaterial(${matId}); return JSON.stringify(m.nodeGraph); })()`;
  const gver = () => `(window.__app.scene.getMaterial(${matId}).nodeGraphVersion || 0)`;

  // Canvas rect for hover + Shift+A placement.
  const rect = await t.evaluate(`(() => { const r = document.querySelector('.shader-editor-canvas').getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`);
  const px = rect.left + rect.width * 0.28;
  const py = rect.top + rect.height * 0.55;

  // 4. Shift+A over the canvas → add menu, then add a Value node.
  await t.mouse('mouseMoved', px, py); // hover so the keydown is in-scope
  await t.sleep(40);
  await t.key('a', 'KeyA', 8); // shift
  await t.sleep(60);
  t.check('Shift+A opens the add-node menu', await t.evaluate(`!!document.querySelector('.shader-add-menu')`));
  t.check('add menu lists every registered def label',
    await t.evaluate(`[...document.querySelectorAll('.shader-add-item')].some(b => b.textContent === 'Value')`));
  await t.evaluate(`[...document.querySelectorAll('.shader-add-item')].find(b => b.dataset.type === 'value').click()`);
  await t.sleep(120);

  const valueId = await t.evaluate(`(() => { const m = window.__app.scene.getMaterial(${matId});
    const n = m.nodeGraph.nodes.find(n => n.type === 'value'); return n ? n.id : -1; })()`);
  t.check('Value node added', valueId >= 0);
  const princId = await t.evaluate(`(() => { const m = window.__app.scene.getMaterial(${matId});
    return m.nodeGraph.nodes.find(n => n.type === 'principled').id; })()`);

  // 5. Drag a wire: value.value (output) → principled.roughness (input).
  const verBeforeLink = await t.evaluate(gver());
  const fromP = await t.evaluate(`window.__shaderEditor.socketPos(${valueId}, 'value')`);
  const toP = await t.evaluate(`window.__shaderEditor.socketPos(${princId}, 'roughness')`);
  t.check('socketPos returns coordinates', !!fromP && !!toP, JSON.stringify({ fromP, toP }));
  await t.mouse('mouseMoved', fromP.x, fromP.y);
  await t.mouse('mousePressed', fromP.x, fromP.y, 'left');
  await t.mouse('mouseMoved', (fromP.x + toP.x) / 2, (fromP.y + toP.y) / 2);
  await t.mouse('mouseMoved', toP.x, toP.y);
  await t.mouse('mouseReleased', toP.x, toP.y, 'left');
  await t.sleep(120);

  const hasLink = await t.evaluate(`(() => { const m = window.__app.scene.getMaterial(${matId});
    return m.nodeGraph.links.some(l => l.fromNode === ${valueId} && l.toNode === ${princId} && l.toSocket === 'roughness'); })()`);
  t.check('wire drag created the value→roughness link', hasLink);
  t.check('nodeGraphVersion bumped by the link', (await t.evaluate(gver())) > verBeforeLink);

  const linkedJson = await t.evaluate(gjson());

  // 6. Param edit: set the Value node's value param via the side-strip input.
  await t.evaluate(`(() => { window.__shaderEditor; // ensure handle
    document.querySelector('.shader-editor-canvas'); })()`);
  // Select the value node (click its body) so the param strip shows its params.
  const center = await t.evaluate(`window.__shaderEditor.nodeCenterPos(${valueId})`);
  await t.click(center.x, center.y);
  await t.sleep(100);
  const wroteParam = await t.evaluate(`(() => {
    const inp = document.querySelector('.shader-editor-params input[data-key="value"]');
    if (!inp) return 'no-input';
    inp.value = '0.77';
    inp.dispatchEvent(new Event('change'));
    const m = window.__app.scene.getMaterial(${matId});
    const n = m.nodeGraph.nodes.find(n => n.id === ${valueId});
    return n.params.value;
  })()`);
  t.check('param edit writes the node param', wroteParam === 0.77, JSON.stringify(wroteParam));

  // 7. Ctrl+Z reverts the param, again reverts the link.
  await t.mouse('mouseMoved', px, py);
  await t.key('z', 'KeyZ', 2); // ctrl → undo param
  await t.sleep(80);
  const afterUndoParam = await t.evaluate(`(() => { const m = window.__app.scene.getMaterial(${matId});
    return m.nodeGraph.nodes.find(n => n.id === ${valueId}).params.value; })()`);
  t.check('Ctrl+Z reverts the param edit', afterUndoParam !== 0.77, JSON.stringify(afterUndoParam));

  await t.key('z', 'KeyZ', 2); // ctrl → undo link
  await t.sleep(80);
  const linkGone = await t.evaluate(`(() => { const m = window.__app.scene.getMaterial(${matId});
    return m.nodeGraph.links.length === 0; })()`);
  t.check('Ctrl+Z reverts the link', linkGone, linkedJson);

  // 8. Delete: value node is deletable; principled output is refused.
  const selValue = await t.evaluate(`window.__shaderEditor.nodeCenterPos(${valueId})`);
  await t.click(selValue.x, selValue.y);
  await t.sleep(60);
  await t.mouse('mouseMoved', selValue.x, selValue.y);
  await t.key('x', 'KeyX');
  await t.sleep(80);
  const valueGone = await t.evaluate(`(() => { const m = window.__app.scene.getMaterial(${matId});
    return !m.nodeGraph.nodes.some(n => n.id === ${valueId}); })()`);
  t.check('X deletes the selected Value node', valueGone);

  const selPrinc = await t.evaluate(`window.__shaderEditor.nodeCenterPos(${princId})`);
  await t.click(selPrinc.x, selPrinc.y);
  await t.sleep(60);
  await t.mouse('mouseMoved', selPrinc.x, selPrinc.y);
  await t.key('x', 'KeyX');
  await t.sleep(80);
  const princStays = await t.evaluate(`(() => { const m = window.__app.scene.getMaterial(${matId});
    return m.nodeGraph.nodes.some(n => n.id === ${princId}); })()`);
  t.check('deleting the Principled output is refused', princStays);
});
