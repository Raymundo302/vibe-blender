/**
 * Shader Editor (P14-1) — a workspace editor with its OWN 2D canvas that draws
 * and edits a Material's node graph (F14-1 data model). It is GENERIC over the
 * NodeDef registry: every node is drawn from its NodeDef (title, typed sockets)
 * and its params rendered by a small DOM side-strip on the right — no node type
 * is ever hardcoded, so P14-2/P14-3 nodes appear automatically.
 *
 * Interactions live on the canvas element (NOT InputManager): drag a node body
 * to move it, drag from an output socket to an input socket to connect, click a
 * linked input socket to unlink, wheel to zoom, MMB / space-drag to pan,
 * Shift+A (only while the pointer is over this canvas) to add a node, X/Delete
 * to remove the selected node (the Principled output is protected), Esc to close
 * the add menu. Every discrete gesture pushes ONE GraphEditCommand.
 */
import type { Scene } from '../core/scene/Scene';
import type { UndoStack } from '../core/undo/UndoStack';
import type { Material } from '../core/scene/objectData';
import {
  allNodeDefs, getNodeDef, addNode, removeNode, addLink, removeLink,
  emptyGraph, type GraphNode, type NodeGraph, type ParamDef, type SocketType,
} from '../core/nodes/nodeGraph';
import { GraphEditCommand, bumpGraphVersion, snapshotMaterial } from '../core/undo/graphCommands';
import { decodeNodeImage } from '../core/nodes/imageCache';
import './shaderEditor.css';

// Node geometry, in GRAPH units (scaled by zoom for drawing / hit-testing).
const NODE_W = 156;
const TITLE_H = 26;
const ROW_H = 20;
const BODY_PAD = 8;
const SOCKET_R = 5;

const SOCKET_COLORS: Record<SocketType, string> = {
  float: '#9a9a9a',
  color: '#d8c24a',
  vector: '#6a8cff',
};

function nodeBodyHeight(node: GraphNode): number {
  const def = getNodeDef(node.type);
  const rows = def ? Math.max(def.inputs.length, def.outputs.length) : 0;
  return TITLE_H + rows * ROW_H + BODY_PAD;
}

export interface ShaderEditorDeps {
  scene: Scene;
  undo: UndoStack;
}

export class ShaderEditor {
  readonly element: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx2d: CanvasRenderingContext2D;
  private readonly matNameEl: HTMLElement;
  private readonly useNodesInput: HTMLInputElement;
  private readonly hintEl: HTMLElement;
  private readonly paramsEl: HTMLElement;
  private readonly scene: Scene;
  private readonly undo: UndoStack;

  private zoom = 1;
  private panX = 20;
  private panY = 20;
  private cssW = 0;
  private cssH = 0;

  private selectedNodeId: number | null = null;
  private hovered = false;
  private spaceHeld = false;
  private pointerGraph: [number, number] = [0, 0];
  private lastSig = '';

  private wire: null | { fromNode: number; fromSocket: string; to: [number, number] } = null;
  private nodeDrag: null | { id: number; dx: number; dy: number; before: string; moved: boolean } = null;
  private panning: null | { x: number; y: number } = null;
  private flash: null | { from: [number, number]; to: [number, number]; ticks: number } = null;
  private addMenu: HTMLElement | null = null;

  private accent = '#fe730f';
  private accentTick = 0;

  private readonly onWheel: (e: WheelEvent) => void;
  private readonly onPointerDown: (e: PointerEvent) => void;
  private readonly onPointerMove: (e: PointerEvent) => void;
  private readonly onPointerUp: (e: PointerEvent) => void;
  private readonly onEnter: () => void;
  private readonly onLeave: () => void;
  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly onKeyUp: (e: KeyboardEvent) => void;

