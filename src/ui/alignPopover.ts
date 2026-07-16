import type { Scene, SceneObject } from '../core/scene/Scene';
import type { UndoStack } from '../core/undo/UndoStack';
import { Vec3 } from '../core/math/vec3';
import type { Mat4 } from '../core/math/mat4';
import { cloneCurveData, type CurveData } from '../core/scene/objectData';
import { CurveCommand } from '../core/undo/curveCommands';
import { matchCurveEnd, type CurveEnd, type MatchLevel } from '../core/nurbs/matching';
import './alignPopover.css';

/**
 * NB-B2 — the small "Align" dialog for G0..G3 curve-end continuity matching.
 * Object mode, exactly two curve objects selected, key Shift+M. The ACTIVE
 * object is the source that MOVES toward the other (Blender's active-is-modified
 * convention). The dialog picks the continuity level, which end of each curve to
 * join, then applies `matchCurveEnd` as ONE undo step.
 *
 * Coordinate frames: `matchCurveEnd` reads both payloads in a SINGLE frame, so
 * the target is first re-expressed in the source's local frame (M = worldₛ⁻¹ ·
 * wₜ). The result lands back in the source's local frame — exactly what its
 * payload stores — so the joined curves line up in the world.
 */

type EndChoice = 'start' | 'end' | 'auto';

export interface AlignPopoverOptions {
  parent: HTMLElement;
  /** Pointer position (parent-local CSS px). */
  x: number;
  y: number;
  scene: Scene;
  undo: UndoStack;
  /** The moving curve (active object). */
  src: SceneObject;
  /** The reference curve (the other selected object). */
  target: SceneObject;
  setStatus: (text: string) => void;
  onClose: () => void;
}

/** Apply a Mat4 to every position in a CurveData (control points + bezier
 *  handles), leaving weights/knots/topology intact. Used to re-express the
 *  target in the source's local frame. */
function transformCurveData(data: CurveData, m: Mat4): CurveData {
  const tp = (co: [number, number, number]): [number, number, number] => {
    const v = m.transformPoint(new Vec3(co[0], co[1], co[2]));
    return [v.x, v.y, v.z];
  };
  const out = cloneCurveData(data);
  for (const p of out.points) {
    p.co = tp(p.co);
    if (p.hl) p.hl = tp(p.hl);
    if (p.hr) p.hr = tp(p.hr);
  }
  return out;
}

export class AlignPopover {
  private readonly root: HTMLDivElement;
  private closed = false;
  private readonly levelSel: HTMLSelectElement;
  private readonly srcSel: HTMLSelectElement;
  private readonly tgtSel: HTMLSelectElement;

  constructor(private readonly opts: AlignPopoverOptions) {
    this.root = document.createElement('div');
    this.root.className = 'align-popover';

    this.heading('Align Curves (Gⁿ)');

    this.levelSel = this.row('Continuity', [
      ['0', 'G0 — position'],
      ['1', 'G1 — tangent'],
      ['2', 'G2 — curvature'],
      ['3', 'G3 — curvature rate'],
    ], 'align-level', '1');
    this.srcSel = this.row('Source end', [
      ['auto', 'Auto (nearest)'],
      ['start', 'Start'],
      ['end', 'End'],
    ], 'align-src', 'auto');
    this.tgtSel = this.row('Target end', [
      ['auto', 'Auto (nearest)'],
      ['start', 'Start'],
      ['end', 'End'],
    ], 'align-tgt', 'auto');

    const names = document.createElement('div');
    names.className = 'align-popover-names';
    names.textContent = `${opts.src.name} → ${opts.target.name}`;
    this.root.appendChild(names);

    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'align-popover-apply';
    apply.textContent = 'Apply';
    apply.addEventListener('click', () => this.apply());
    this.root.appendChild(apply);

    // Position at the pointer, then clamp inside the host.
    this.root.style.left = `${opts.x}px`;
    this.root.style.top = `${opts.y}px`;
    opts.parent.appendChild(this.root);
    const maxX = Math.max(0, opts.parent.clientWidth - this.root.offsetWidth);
    const maxY = Math.max(0, opts.parent.clientHeight - this.root.offsetHeight);
    this.root.style.left = `${Math.min(opts.x, maxX)}px`;
    this.root.style.top = `${Math.min(opts.y, maxY)}px`;

    opts.setStatus(`Align: ${opts.src.name} → ${opts.target.name} — pick continuity + ends, then Apply (Esc cancels)`);
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('pointerdown', this.onOutsidePointer, true);
  }

