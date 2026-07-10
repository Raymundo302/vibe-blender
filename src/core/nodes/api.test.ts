import { describe, it, expect, beforeEach } from 'vitest';
import { createNodesApi } from './api';
import './builtins';
import { Scene } from '../scene/Scene';
import { UndoStack } from '../undo/UndoStack';

/**
 * Scriptable node-graph API (window.__app.nodes). Build a checker → ColorRamp
 * → Principled chain programmatically on a fresh scene material and assert the
 * public surface: list/links, validation throws, undo integration, and the
 * model's cycle guard surfaced as a readable error.
 */
describe('nodes API', () => {
  let scene: Scene;
  let undo: UndoStack;
  let matId: number;

  beforeEach(() => {
    scene = new Scene();
    undo = new UndoStack();
    matId = scene.addMaterial('Chain').id;
  });

  it('forMaterial enables useNodes + creates a default graph with a Principled output', () => {
    const api = createNodesApi({ scene, undo });
    const h = api.forMaterial(matId);
    const mat = scene.getMaterial(matId)!;
    expect(mat.useNodes).toBe(true);
    expect(mat.nodeGraph).not.toBeNull();
    // The default graph is just the output node.
    const nodes = h.list();
    expect(nodes.length).toBe(1);
    expect(nodes[0].type).toBe('principled');
    expect(h.output()).toBe(nodes[0].id);
  });

  it('resolves a material by name too, and throws readably on a bad ref', () => {
    const api = createNodesApi({ scene, undo });
    expect(api.forMaterial('Chain').material.id).toBe(matId);
    expect(() => api.forMaterial('Nope')).toThrow(/no material/i);
  });

  it('builds the classic checker → ramp → BSDF chain; list() and links() reflect it', () => {
    const api = createNodesApi({ scene, undo });
    const h = api.forMaterial(matId);
    const out = h.output();
    const checker = h.add('checker', { scale: 4 }, [40, 40]);
    const ramp = h.add('colorRamp', undefined, [240, 40]);
    h.connect(checker, 'color', ramp, 'fac');
    h.connect(ramp, 'color', out, 'baseColor');

    const list = h.list();
    expect(list.map((n) => n.type).sort()).toEqual(['checker', 'colorRamp', 'principled']);
    // params were applied + merged with the def defaults.
    const checkerNode = list.find((n) => n.id === checker)!;
    expect(checkerNode.params.scale).toBe(4);
    expect(checkerNode.params.colorA).toBeDefined();

    const links = h.links();
    expect(links).toContainEqual({ from: [checker, 'color'], to: [ramp, 'fac'] });
    expect(links).toContainEqual({ from: [ramp, 'color'], to: [out, 'baseColor'] });
    expect(links.length).toBe(2);
  });

  it('add() throws on an invalid type, naming the valid types', () => {
    const api = createNodesApi({ scene, undo });
    const h = api.forMaterial(matId);
    let err: Error | null = null;
    try { h.add('bogus'); } catch (e) { err = e as Error; }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/unknown node type "bogus"/);
    // The message lists real registered types.
    expect(err!.message).toMatch(/checker/);
    expect(err!.message).toMatch(/principled/);
  });

  it('connect() throws on an invalid socket', () => {
    const api = createNodesApi({ scene, undo });
    const h = api.forMaterial(matId);
    const out = h.output();
    const checker = h.add('checker');
    expect(() => h.connect(checker, 'nope', out, 'baseColor')).toThrow(/output socket "nope"/);
    expect(() => h.connect(checker, 'color', out, 'nope')).toThrow(/input socket "nope"/);
  });

  it('set() throws on an unknown param key, naming the valid params', () => {
    const api = createNodesApi({ scene, undo });
    const h = api.forMaterial(matId);
    const checker = h.add('checker');
    expect(() => h.set(checker, { bogus: 1 })).toThrow(/no param "bogus".*scale/s);
  });

  it('each mutation is one undoable command; undo reverts an add', () => {
    const api = createNodesApi({ scene, undo });
    const h = api.forMaterial(matId);
    expect(h.list().length).toBe(1); // just the output
    const before = undo.pushCount;
    h.add('checker');
    expect(undo.pushCount).toBe(before + 1);
    expect(h.list().length).toBe(2);

    undo.undo();
    expect(h.list().length).toBe(1);
    expect(h.list().some((n) => n.type === 'checker')).toBe(false);

    undo.redo();
    expect(h.list().some((n) => n.type === 'checker')).toBe(true);
  });

  it('batch() collapses a whole chain into ONE undoable command', () => {
    const api = createNodesApi({ scene, undo });
    const h = api.forMaterial(matId);
    const before = undo.pushCount;
    h.batch('Build Chain', () => {
      const out = h.output();
      const checker = h.add('checker');
      const ramp = h.add('colorRamp');
      h.connect(checker, 'color', ramp, 'fac');
      h.connect(ramp, 'color', out, 'baseColor');
    });
    expect(undo.pushCount).toBe(before + 1);
    expect(h.list().length).toBe(3);
    undo.undo();
    expect(h.list().length).toBe(1); // whole chain gone in one undo
  });

  it('surfaces the model cycle guard as a thrown error', () => {
    const api = createNodesApi({ scene, undo });
    const h = api.forMaterial(matId);
    // math -> mixColor -> math would loop.
    const a = h.add('math');
    const b = h.add('mixColor');
    h.connect(a, 'value', b, 'fac');
    expect(() => h.connect(b, 'color', a, 'a')).toThrow(/cycle/i);
  });

  it('remove() drops a node + its links but protects the output node', () => {
    const api = createNodesApi({ scene, undo });
    const h = api.forMaterial(matId);
    const out = h.output();
    const checker = h.add('checker');
    h.connect(checker, 'color', out, 'baseColor');
    expect(h.links().length).toBe(1);
    h.remove(checker);
    expect(h.list().some((n) => n.id === checker)).toBe(false);
    expect(h.links().length).toBe(0);
    expect(() => h.remove(out)).toThrow(/output node/i);
  });

  it('disconnect() removes the link feeding an input socket', () => {
    const api = createNodesApi({ scene, undo });
    const h = api.forMaterial(matId);
    const out = h.output();
    const checker = h.add('checker');
    h.connect(checker, 'color', out, 'baseColor');
    expect(h.links().length).toBe(1);
    h.disconnect(out, 'baseColor');
    expect(h.links().length).toBe(0);
  });
});