  constructor(deps: ShaderEditorDeps) {
    this.scene = deps.scene;
    this.undo = deps.undo;

    this.element = document.createElement('div');
    this.element.className = 'shader-editor';
    this.element.tabIndex = 0;

    const header = document.createElement('div');
    header.className = 'shader-editor-header';
    this.matNameEl = document.createElement('span');
    this.matNameEl.className = 'shader-editor-matname';
    const useLabel = document.createElement('label');
    useLabel.className = 'shader-editor-usenodes';
    this.useNodesInput = document.createElement('input');
    this.useNodesInput.type = 'checkbox';
    useLabel.append(this.useNodesInput, document.createTextNode('Use Nodes'));
    this.hintEl = document.createElement('span');
    this.hintEl.className = 'shader-editor-hint';
    this.hintEl.textContent = 'assign a material in Properties first';
    header.append(this.matNameEl, useLabel, this.hintEl);
    this.element.append(header);

    const body = document.createElement('div');
    body.className = 'shader-editor-body';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'shader-editor-canvas';
    this.ctx2d = this.canvas.getContext('2d')!;
    this.paramsEl = document.createElement('div');
    this.paramsEl.className = 'shader-editor-params';
    body.append(this.canvas, this.paramsEl);
    this.element.append(body);

    this.useNodesInput.addEventListener('change', () => this.toggleUseNodes());

    this.onWheel = (e) => this.handleWheel(e);
    this.onPointerDown = (e) => this.handlePointerDown(e);
    this.onPointerMove = (e) => this.handlePointerMove(e);
    this.onPointerUp = () => this.handlePointerUp();
    this.onEnter = () => { this.hovered = true; };
    this.onLeave = () => { this.hovered = false; };
    this.onKeyDown = (e) => this.handleKeyDown(e);
    this.onKeyUp = (e) => { if (e.code === 'Space') this.spaceHeld = false; };

    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointerenter', this.onEnter);
    this.canvas.addEventListener('pointerleave', this.onLeave);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('keyup', this.onKeyUp, true);

    const handle = {
      canvas: this.canvas,
      socketPos: (nodeId: number, socketKey: string) => this.socketClientPos(nodeId, socketKey),
      nodeCenterPos: (nodeId: number) => this.nodeCenterClientPos(nodeId),
      selectedNode: () => this.selectedNodeId,
      nodeCount: () => this.graph()?.nodes.length ?? 0,
      addMenuOpen: () => !!this.addMenu,
    };
    (this.element as unknown as Record<string, unknown>).__shaderEditor = handle;
    (window as unknown as Record<string, unknown>).__shaderEditor = handle;
  }

  destroy(): void {
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerenter', this.onEnter);
    this.canvas.removeEventListener('pointerleave', this.onLeave);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('keyup', this.onKeyUp, true);
    this.closeAddMenu();
    if ((window as unknown as Record<string, unknown>).__shaderEditor
      === (this.element as unknown as Record<string, unknown>).__shaderEditor) {
      delete (window as unknown as Record<string, unknown>).__shaderEditor;
    }
  }

  // --- Material / graph resolution -----------------------------------------

  /** The active mesh object's assigned material, or null. */
  private activeMaterial(): Material | null {
    const obj = this.scene.activeObject;
    if (!obj || obj.kind !== 'mesh' || obj.materialId === null) return null;
    return this.scene.getMaterial(obj.materialId) ?? null;
  }

  /** The graph currently being edited (material + useNodes + graph present). */
  private editable(): { material: Material; graph: NodeGraph } | null {
    const material = this.activeMaterial();
    if (!material || !material.useNodes || !material.nodeGraph) return null;
    return { material, graph: material.nodeGraph };
  }

  private graph(): NodeGraph | null {
    return this.editable()?.graph ?? null;
  }

  // --- View transforms ------------------------------------------------------

  private graphToPx(gx: number, gy: number): [number, number] {
    return [gx * this.zoom + this.panX, gy * this.zoom + this.panY];
  }

  private pxToGraph(px: number, py: number): [number, number] {
    return [(px - this.panX) / this.zoom, (py - this.panY) / this.zoom];
  }

  private localXY(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  /** Socket center in GRAPH space. kind 'in' = left edge, 'out' = right edge. */
  private socketGraphPos(node: GraphNode, kind: 'in' | 'out', index: number): [number, number] {
    const gx = kind === 'in' ? node.x : node.x + NODE_W;
    const gy = node.y + TITLE_H + ROW_H * (index + 0.5);
    return [gx, gy];
  }

  /** Locate a socket by key (searches inputs then outputs). */
  private findSocket(node: GraphNode, key: string): { kind: 'in' | 'out'; index: number } | null {
    const def = getNodeDef(node.type);
    if (!def) return null;
    const ii = def.inputs.findIndex((s) => s.key === key);
    if (ii >= 0) return { kind: 'in', index: ii };
    const oi = def.outputs.findIndex((s) => s.key === key);
    if (oi >= 0) return { kind: 'out', index: oi };
    return null;
  }

  private socketClientPos(nodeId: number, socketKey: string): { x: number; y: number } | null {
    const graph = this.graph();
    const node = graph?.nodes.find((n) => n.id === nodeId);
    if (!node) return null;
    const loc = this.findSocket(node, socketKey);
    if (!loc) return null;
    const [gx, gy] = this.socketGraphPos(node, loc.kind, loc.index);
    const [px, py] = this.graphToPx(gx, gy);
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + px, y: r.top + py };
  }

