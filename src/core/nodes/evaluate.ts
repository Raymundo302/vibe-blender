import {
  getNodeDef,
  outputNode,
  type EvalContext,
  type NodeGraph,
  type GraphNode,
  type NodeValue,
  type SocketType,
} from './nodeGraph';

/**
 * Node-graph evaluator (F14-1). Pull-based: resolve the Principled output
 * node's inputs by recursively evaluating upstream nodes, memoized per node
 * per sample. The graph is guaranteed acyclic by addLink/sanitizeGraph; a
 * defensive in-progress set still breaks corrupt cycles (returns defaults)
 * instead of overflowing the stack.
 */

/** What the Principled output resolves to at one shading sample. */
export interface ShadedSample {
  baseColor: [number, number, number];
  metallic: number;
  roughness: number;
  emissive: [number, number, number];
  emissiveStrength: number;
}

export function coerce(value: NodeValue, to: SocketType): NodeValue {
  if (to === 'float') {
    if (typeof value === 'number') return value;
    // Rec.709 luminance — matches how the tracer reads grayscale maps.
    return 0.2126 * value[0] + 0.7152 * value[1] + 0.0722 * value[2];
  }
  if (typeof value === 'number') return [value, value, value];
  return value;
}

/**
 * Evaluate the graph at one sample. Returns null when the graph has no
 * Principled output node (callers fall back to the material's flat params).
 */
export function evaluateGraph(graph: NodeGraph, ctx: EvalContext): ShadedSample | null {
  const out = outputNode(graph);
  if (!out) return null;
  const memo = new Map<number, Record<string, NodeValue>>();
  const inProgress = new Set<number>();

  const evalNode = (node: GraphNode): Record<string, NodeValue> => {
    const cached = memo.get(node.id);
    if (cached) return cached;
    const def = getNodeDef(node.type);
    if (!def || inProgress.has(node.id)) return {};
    inProgress.add(node.id);
    const inputs: Record<string, NodeValue> = {};
    for (const socket of def.inputs) {
      const link = graph.links.find((l) => l.toNode === node.id && l.toSocket === socket.key);
      let v: NodeValue | undefined;
      if (link) {
        const upstream = graph.nodes.find((n) => n.id === link.fromNode);
        if (upstream) v = evalNode(upstream)[link.fromSocket];
      }
      inputs[socket.key] = coerce(v ?? socket.default, socket.type);
    }
    inProgress.delete(node.id);
    const result = def.eval(inputs, node.params, ctx);
    memo.set(node.id, result);
    return result;
  };

  const r = evalNode(out);
  const color3 = (v: NodeValue | undefined, d: [number, number, number]): [number, number, number] => {
    if (v === undefined) return d;
    const c = coerce(v, 'color') as [number, number, number];
    return [c[0], c[1], c[2]];
  };
  const float = (v: NodeValue | undefined, d: number): number =>
    v === undefined ? d : (coerce(v, 'float') as number);

  return {
    baseColor: color3(r.baseColor, [0.8, 0.8, 0.8]),
    metallic: clamp01(float(r.metallic, 0)),
    roughness: clamp01(float(r.roughness, 0.5)),
    emissive: color3(r.emissive, [0, 0, 0]),
    emissiveStrength: Math.max(0, float(r.emissiveStrength, 0)),
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
