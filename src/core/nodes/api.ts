/**
 * Scriptable node-graph API (Use & Refine punch-list: "scriptable node-graph
 * API"). A small, dependency-light programmatic surface for building and
 * editing a Material's shader node graph WITHOUT the Shader Editor UI — for
 * demos, e2e, and the video's "scripting the donut's shader live" beat.
 *
 * Exposed on the existing debug handle as `window.__app.nodes` (see main.ts).
 *
 * INVARIANT — every mutating call goes through the SAME undo path as the
 * Shader Editor (GraphEditCommand snapshots the whole graph + bumps
 * nodeGraphVersion), so scripted edits are undoable AND the live consumers
 * react: the Rendered viewport re-bakes on the version bump (Renderer.ts →
 * ensureBaked), the tracer re-samples, and an OPEN Shader Editor re-reads the
 * graph the next frame (it polls a signature of id|useNodes|version|nodeCount
 * in update()). No UI is imported here — the API talks only to the pure graph
 * model + the undo command.
 */
import type { Scene } from '../scene/Scene';
import type { UndoStack } from '../undo/UndoStack';
import type { Material } from '../scene/objectData';
import {
  addNode, addLink, removeNode, removeLink, emptyGraph, getNodeDef, allNodeDefs,
  outputNode, type NodeGraph, type GraphNode,
} from './nodeGraph';
import { GraphEditCommand, bumpGraphVersion } from '../undo/graphCommands';
import { ensureBaked, bakeResolution } from './bake';
import { nodeImageCache } from './imageCache';

/** One node as reported by GraphHandle.list(). params is a shallow copy. */
export interface NodeInfo {
  id: number;
  type: string;
  params: Record<string, unknown>;
}

/** One link as reported by GraphHandle.links(). */
export interface LinkInfo {
  from: [number, string];
  to: [number, string];
}

/**
 * A handle onto one material's node graph. Each mutating method is ONE
 * undoable command unless wrapped in batch(), which collapses everything it
 * runs into a single command.
 */
export interface GraphHandle {
  /** The material this handle edits. */
  readonly material: Material;
  /** Snapshot of every node (id, type, and a copy of its params). */
  list(): NodeInfo[];
  /** Snapshot of every link. */
  links(): LinkInfo[];
  /** Add a node of `type`; returns its new id. Throws on an unknown type. */
  add(type: string, params?: Record<string, unknown>, pos?: [number, number]): number;
  /** Partial-merge params onto a node. Throws on unknown node or param key. */
  set(nodeId: number, params: Record<string, unknown>): void;
  /** Connect an output socket to an input socket. Throws on bad socket/cycle. */
  connect(fromId: number, fromSocket: string, toId: number, toSocket: string): void;
  /** Remove whatever link feeds an input socket. Throws on bad node/socket. */
  disconnect(toId: number, toSocket: string): void;
  /** Remove a node and its links (the output node is protected). */
  remove(nodeId: number): void;
  /** The output (Principled) node's id. */
  output(): number;
  /** Force a re-bake of the graph to textures; returns the baked map size. */
  bake(): { width: number; height: number };
  /** Run several edits as ONE undoable command. */
  batch(name: string, fn: () => void): void;
}

export interface NodesApi {
  /**
   * Get a GraphHandle for a material (by id or by name). Enables `useNodes`
   * and creates an empty default graph if the material has none yet — mirroring
   * what the Shader Editor does the first time you turn on nodes — as one
   * undoable "Enable Nodes" command. Throws a readable error if no such
   * material exists.
   */
  forMaterial(ref: number | string): GraphHandle;
}

class GraphHandleImpl implements GraphHandle {
  private batchDepth = 0;

  constructor(readonly material: Material, private readonly undo: UndoStack) {}

  /** The live graph, re-read every call (undo replaces the object wholesale). */
  private graph(): NodeGraph {
    const g = this.material.nodeGraph;
    if (!g) throw new Error('material has no node graph (call forMaterial first)');
    return g;
  }

  private node(id: number): GraphNode {
    const n = this.graph().nodes.find((x) => x.id === id);
    if (!n) throw new Error(`no node with id ${id} in this graph`);
    return n;
  }

  /** One undoable command around `mutate` — unless inside a batch(). */
  private run(name: string, mutate: () => void): void {
    if (this.batchDepth > 0) { mutate(); return; }
    const cmd = GraphEditCommand.capture(name, this.material, mutate);
    this.undo.push(cmd);
    bumpGraphVersion(this.material);
  }

  list(): NodeInfo[] {
    return this.graph().nodes.map((n) => ({ id: n.id, type: n.type, params: { ...n.params } }));
  }

  links(): LinkInfo[] {
    return this.graph().links.map((l) => ({
      from: [l.fromNode, l.fromSocket],
      to: [l.toNode, l.toSocket],
    }));
  }