  private nodeCenterClientPos(nodeId: number): { x: number; y: number } | null {
    const graph = this.graph();
    const node = graph?.nodes.find((n) => n.id === nodeId);
    if (!node) return null;
    const [px, py] = this.graphToPx(node.x + NODE_W / 2, node.y + TITLE_H / 2);
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + px, y: r.top + py };
  }

  // --- Hit testing (graph space) -------------------------------------------

  private socketAt(gx: number, gy: number): { node: GraphNode; kind: 'in' | 'out'; key: string } | null {
    const graph = this.graph();
    if (!graph) return null;
    const rr = (SOCKET_R + 4) * (SOCKET_R + 4);
    for (let i = graph.nodes.length - 1; i >= 0; i--) {
      const node = graph.nodes[i];
      const def = getNodeDef(node.type);
      if (!def) continue;
      for (let s = 0; s < def.inputs.length; s++) {
        const [sx, sy] = this.socketGraphPos(node, 'in', s);
        if ((sx - gx) ** 2 + (sy - gy) ** 2 <= rr) return { node, kind: 'in', key: def.inputs[s].key };
      }
      for (let s = 0; s < def.outputs.length; s++) {
        const [sx, sy] = this.socketGraphPos(node, 'out', s);
        if ((sx - gx) ** 2 + (sy - gy) ** 2 <= rr) return { node, kind: 'out', key: def.outputs[s].key };
      }
    }
    return null;
  }

  private nodeAt(gx: number, gy: number): GraphNode | null {
    const graph = this.graph();
    if (!graph) return null;
    for (let i = graph.nodes.length - 1; i >= 0; i--) {
      const node = graph.nodes[i];
      const h = nodeBodyHeight(node);
      if (gx >= node.x && gx <= node.x + NODE_W && gy >= node.y && gy <= node.y + h) return node;
    }
    return null;
  }

  // --- Command helpers ------------------------------------------------------

  private commit(name: string, material: Material, mutate: () => void): void {
    const cmd = GraphEditCommand.capture(name, material, mutate);
    this.undo.push(cmd);
    bumpGraphVersion(material);
    this.rebuildParams();
  }

  // --- Use Nodes ------------------------------------------------------------

  private toggleUseNodes(): void {
    const material = this.activeMaterial();
    if (!material) { this.syncHeader(); return; }
    const want = this.useNodesInput.checked;
    this.commit(want ? 'Enable Nodes' : 'Disable Nodes', material, () => {
      material.useNodes = want;
      if (want && !material.nodeGraph) material.nodeGraph = emptyGraph();
    });
  }

  // --- Interaction ----------------------------------------------------------

  private handleWheel(e: WheelEvent): void {
    e.preventDefault();
    const [mx, my] = this.localXY(e);
    const [bx, by] = this.pxToGraph(mx, my);
    const factor = Math.exp(-e.deltaY * 0.0015);
    this.zoom = Math.max(0.2, Math.min(2.5, this.zoom * factor));
    // Keep the graph point under the cursor fixed.
    this.panX = mx - bx * this.zoom;
    this.panY = my - by * this.zoom;
  }

  private handlePointerDown(e: PointerEvent): void {
    this.canvas.focus();
    this.element.focus();
    this.closeAddMenu();
    const [mx, my] = this.localXY(e);
    const [gx, gy] = this.pxToGraph(mx, my);
    this.pointerGraph = [gx, gy];

    // Pan: MMB, or space+LMB.
    if (e.button === 1 || (e.button === 0 && this.spaceHeld)) {
      e.preventDefault();
      this.panning = { x: e.clientX, y: e.clientY };
      return;
    }
    if (e.button !== 0) return;
    const graph = this.graph();
    if (!graph) return;

    const sock = this.socketAt(gx, gy);
    if (sock) {
      if (sock.kind === 'out') {
        this.wire = { fromNode: sock.node.id, fromSocket: sock.key, to: [gx, gy] };
      } else {
        // Clicking a LINKED input unlinks it.
        const material = this.activeMaterial()!;
        const linked = graph.links.some((l) => l.toNode === sock.node.id && l.toSocket === sock.key);
        if (linked) {
          this.commit('Disconnect', material, () => removeLink(graph, sock.node.id, sock.key));
        }
      }
      return;
    }

    const node = this.nodeAt(gx, gy);
    if (node) {
      this.selectedNodeId = node.id;
      const material = this.activeMaterial()!;
      this.nodeDrag = { id: node.id, dx: gx - node.x, dy: gy - node.y, before: snapshotMaterial(material), moved: false };
      this.rebuildParams();
    } else {
      this.selectedNodeId = null;
      this.rebuildParams();
    }
  }

  private handlePointerMove(e: PointerEvent): void {
    const [mx, my] = this.localXY(e);
    this.pointerGraph = this.pxToGraph(mx, my);

    if (this.panning) {
      this.panX += e.clientX - this.panning.x;
      this.panY += e.clientY - this.panning.y;
      this.panning = { x: e.clientX, y: e.clientY };
      return;
    }
    if (this.wire) {
      this.wire.to = this.pointerGraph;
      return;
    }
    if (this.nodeDrag) {
      const graph = this.graph();
      const node = graph?.nodes.find((n) => n.id === this.nodeDrag!.id);
      if (node) {
        node.x = this.pointerGraph[0] - this.nodeDrag.dx;
        node.y = this.pointerGraph[1] - this.nodeDrag.dy;
        this.nodeDrag.moved = true;
      }
    }
  }

  private handlePointerUp(): void {
    if (this.panning) { this.panning = null; return; }

    if (this.wire) {
      const wire = this.wire;
      this.wire = null;
      const [gx, gy] = this.pointerGraph;
      const target = this.socketAt(gx, gy);
      const graph = this.graph();
      const material = this.activeMaterial();
      if (target && target.kind === 'in' && graph && material) {
        let ok = false;
        const cmd = GraphEditCommand.capture('Connect', material, () => {
          ok = addLink(graph, wire.fromNode, wire.fromSocket, target.node.id, target.key);
        });
        if (ok) {
          this.undo.push(cmd);
          bumpGraphVersion(material);
          this.rebuildParams();
          return;
        }
      }
      // Rejected / dropped on nothing → brief red flash of the attempted wire.
      const from = this.socketGraphPosByKey(wire.fromNode, wire.fromSocket);
      if (from) this.flash = { from, to: [gx, gy], ticks: 18 };
      return;
    }

    if (this.nodeDrag) {
      const drag = this.nodeDrag;
      this.nodeDrag = null;
      const material = this.activeMaterial();
      if (drag.moved && material) {
        this.undo.push(GraphEditCommand.fromSnapshots('Move Node', material, drag.before, snapshotMaterial(material)));
        bumpGraphVersion(material);
      }
    }
  }

  private socketGraphPosByKey(nodeId: number, key: string): [number, number] | null {
    const node = this.graph()?.nodes.find((n) => n.id === nodeId);
    if (!node) return null;
    const loc = this.findSocket(node, key);
    return loc ? this.socketGraphPos(node, loc.kind, loc.index) : null;
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (this.addMenu) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); this.closeAddMenu(); }
      return;
    }
    // Scoped strictly to this pane: only when the pointer is over the canvas.
    if (!this.hovered) return;
    // Ignore while typing in the side-strip param inputs.
    const a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;

    if (e.code === 'Space') {
      // Space over this pane is the pan modifier — claim it fully so the
      // global timeline play/pause (InputManager) never co-fires while the
      // user space-pans the graph (same scoping as Shift+A below).
      e.preventDefault();
      e.stopImmediatePropagation();
      this.spaceHeld = true;
      return;
    }

    if (e.code === 'KeyA' && e.shiftKey) {
      e.preventDefault(); e.stopImmediatePropagation();
      this.openAddMenu();
      return;
    }
    if ((e.code === 'KeyX' || e.key === 'Delete') && this.selectedNodeId !== null) {
      e.preventDefault(); e.stopImmediatePropagation();
      this.deleteSelected();
    }
  }

  private deleteSelected(): void {
    const ed = this.editable();
    if (!ed || this.selectedNodeId === null) return;
    const node = ed.graph.nodes.find((n) => n.id === this.selectedNodeId);
    if (!node || node.type === 'principled') return; // output node is protected
    const id = node.id;
    this.commit('Delete Node', ed.material, () => removeNode(ed.graph, id));
    this.selectedNodeId = null;
    this.rebuildParams();
  }

  // --- Add-node menu --------------------------------------------------------

  private openAddMenu(): void {
    if (!this.editable()) return;
    this.closeAddMenu();
    const menu = document.createElement('div');
    menu.className = 'shader-add-menu';
    const [mx, my] = this.graphToPxSafe(this.pointerGraph);
    menu.style.left = `${mx}px`;
    menu.style.top = `${my}px`;
    for (const def of allNodeDefs()) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'shader-add-item';
      btn.textContent = def.label;
      btn.dataset.type = def.type;
      btn.addEventListener('click', () => this.addNodeOfType(def.type));
      menu.append(btn);
    }
    this.element.append(menu);
    this.addMenu = menu;
  }

  private graphToPxSafe(g: [number, number]): [number, number] {
    return this.graphToPx(g[0], g[1]);
  }

  private closeAddMenu(): void {
    this.addMenu?.remove();
    this.addMenu = null;
  }

  private addNodeOfType(type: string): void {
    const ed = this.editable();
    this.closeAddMenu();
    if (!ed) return;
    const [gx, gy] = this.pointerGraph;
    let created: GraphNode | null = null;
    this.commit('Add ' + (getNodeDef(type)?.label ?? type), ed.material, () => {
      created = addNode(ed.graph, type, gx, gy);
    });
    if (created) this.selectedNodeId = (created as GraphNode).id;
    this.rebuildParams();
  }

  // --- Param side-strip -----------------------------------------------------

  private rebuildParams(): void {
    this.paramsEl.replaceChildren();
    const ed = this.editable();
    if (!ed || this.selectedNodeId === null) { this.paramsEl.style.display = 'none'; return; }
    const node = ed.graph.nodes.find((n) => n.id === this.selectedNodeId);
    const def = node && getNodeDef(node.type);
    if (!node || !def) { this.paramsEl.style.display = 'none'; return; }
    this.paramsEl.style.display = '';

    const title = document.createElement('h4');
    title.className = 'shader-param-title';
    title.textContent = def.label;
    this.paramsEl.append(title);

    if (def.params.length === 0) {
      const none = document.createElement('div');
      none.className = 'shader-param-none';
      none.textContent = '(no parameters)';
      this.paramsEl.append(none);
      return;
    }
    for (const p of def.params) this.paramsEl.append(this.paramRow(ed.material, node, p));
  }

  private paramRow(material: Material, node: GraphNode, p: ParamDef): HTMLElement {
    const row = document.createElement('div');
    row.className = 'shader-param-row';
    const label = document.createElement('label');
    label.className = 'shader-param-label';
    label.textContent = p.label;
    row.append(label);
    const setParam = (value: unknown): void => {
      this.commit('Edit ' + p.label, material, () => { node.params[p.key] = value; });
    };

    if (p.kind === 'float') {
      const num = document.createElement('input');
      num.type = 'number';
      num.className = 'shader-param-input';
      num.dataset.key = p.key;
      num.step = '0.01';
      if (p.min !== undefined) num.min = String(p.min);
      if (p.max !== undefined) num.max = String(p.max);
      num.value = String(typeof node.params[p.key] === 'number' ? node.params[p.key] : 0);
      const range = document.createElement('input');
      range.type = 'range';
      range.className = 'shader-param-range';
      range.min = String(p.min ?? 0);
      range.max = String(p.max ?? 1);
      range.step = '0.001';
      range.value = num.value;
      num.addEventListener('input', () => { range.value = num.value; });
      num.addEventListener('change', () => setParam(Number(num.value)));
      range.addEventListener('input', () => { num.value = range.value; });
      range.addEventListener('change', () => setParam(Number(range.value)));
      row.append(num, range);
    } else if (p.kind === 'color') {
      const col = document.createElement('input');
      col.type = 'color';
      col.className = 'shader-param-input';
      col.dataset.key = p.key;
      col.value = rgbToHex(node.params[p.key]);
      col.addEventListener('change', () => setParam(hexToRgb(col.value)));
      row.append(col);
    } else if (p.kind === 'select') {
      const sel = document.createElement('select');
      sel.className = 'shader-param-input';
      sel.dataset.key = p.key;
      for (const opt of p.options ?? []) {
        const o = document.createElement('option');
        o.value = opt; o.textContent = opt;
        sel.append(o);
      }
      sel.value = String(node.params[p.key] ?? '');
      sel.addEventListener('change', () => setParam(sel.value));
      row.append(sel);
    } else if (p.kind === 'image') {
      const file = document.createElement('input');
      file.type = 'file';
      file.accept = 'image/*';
      file.className = 'shader-param-input';
      file.dataset.key = p.key;
      file.addEventListener('change', () => {
        const f = file.files?.[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => {
          const url = String(reader.result);
          void decodeNodeImage(url).catch(() => { /* undecodable — bake/tracer skip */ });
          setParam(url);
        };
        reader.readAsDataURL(f);
      });
      row.append(file);
    } else {
      // ramp → skip a custom widget; show disabled placeholder text.
      const ramp = document.createElement('span');
      ramp.className = 'shader-param-ramp';
      ramp.textContent = '(ramp)';
      row.append(ramp);
    }
    return row;
  }

  // --- Header sync ----------------------------------------------------------

  private syncHeader(): void {
    const obj = this.scene.activeObject;
    const material = this.activeMaterial();
    if (!obj || obj.kind !== 'mesh' || !material) {
      this.matNameEl.textContent = material ? material.name : '—';
      this.useNodesInput.checked = false;
      this.useNodesInput.disabled = true;
      this.hintEl.style.display = '';
    } else {
      this.matNameEl.textContent = material.name;
      this.useNodesInput.disabled = false;
      this.useNodesInput.checked = material.useNodes;
      this.hintEl.style.display = 'none';
    }
  }

  // --- Frame ----------------------------------------------------------------

  update(): void {
    this.resize();
    if (this.accentTick-- <= 0) {
      this.accentTick = 60;
      const a = getComputedStyle(document.documentElement).getPropertyValue('--vb-accent').trim();
      if (a) this.accent = a;
    }
    this.syncHeader();

    // Cheap-poll for external changes (material switch, undo, version bump).
    const material = this.activeMaterial();
    const graph = this.graph();
    const sig = `${material?.id ?? -1}|${material?.useNodes ?? false}|${material?.nodeGraphVersion ?? 0}|${graph?.nodes.length ?? 0}`;
    if (sig !== this.lastSig) {
      this.lastSig = sig;
      // Drop a stale selection that no longer exists in the current graph.
      if (this.selectedNodeId !== null && !graph?.nodes.some((n) => n.id === this.selectedNodeId)) {
        this.selectedNodeId = null;
      }
      this.closeAddMenu();
      this.rebuildParams();
    }

    if (this.flash && --this.flash.ticks <= 0) this.flash = null;
    this.draw(graph);
  }

  private resize(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    const dpr = window.devicePixelRatio || 1;
    if (w !== this.cssW || h !== this.cssH || this.canvas.width !== Math.round(w * dpr)) {
      this.cssW = w;
      this.cssH = h;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  private draw(graph: NodeGraph | null): void {
    const c = this.ctx2d;
    const W = this.cssW; const H = this.cssH;
    if (W === 0 || H === 0) return;
    c.clearRect(0, 0, W, H);
    c.fillStyle = '#232323';
    c.fillRect(0, 0, W, H);
    this.drawDots();

    if (!graph) {
      c.fillStyle = 'rgba(220,220,220,0.4)';
      c.font = '13px sans-serif';
      c.textAlign = 'center';
      c.fillText('Enable “Use Nodes” to edit this material’s shader graph', W / 2, H / 2);
      c.textAlign = 'left';
      return;
    }

    // Links behind nodes.
    for (const l of graph.links) {
      const from = this.socketGraphPosByKey(l.fromNode, l.fromSocket);
      const to = this.socketGraphPosByKey(l.toNode, l.toSocket);
      if (from && to) this.drawWire(this.graphToPx(from[0], from[1]), this.graphToPx(to[0], to[1]), 'rgba(200,200,200,0.7)');
    }
    if (this.wire) {
      const from = this.socketGraphPosByKey(this.wire.fromNode, this.wire.fromSocket);
      if (from) this.drawWire(this.graphToPx(from[0], from[1]), this.graphToPx(this.wire.to[0], this.wire.to[1]), this.accent);
    }
    if (this.flash) {
      this.drawWire(this.graphToPx(this.flash.from[0], this.flash.from[1]), this.graphToPx(this.flash.to[0], this.flash.to[1]), '#ff4040');
    }

    for (const node of graph.nodes) this.drawNode(node);
  }

  private drawDots(): void {
    const c = this.ctx2d;
    const step = 32 * this.zoom;
    if (step < 8) return;
    c.fillStyle = 'rgba(255,255,255,0.05)';
    const ox = ((this.panX % step) + step) % step;
    const oy = ((this.panY % step) + step) % step;
    for (let x = ox; x < this.cssW; x += step) {
      for (let y = oy; y < this.cssH; y += step) {
        c.fillRect(x, y, 1, 1);
      }
    }
  }

  private drawWire([x0, y0]: [number, number], [x1, y1]: [number, number], color: string): void {
    const c = this.ctx2d;
    const dx = Math.max(30, Math.abs(x1 - x0) * 0.5);
    c.beginPath();
    c.moveTo(x0, y0);
    c.bezierCurveTo(x0 + dx, y0, x1 - dx, y1, x1, y1);
    c.strokeStyle = color;
    c.lineWidth = 2;
    c.stroke();
  }

  private drawNode(node: GraphNode): void {
    const def = getNodeDef(node.type);
    if (!def) return;
    const c = this.ctx2d;
    const [x, y] = this.graphToPx(node.x, node.y);
    const w = NODE_W * this.zoom;
    const h = nodeBodyHeight(node) * this.zoom;
    const r = 6 * this.zoom;
    const selected = node.id === this.selectedNodeId;

    // Body.
    this.roundRect(x, y, w, h, r);
    c.fillStyle = 'rgba(48,48,48,0.96)';
    c.fill();
    c.lineWidth = selected ? 2 : 1;
    c.strokeStyle = selected ? this.accent : 'rgba(0,0,0,0.6)';
    c.stroke();

    // Title bar.
    this.roundRect(x, y, w, TITLE_H * this.zoom, r);
    c.fillStyle = node.type === 'principled' ? 'rgba(90,70,40,0.95)' : 'rgba(70,70,80,0.95)';
    c.fill();
    c.fillStyle = '#eaeaea';
    c.font = `${Math.round(11 * this.zoom)}px sans-serif`;
    c.textBaseline = 'middle';
    c.fillText(def.label, x + 8 * this.zoom, y + (TITLE_H / 2) * this.zoom);

    // Sockets.
    const drawSocket = (kind: 'in' | 'out', index: number, sock: { label: string; type: SocketType }): void => {
      const [gx, gy] = this.socketGraphPos(node, kind, index);
      const [sx, sy] = this.graphToPx(gx, gy);
      c.beginPath();
      c.arc(sx, sy, SOCKET_R * this.zoom, 0, Math.PI * 2);
      c.fillStyle = SOCKET_COLORS[sock.type];
      c.fill();
      c.lineWidth = 1;
      c.strokeStyle = 'rgba(0,0,0,0.7)';
      c.stroke();
      c.fillStyle = 'rgba(220,220,220,0.85)';
      c.font = `${Math.round(9 * this.zoom)}px sans-serif`;
      if (kind === 'in') {
        c.textAlign = 'left';
        c.fillText(sock.label, sx + 8 * this.zoom, sy);
      } else {
        c.textAlign = 'right';
        c.fillText(sock.label, sx - 8 * this.zoom, sy);
      }
      c.textAlign = 'left';
    };
    def.inputs.forEach((s, i) => drawSocket('in', i, s));
    def.outputs.forEach((s, i) => drawSocket('out', i, s));
    c.textBaseline = 'alphabetic';
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const c = this.ctx2d;
    const rr = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + rr, y);
    c.arcTo(x + w, y, x + w, y + h, rr);
    c.arcTo(x + w, y + h, x, y + h, rr);
    c.arcTo(x, y + h, x, y, rr);
    c.arcTo(x, y, x + w, y, rr);
    c.closePath();
  }
}

// --- Color helpers ----------------------------------------------------------

function clamp01(n: number): number { return Math.max(0, Math.min(1, n)); }

function rgbToHex(v: unknown): string {
  const arr = Array.isArray(v) && v.length >= 3 ? v : [1, 1, 1];
  const h = (n: number): string => Math.round(clamp01(Number(n)) * 255).toString(16).padStart(2, '0');
  return `#${h(arr[0])}${h(arr[1])}${h(arr[2])}`;
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [1, 1, 1];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
