/**
 * Shader node-graph undo (P14-1, decision A14).
 *
 * A GraphEditCommand snapshots the ENTIRE graph (plus the useNodes flag) as a
 * JSON string BEFORE and AFTER one discrete user gesture — add/delete node,
 * link/unlink, param commit, node-move end, or the Use-Nodes toggle. undo/redo
 * re-parse the snapshot through sanitizeGraph and write it back onto the
 * material, bumping nodeGraphVersion so the Renderer re-bakes and the tracer
 * re-samples. Snapshot-based, like MeshEditCommand: boring and always correct.
 */
import type { Command } from './UndoStack';
import type { Material } from '../scene/objectData';
import { sanitizeGraph, type NodeGraph } from '../nodes/nodeGraph';

/** The material state a graph command restores. */
interface GraphSnapshot {
  useNodes: boolean;
  graph: NodeGraph | null;
}

/** Bump the material's graph version (re-bake + re-trace trigger). */
export function bumpGraphVersion(material: Material): void {
  material.nodeGraphVersion = (material.nodeGraphVersion ?? 0) + 1;
}

/** Serialize the material's graph-relevant state to a JSON string. */
function snapshot(material: Material): string {
  const state: GraphSnapshot = { useNodes: material.useNodes, graph: material.nodeGraph };
  return JSON.stringify(state);
}

export class GraphEditCommand implements Command {
  private constructor(
    readonly name: string,
    private readonly material: Material,
    private readonly before: string,
    private readonly after: string,
  ) {}

  /**
   * Snapshot the material, run `mutate` (which performs the whole gesture on
   * material.nodeGraph / material.useNodes), then snapshot again. One command
   * per user gesture. The caller is responsible for bumping the version live;
   * undo/redo bump it themselves.
   */
  static capture(name: string, material: Material, mutate: () => void): GraphEditCommand {
    const before = snapshot(material);
    mutate();
    const after = snapshot(material);
    return new GraphEditCommand(name, material, before, after);
  }

  /** Build directly from two JSON snapshots (for modal/deferred gestures). */
  static fromSnapshots(name: string, material: Material, before: string, after: string): GraphEditCommand {
    return new GraphEditCommand(name, material, before, after);
  }

  private restore(json: string): void {
    const state = JSON.parse(json) as GraphSnapshot;
    this.material.useNodes = state.useNodes;
    this.material.nodeGraph = state.graph ? sanitizeGraph(state.graph) : null;
    bumpGraphVersion(this.material);
  }

  undo(): void {
    this.restore(this.before);
  }

  redo(): void {
    this.restore(this.after);
  }
}