  private heading(text: string): void {
    const h = document.createElement('div');
    h.className = 'align-popover-heading';
    h.textContent = text;
    this.root.appendChild(h);
  }

  private row(label: string, options: [string, string][], cls: string, value: string): HTMLSelectElement {
    const row = document.createElement('div');
    row.className = 'align-popover-row';
    const lab = document.createElement('label');
    lab.textContent = label;
    const sel = document.createElement('select');
    sel.className = cls;
    for (const [v, text] of options) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = text;
      sel.appendChild(o);
    }
    sel.value = value;
    // Keep clicks inside the popover from bubbling to the outside-pointer close.
    sel.addEventListener('pointerdown', (e) => e.stopPropagation());
    row.appendChild(lab);
    row.appendChild(sel);
    this.root.appendChild(row);
    return sel;
  }

  /** World position of a curve object's start (co[0]) or end (co[last]). */
  private endWorld(obj: SceneObject, end: CurveEnd): Vec3 {
    const pts = obj.curve!.points;
    const co = end === 'start' ? pts[0].co : pts[pts.length - 1].co;
    return this.opts.scene.worldMatrix(obj).transformPoint(new Vec3(co[0], co[1], co[2]));
  }

  /** Resolve 'auto' choices to concrete ends by closest endpoint pair. */
  private resolveEnds(srcChoice: EndChoice, tgtChoice: EndChoice): { srcEnd: CurveEnd; tgtEnd: CurveEnd } {
    const ends: CurveEnd[] = ['start', 'end'];
    const dist = (s: CurveEnd, t: CurveEnd): number =>
      this.endWorld(this.opts.src, s).distanceTo(this.endWorld(this.opts.target, t));

    if (srcChoice !== 'auto' && tgtChoice !== 'auto') {
      return { srcEnd: srcChoice, tgtEnd: tgtChoice };
    }
    if (srcChoice !== 'auto') {
      // Target auto: nearest target end to the chosen source end.
      const tgtEnd = dist(srcChoice, 'start') <= dist(srcChoice, 'end') ? 'start' : 'end';
      return { srcEnd: srcChoice, tgtEnd };
    }
    if (tgtChoice !== 'auto') {
      const srcEnd = dist('start', tgtChoice) <= dist('end', tgtChoice) ? 'start' : 'end';
      return { srcEnd, tgtEnd: tgtChoice };
    }
    // Both auto: minimise over all four pairs.
    let best = { srcEnd: 'end' as CurveEnd, tgtEnd: 'start' as CurveEnd, d: Infinity };
    for (const s of ends) for (const tEnd of ends) {
      const d = dist(s, tEnd);
      if (d < best.d) best = { srcEnd: s, tgtEnd: tEnd, d };
    }
    return { srcEnd: best.srcEnd, tgtEnd: best.tgtEnd };
  }

  private apply(): void {
    const { scene, undo, src, target, setStatus } = this.opts;
    if (!src.curve || !target.curve) { this.close(); return; }
    const level = Number(this.levelSel.value) as MatchLevel;
    const { srcEnd, tgtEnd } = this.resolveEnds(this.srcSel.value as EndChoice, this.tgtSel.value as EndChoice);

    // Re-express the target in the source's local frame: M = worldₛ⁻¹ · wₜ.
    const m = scene.worldMatrix(src).invert().mul(scene.worldMatrix(target));
    const targetLocal = transformCurveData(target.curve, m);

    let result: CurveData;
    try {
      result = matchCurveEnd(src.curve, srcEnd, targetLocal, tgtEnd, level);
    } catch (err) {
      setStatus(`Align failed: ${err instanceof Error ? err.message : String(err)}`);
      this.close();
      return;
    }
    const cmd = CurveCommand.capture(`Align G${level}`, src, () => { src.curve = result; });
    undo.push(cmd);
    setStatus(`Aligned ${src.name} (${srcEnd}) → ${target.name} (${tgtEnd}) at G${level}`);
    this.close();
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); this.close(); }
  };

  private readonly onOutsidePointer = (e: PointerEvent): void => {
    if (!this.root.contains(e.target as Node)) this.close();
  };

  /** Idempotent teardown. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('pointerdown', this.onOutsidePointer, true);
    this.root.remove();
    this.opts.setStatus('');
    this.opts.onClose();
  }
}
