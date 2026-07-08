import { describe, it, expect } from 'vitest';
import './coreNodes';
import {
  addLink,
  addNode,
  emptyGraph,
  outputNode,
  registerNodeDef,
  removeNode,
  sanitizeGraph,
} from './nodeGraph';
import { coerce, evaluateGraph } from './evaluate';

describe('node graph model', () => {
  it('emptyGraph has exactly a principled output', () => {
    const g = emptyGraph();
    expect(g.nodes.length).toBe(1);
    expect(outputNode(g)?.type).toBe('principled');
  });

  it('addLink connects and replaces the input single-source', () => {
    const g = emptyGraph();
    const out = outputNode(g)!;
    const a = addNode(g, 'value', 0, 0);
    const b = addNode(g, 'value', 0, 50);
    expect(addLink(g, a.id, 'value', out.id, 'roughness')).toBe(true);
    expect(addLink(g, b.id, 'value', out.id, 'roughness')).toBe(true);
    const into = g.links.filter((l) => l.toNode === out.id && l.toSocket === 'roughness');
    expect(into.length).toBe(1);
    expect(into[0].fromNode).toBe(b.id);
  });

  it('addLink refuses cycles, self-links and bad sockets', () => {
    const g = emptyGraph();
    const out = outputNode(g)!;
    const a = addNode(g, 'value', 0, 0);
    expect(addLink(g, a.id, 'value', a.id, 'value')).toBe(false);
    expect(addLink(g, a.id, 'nope', out.id, 'roughness')).toBe(false);
    expect(addLink(g, a.id, 'value', out.id, 'nope')).toBe(false);
    // out has no outputs, so a real cycle can't be built from core nodes alone;
    // simulate with a raw link then sanitize.
    const raw = JSON.parse(JSON.stringify(g));
    raw.links.push({ fromNode: a.id, fromSocket: 'value', toNode: out.id, toSocket: 'roughness' });
    expect(() => sanitizeGraph({ ...raw, links: [...raw.links, { fromNode: out.id, fromSocket: 'x', toNode: a.id, toSocket: 'y' }] })).toThrow();
  });

  it('removeNode drops its links', () => {
    const g = emptyGraph();
    const out = outputNode(g)!;
    const a = addNode(g, 'value', 0, 0);
    addLink(g, a.id, 'value', out.id, 'metallic');
    removeNode(g, a.id);
    expect(g.links.length).toBe(0);
    expect(g.nodes.length).toBe(1);
  });

  it('sanitizeGraph fills missing params with defaults and keeps ids', () => {
    const g = emptyGraph();
    const a = addNode(g, 'value', 3, 4);
    const raw = JSON.parse(JSON.stringify(g));
    delete raw.nodes.find((n: { id: number }) => n.id === a.id).params.value;
    const clean = sanitizeGraph(raw);
    const back = clean.nodes.find((n) => n.id === a.id)!;
    expect(back.params.value).toBe(0.5);
    expect(clean.nextNodeId).toBe(g.nextNodeId);
  });

  it('sanitizeGraph throws on unknown node types', () => {
    const g = emptyGraph();
    const raw = JSON.parse(JSON.stringify(g));
    raw.nodes.push({ id: 99, type: 'not-a-node', x: 0, y: 0, params: {} });
    expect(() => sanitizeGraph(raw)).toThrow(/unknown node type/);
  });
});

describe('evaluator', () => {
  it('unconnected output evaluates to socket defaults', () => {
    const g = emptyGraph();
    const s = evaluateGraph(g, { u: 0, v: 0 })!;
    expect(s.baseColor).toEqual([0.8, 0.8, 0.8]);
    expect(s.roughness).toBe(0.5);
    expect(s.metallic).toBe(0);
  });

  it('value → roughness and rgb → baseColor flow through', () => {
    const g = emptyGraph();
    const out = outputNode(g)!;
    const val = addNode(g, 'value', 0, 0);
    val.params.value = 0.9;
    const rgb = addNode(g, 'rgb', 0, 50);
    rgb.params.color = [1, 0, 0];
    addLink(g, val.id, 'value', out.id, 'roughness');
    addLink(g, rgb.id, 'color', out.id, 'baseColor');
    const s = evaluateGraph(g, { u: 0, v: 0 })!;
    expect(s.roughness).toBeCloseTo(0.9);
    expect(s.baseColor).toEqual([1, 0, 0]);
  });

  it('uv node feeds the sample coordinates; color→float coerces by luminance', () => {
    const g = emptyGraph();
    const out = outputNode(g)!;
    const uv = addNode(g, 'uv', 0, 0);
    addLink(g, uv.id, 'u', out.id, 'metallic');
    expect(evaluateGraph(g, { u: 0.25, v: 0 })!.metallic).toBeCloseTo(0.25);
    expect(coerce([1, 1, 1], 'float')).toBeCloseTo(1);
    expect(coerce(0.5, 'color')).toEqual([0.5, 0.5, 0.5]);
  });

  it('memoizes: a shared upstream node evaluates once per sample', () => {
    const g = emptyGraph();
    const out = outputNode(g)!;
    let evals = 0;
    // A counting node registered inline for the test.
    registerNodeDef({
      type: 'test-counter',
      label: 'Counter',
      inputs: [],
      outputs: [{ key: 'value', label: 'V', type: 'float', default: 0 }],
      params: [],
      eval: () => { evals++; return { value: 0.5 }; },
    });
    const c = addNode(g, 'test-counter', 0, 0);
    addLink(g, c.id, 'value', out.id, 'roughness');
    addLink(g, c.id, 'value', out.id, 'metallic');
    evaluateGraph(g, { u: 0, v: 0 });
    expect(evals).toBe(1);
  });
});