  add(type: string, params?: Record<string, unknown>, pos?: [number, number]): number {
    const def = getNodeDef(type);
    if (!def) {
      const valid = allNodeDefs().map((d) => d.type).sort().join(', ');
      throw new Error(`unknown node type "${type}". valid types: ${valid}`);
    }
    let id = -1;
    this.run(`Add ${def.label}`, () => {
      const node = addNode(this.graph(), type, pos?.[0] ?? 0, pos?.[1] ?? 0);
      if (params) this.mergeParams(node, params);
      id = node.id;
    });
    return id;
  }

  set(nodeId: number, params: Record<string, unknown>): void {
    // Validate against the live node BEFORE opening a command (fail cleanly).
    const node = this.node(nodeId);
    const def = getNodeDef(node.type)!;
    const valid = new Set(def.params.map((p) => p.key));
    for (const key of Object.keys(params)) {
      if (!valid.has(key)) {
        const names = def.params.map((p) => p.key).join(', ') || '(none)';
        throw new Error(`node ${nodeId} (${node.type}) has no param "${key}". valid params: ${names}`);
      }
    }
    this.run('Set Params', () => this.mergeParams(this.node(nodeId), params));
  }

  private mergeParams(node: GraphNode, params: Record<string, unknown>): void {
    const def = getNodeDef(node.type)!;
    const valid = new Set(def.params.map((p) => p.key));
    for (const [key, value] of Object.entries(params)) {
      if (valid.has(key)) node.params[key] = value;
    }
  }

  connect(fromId: number, fromSocket: string, toId: number, toSocket: string): void {
    const from = this.node(fromId);
    const to = this.node(toId);
    const fromDef = getNodeDef(from.type)!;
    const toDef = getNodeDef(to.type)!;
    if (!fromDef.outputs.some((s) => s.key === fromSocket)) {
      const names = fromDef.outputs.map((s) => s.key).join(', ') || '(none)';
      throw new Error(`node ${fromId} (${from.type}) has no output socket "${fromSocket}". outputs: ${names}`);
    }
    if (!toDef.inputs.some((s) => s.key === toSocket)) {
      const names = toDef.inputs.map((s) => s.key).join(', ') || '(none)';
      throw new Error(`node ${toId} (${to.type}) has no input socket "${toSocket}". inputs: ${names}`);
    }
    let ok = false;
    this.run('Connect', () => { ok = addLink(this.graph(), fromId, fromSocket, toId, toSocket); });
    if (!ok) {
      throw new Error(
        `connection ${fromId}.${fromSocket} → ${toId}.${toSocket} rejected ` +
        '(would create a cycle in the graph)',
      );
    }
  }

  disconnect(toId: number, toSocket: string): void {
    const to = this.node(toId);
    const toDef = getNodeDef(to.type)!;
    if (!toDef.inputs.some((s) => s.key === toSocket)) {
      const names = toDef.inputs.map((s) => s.key).join(', ') || '(none)';
      throw new Error(`node ${toId} (${to.type}) has no input socket "${toSocket}". inputs: ${names}`);
    }
    this.run('Disconnect', () => removeLink(this.graph(), toId, toSocket));
  }

  remove(nodeId: number): void {
    const node = this.node(nodeId);
    if (node.type === 'principled') {
      throw new Error('cannot remove the output node (principled)');
    }
    this.run('Remove Node', () => removeNode(this.graph(), nodeId));
  }

  output(): number {
    const out = outputNode(this.graph());
    if (!out) throw new Error('graph has no output (principled) node');
    return out.id;
  }

  bake(): { width: number; height: number } {
    ensureBaked(this.material, nodeImageCache());
    const size = bakeResolution(this.material);
    return { width: size, height: size };
  }

  batch(name: string, fn: () => void): void {
    if (this.batchDepth > 0) { fn(); return; }
    const cmd = GraphEditCommand.capture(name, this.material, () => {
      this.batchDepth++;
      try { fn(); } finally { this.batchDepth--; }
    });
    this.undo.push(cmd);
    bumpGraphVersion(this.material);
  }
}

/**
 * Build the scriptable node-graph API for a scene + undo stack. main.ts wires
 * the result onto `window.__app.nodes`.
 */
export function createNodesApi(deps: { scene: Scene; undo: UndoStack }): NodesApi {
  const { scene, undo } = deps;

  const resolve = (ref: number | string): Material => {
    const mat = typeof ref === 'number'
      ? scene.getMaterial(ref)
      : scene.materials.find((m) => m.name === ref);
    if (!mat) {
      const known = scene.materials.map((m) => `${m.id}:${m.name}`).join(', ') || '(none)';
      throw new Error(`no material ${JSON.stringify(ref)}. existing materials: ${known}`);
    }
    return mat;
  };

  return {
    forMaterial(ref: number | string): GraphHandle {
      const material = resolve(ref);
      if (!material.useNodes || !material.nodeGraph) {
        const cmd = GraphEditCommand.capture('Enable Nodes', material, () => {
          material.useNodes = true;
          if (!material.nodeGraph) material.nodeGraph = emptyGraph();
        });
        undo.push(cmd);
        bumpGraphVersion(material);
      }
      return new GraphHandleImpl(material, undo);
    },
  };
}
