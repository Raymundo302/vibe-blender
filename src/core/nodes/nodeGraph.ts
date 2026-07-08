/**
 * Shader node graph — data model (F14-1, decision A14).
 *
 * Plain serializable data: a NodeGraph is { nodes, links } of JSON-safe
 * values, stored verbatim on a Material and in scene files. Behavior lives in
 * a NodeDef REGISTRY keyed by node type (the modifier-registry pattern):
 * each def declares typed input/output sockets, editable params, and a pure
 * eval() over resolved input values. The evaluator (evaluate.ts) pulls from
 * the output node with memoization + a cycle guard.
 *
 * Two consumers, one evaluator (A14): the path tracer evaluates per hit
 * (exact), the Rendered viewport bakes the graph to textures through the
 * F13-1 map slots (fast). Neither is imported here — this file is pure data +
 * registry so unit tests need no GL and no DOM.
 */

/** Socket value kinds. float ↔ color/vector coerce (see coerce()). */
export type SocketType = 'float' | 'color' | 'vector';

/** A runtime value flowing through a link. */
export type NodeValue = number | [number, number, number];

export interface SocketDef {
  key: string;
  label: string;
  type: SocketType;
  /** Value used when the socket is unconnected (and no param overrides). */
  default: NodeValue;
}

export interface ParamDef {
  key: string;
  label: string;
  kind: 'float' | 'color' | 'select' | 'image' | 'ramp';
  /** For 'select': the allowed options. */
  options?: string[];
  /** For 'float': slider bounds. */
  min?: number;
  max?: number;
  default: unknown;
}

/** Per-sample shading context handed to node eval()s. */
export interface EvalContext {
  /** Surface UV of the sample point. */
  u: number;
  v: number;
  /**
   * Decoded images for 'image' params, keyed by the param's data-URL string.
   * The evaluator's CALLER fills this (browser decodes; tests build arrays
   * directly). Raw 0..1 RGB, row 0 = top — the F13-1 map-cache convention.
   */
  images?: Map<string, { width: number; height: number; pixels: Float32Array }>;
}

export interface NodeDef {
  type: string;
  label: string;
  inputs: SocketDef[];
  outputs: SocketDef[];
  params: ParamDef[];
  /**
   * Pure function of resolved inputs + params + ctx → one value per output
   * key. MUST be deterministic (seeded noise only — Math.random forbidden).
   */
  eval(
    inputs: Record<string, NodeValue>,
    params: Record<string, unknown>,
    ctx: EvalContext,
  ): Record<string, NodeValue>;
}

/** One node instance in a graph — pure JSON (params hold JSON-safe values). */
export interface GraphNode {
  id: number;
  type: string;
  /** Editor canvas position (the graph UI owns the meaning). */
  x: number;
  y: number;
  params: Record<string, unknown>;
}

/** A connection: from an output socket to an input socket. */
export interface GraphLink {
  fromNode: number;
  fromSocket: string;
  toNode: number;
  toSocket: string;
}

export interface NodeGraph {
  nodes: GraphNode[];
  links: GraphLink[];
  nextNodeId: number;
}

// --- registry ---------------------------------------------------------------

const REGISTRY = new Map<string, NodeDef>();

export function registerNodeDef(def: NodeDef): void {
  REGISTRY.set(def.type, def);
}

export function getNodeDef(type: string): NodeDef | undefined {
  return REGISTRY.get(type);
}

export function allNodeDefs(): NodeDef[] {
  return [...REGISTRY.values()];
}

// --- graph construction helpers ----------------------------------------------

/** A fresh graph containing just a Principled output node. */
export function emptyGraph(): NodeGraph {
  const graph: NodeGraph = { nodes: [], links: [], nextNodeId: 0 };
  addNode(graph, 'principled', 380, 120);
  return graph;
}

