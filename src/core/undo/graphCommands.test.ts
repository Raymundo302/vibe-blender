import { describe, it, expect } from 'vitest';
import { GraphEditCommand, bumpGraphVersion } from './graphCommands';
import { emptyGraph, addNode, addLink, outputNode } from '../nodes/nodeGraph';
import '../nodes/builtins';
import { makeMaterial, type Material } from '../scene/objectData';

function matWithGraph(): Material {
  const m = makeMaterial(0, 'M');
  m.nodeGraph = emptyGraph();
  m.useNodes = true;
  m.nodeGraphVersion = 0;
  return m;
}

describe('GraphEditCommand', () => {
  it('undo/redo restores exact graph JSON around an add-node gesture', () => {
    const m = matWithGraph();
    const beforeJson = JSON.stringify(m.nodeGraph);

    const cmd = GraphEditCommand.capture('Add Node', m, () => {
      addNode(m.nodeGraph!, 'value', 100, 100);
    });
    const afterJson = JSON.stringify(m.nodeGraph);
    expect(afterJson).not.toBe(beforeJson);

    cmd.undo();
    expect(JSON.stringify(m.nodeGraph)).toBe(beforeJson);

    cmd.redo();
    expect(JSON.stringify(m.nodeGraph)).toBe(afterJson);
  });

  it('bumps nodeGraphVersion on every undo and redo', () => {
    const m = matWithGraph();
    const v0 = m.nodeGraphVersion ?? 0;
    const cmd = GraphEditCommand.capture('Add', m, () => {
      addNode(m.nodeGraph!, 'rgb', 50, 50);
    });
    cmd.undo();
    const vAfterUndo = m.nodeGraphVersion ?? 0;
    expect(vAfterUndo).toBeGreaterThan(v0);
    cmd.redo();
    expect((m.nodeGraphVersion ?? 0)).toBeGreaterThan(vAfterUndo);
  });

  it('round-trips a link gesture (value → principled roughness)', () => {
    const m = matWithGraph();
    const value = addNode(m.nodeGraph!, 'value', 100, 100);
    const out = outputNode(m.nodeGraph!)!;
    const beforeJson = JSON.stringify(m.nodeGraph);

    const cmd = GraphEditCommand.capture('Connect', m, () => {
      addLink(m.nodeGraph!, value.id, 'value', out.id, 'roughness');
    });
    const afterJson = JSON.stringify(m.nodeGraph);
    expect(m.nodeGraph!.links.length).toBe(1);

    cmd.undo();
    expect(JSON.stringify(m.nodeGraph)).toBe(beforeJson);
    expect(m.nodeGraph!.links.length).toBe(0);

    cmd.redo();
    expect(JSON.stringify(m.nodeGraph)).toBe(afterJson);
    expect(m.nodeGraph!.links.length).toBe(1);
  });

  it('round-trips a param commit', () => {
    const m = matWithGraph();
    const value = addNode(m.nodeGraph!, 'value', 0, 0);
    const beforeJson = JSON.stringify(m.nodeGraph);
    const cmd = GraphEditCommand.capture('Param', m, () => {
      value.params.value = 0.9;
    });
    cmd.undo();
    expect(JSON.stringify(m.nodeGraph)).toBe(beforeJson);
    cmd.redo();
    const node = m.nodeGraph!.nodes.find((n) => n.id === value.id)!;
    expect(node.params.value).toBe(0.9);
  });

  it('round-trips the Use-Nodes toggle including a null graph', () => {
    const m = makeMaterial(0, 'M');
    expect(m.useNodes).toBe(false);
    expect(m.nodeGraph).toBe(null);

    const cmd = GraphEditCommand.capture('Use Nodes', m, () => {
      m.useNodes = true;
      m.nodeGraph = emptyGraph();
    });
    expect(m.useNodes).toBe(true);
    expect(m.nodeGraph).not.toBe(null);

    cmd.undo();
    expect(m.useNodes).toBe(false);
    expect(m.nodeGraph).toBe(null);

    cmd.redo();
    expect(m.useNodes).toBe(true);
    expect(m.nodeGraph!.nodes.some((n) => n.type === 'principled')).toBe(true);
  });

  it('bumpGraphVersion increments from undefined', () => {
    const m = makeMaterial(0, 'M');
    expect(m.nodeGraphVersion).toBeUndefined();
    bumpGraphVersion(m);
    expect(m.nodeGraphVersion).toBe(1);
    bumpGraphVersion(m);
    expect(m.nodeGraphVersion).toBe(2);
  });
});
