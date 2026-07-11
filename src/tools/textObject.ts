import type { Scene, SceneObject } from '../core/scene/Scene';
import type { TextData } from '../core/scene/objectData';
import { buildTextMesh } from '../core/text/buildTextMesh';
import { assignTextMesh, textSignature } from '../core/undo/textCommands';

/**
 * Text-object runtime (UR8-2): turns a TextData payload into the object's mesh
 * via the UR8-1 engine, and a frame-loop driver that regenerates that mesh
 * whenever the payload changes (a keyed thickness animation re-extrudes cheaply
 * thanks to UR8-1's per-glyph geometry cache).
 *
 * buildTextMesh is canvas-bound, so this module is browser-only (imported by
 * main.ts, the add menu, and the properties tab — never by pure-core tests).
 */

/** Build a fresh EditableMesh for a text payload (maps TextData → engine opts). */
export function buildTextObjectMesh(t: TextData) {
  return buildTextMesh({
    text: t.content,
    font: t.font,
    size: t.size,
    thickness: t.thickness,
    style: t.style,
    faceColor: t.faceColor,
    outlineColor: t.outlineColor,
    align: t.align,
    wrap: t.wrap,
    wrapWidth: t.wrapWidth,
  });
}

/** Rebuild `obj`'s mesh from its text payload NOW (no-op for non-text). */
export function regenerateTextMesh(obj: SceneObject): void {
  if (obj.kind !== 'text' || !obj.text) return;
  assignTextMesh(obj, buildTextObjectMesh(obj.text));
}

/**
 * Regenerates each text object's mesh from its payload when the payload's
 * mesh-affecting signature changes. Ticked in the main frame loop (after the
 * animation sampler, so a keyed `text.thickness` re-extrudes the same frame it
 * is sampled). The signature key makes an idle tick free.
 */
export class TextDriver {
  private readonly sigs = new WeakMap<SceneObject, string>();

  constructor(private readonly scene: Scene) {}

  /** Regenerate any text object whose payload signature changed since last tick. */
  tick(): void {
    for (const obj of this.scene.objects) {
      if (obj.kind !== 'text' || !obj.text) continue;
      const sig = textSignature(obj.text);
      if (this.sigs.get(obj) === sig) continue;
      regenerateTextMesh(obj);
      this.sigs.set(obj, sig);
    }
  }

  /** Force-rebuild a specific object next tick (e.g. after a font finishes
   *  loading and its metrics changed). */
  invalidate(obj: SceneObject): void {
    this.sigs.delete(obj);
  }

  /** Synchronous rebuild of every dirty text mesh — same work as tick(), named
   *  for e2e/tests that need the mesh current without waiting for a RAF frame. */
  syncAll(): void {
    this.tick();
  }
}