export function addNode(graph: NodeGraph, type: string, x: number, y: number): GraphNode {
  const def = getNodeDef(type);
  if (!def) throw new Error(`unknown node type "${type}"`);
  const params: Record<string, unknown> = {};
  for (const p of def.params) params[p.key] = structuredCloneish(p.default);
  const node: GraphNode = { id: graph.nextNodeId++, type, x, y, params };
  graph.nodes.push(node);
  return node;
}

/** Remove a node and every link touching it. */
export function removeNode(graph: NodeGraph, nodeId: number): void {
  graph.nodes = graph.nodes.filter((n) => n.id !== nodeId);
  graph.links = graph.links.filter((l) => l.fromNode !== nodeId && l.toNode !== nodeId);
}

/**
 * Connect an output socket to an input socket. Replaces any existing link
 * into that input (inputs are single-source). Returns false — graph
 * unchanged — if the link would create a cycle or references a missing
 * node/socket.
 */
export function addLink(
  graph: NodeGraph,
  fromNode: number,
  fromSocket: string,
  toNode: number,
  toSocket: string,
): boolean {
  if (fromNode === toNode) return false;
  const from = graph.nodes.find((n) => n.id === fromNode);
  const to = graph.nodes.find((n) => n.id === toNode);
  if (!from || !to) return false;
  const fromDef = getNodeDef(from.type);
  const toDef = getNodeDef(to.type);
  if (!fromDef?.outputs.some((s) => s.key === fromSocket)) return false;
  if (!toDef?.inputs.some((s) => s.key === toSocket)) return false;
  // Cycle check: can we already reach `fromNode` by walking downstream links
  // from `toNode`? (A link to→…→from + the new from→to edge would loop.)
  if (reaches(graph, toNode, fromNode)) return false;
  graph.links = graph.links.filter((l) => !(l.toNode === toNode && l.toSocket === toSocket));
  graph.links.push({ fromNode, fromSocket, toNode, toSocket });
  return true;
}

export function removeLink(graph: NodeGraph, toNode: number, toSocket: string): void {
  graph.links = graph.links.filter((l) => !(l.toNode === toNode && l.toSocket === toSocket));
}

/** True if `target` is reachable walking OUTPUT-direction links from `start`. */
function reaches(graph: NodeGraph, start: number, target: number): boolean {
  const seen = new Set<number>();
  const stack = [start];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const l of graph.links) if (l.fromNode === id) stack.push(l.toNode);
  }
  return false;
}

/** The graph's output node (type 'principled'), or null. */
export function outputNode(graph: NodeGraph): GraphNode | null {
  return graph.nodes.find((n) => n.type === 'principled') ?? null;
}

/**
 * Validate a graph parsed from a scene file: known types, params filled with
 * defaults for missing keys, links pruned to real nodes/sockets, acyclic
 * (cyclic files throw — matching sceneJson's validate-before-mutate rule).
 */
export function sanitizeGraph(raw: NodeGraph): NodeGraph {
  const graph: NodeGraph = { nodes: [], links: [], nextNodeId: raw.nextNodeId ?? 0 };
  for (const n of raw.nodes ?? []) {
    const def = getNodeDef(n.type);
    if (!def) throw new Error(`unknown node type "${n.type}"`);
    const params: Record<string, unknown> = {};
    for (const p of def.params) {
      params[p.key] = n.params && p.key in n.params ? n.params[p.key] : structuredCloneish(p.default);
    }
    graph.nodes.push({ id: n.id, type: n.type, x: n.x ?? 0, y: n.y ?? 0, params });
    graph.nextNodeId = Math.max(graph.nextNodeId, n.id + 1);
  }
  for (const l of raw.links ?? []) {
    if (!addLink(graph, l.fromNode, l.fromSocket, l.toNode, l.toSocket)) {
      throw new Error(`invalid or cyclic node link ${l.fromNode}.${l.fromSocket} → ${l.toNode}.${l.toSocket}`);
    }
  }
  return graph;
}

/** Deep-enough clone for param defaults (arrays of numbers, plain objects). */
function structuredCloneish<T>(v: T): T {
  return v === null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v));
}
