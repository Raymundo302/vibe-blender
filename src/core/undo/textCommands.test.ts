import { describe, it, expect } from 'vitest';
import { Scene } from '../scene/Scene';
import { UndoStack } from './UndoStack';
import { makeCube } from '../mesh/primitives';
import { cloneTextData, defaultTextData } from '../scene/objectData';
import {
  ConvertTextToMeshCommand,
  TextCommand,
  textSignature,
} from './textCommands';

describe('textSignature (regenerate dirty logic)', () => {
  it('is stable for identical payloads and changes on mesh-affecting edits', () => {
    const a = defaultTextData();
    const b = cloneTextData(a);
    expect(textSignature(a)).toBe(textSignature(b));

    b.content = 'Hi';
    expect(textSignature(b)).not.toBe(textSignature(a));

    const c = cloneTextData(a);
    c.thickness = 0.2;
    expect(textSignature(c)).not.toBe(textSignature(a));

    const d = cloneTextData(a);
    d.faceColor = [0, 1, 0];
    expect(textSignature(d)).not.toBe(textSignature(a)); // tints live in the mesh
  });
});

describe('TextCommand', () => {
  it('snapshots the whole payload and undo/redo restore it exactly', () => {
    const scene = new Scene();
    const obj = scene.addText('Text');
    const before = cloneTextData(obj.text!);

    const cmd = TextCommand.capture('Set Size', obj, (t) => { t.size = 1.5; t.style = 'both'; });
    expect(obj.text!.size).toBe(1.5);
    expect(obj.text!.style).toBe('both');

    cmd.undo();
    expect(obj.text).toEqual(before);
    cmd.redo();
    expect(obj.text!.size).toBe(1.5);
    expect(obj.text!.style).toBe('both');
  });
});

describe('ConvertTextToMeshCommand', () => {
  it('replaces the text object with a plain mesh in place, and undo restores it', () => {
    const scene = new Scene();
    const undo = new UndoStack();
    const text = scene.addText('Bouncy');
    text.mesh = makeCube(0.5); // stand-in for the generated glyph mesh
    scene.selectOnly(text.id);
    const id = text.id;
    const payload = cloneTextData(text.text!);
    const faceKeys = [...text.mesh.faces.keys()];

    const cmd = ConvertTextToMeshCommand.create(scene, text)!;
    expect(cmd).toBeTruthy();
    cmd.redo();
    undo.push(cmd);

    // Now a plain mesh at the SAME index/id, no text payload.
    const converted = scene.get(id)!;
    expect(converted.kind).toBe('mesh');
    expect(converted.text).toBeUndefined();
    expect([...converted.mesh.faces.keys()]).toEqual(faceKeys); // deep-copied mesh
    expect(scene.objects.indexOf(converted)).toBe(0);
    expect(scene.activeId).toBe(id); // selection kept by id survives the swap

    // Undo → the original text object is back, exactly.
    cmd.undo();
    const restored = scene.get(id)!;
    expect(restored.kind).toBe('text');
    expect(restored.text).toEqual(payload);
    expect(scene.objects.indexOf(restored)).toBe(0);

    cmd.redo();
    expect(scene.get(id)!.kind).toBe('mesh');
  });

  it('returns null for a non-text object', () => {
    const scene = new Scene();
    const cube = scene.add('Cube', makeCube(1));
    expect(ConvertTextToMeshCommand.create(scene, cube)).toBeNull();
  });
});
