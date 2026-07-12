import { describe, it, expect } from 'vitest';
import { UndoStack, type Command } from './UndoStack';

/** A no-op command whose undo/redo do nothing — we only track positions. */
function noop(name = 'cmd'): Command {
  return { name, undo() {}, redo() {} };
}

describe('UndoStack.position (UR14-1 dirty tracking)', () => {
  it('starts at 0 and rises with each push', () => {
    const s = new UndoStack();
    expect(s.position).toBe(0);
    s.push(noop());
    const p1 = s.position;
    expect(p1).toBeGreaterThan(0);
    s.push(noop());
    expect(s.position).toBeGreaterThan(p1);
  });

  it('undo lowers position, redo restores the exact same value', () => {
    const s = new UndoStack();
    s.push(noop('a'));
    const afterA = s.position;
    s.push(noop('b'));
    const afterB = s.position;
    expect(afterB).not.toBe(afterA);

    s.undo();
    expect(s.position).toBe(afterA);
    s.redo();
    expect(s.position).toBe(afterB); // same id, not a fresh one
  });

  it('undoing everything returns position to 0', () => {
    const s = new UndoStack();
    s.push(noop());
    s.undo();
    expect(s.position).toBe(0);
  });

  it('a new push after undo yields a fresh (higher) position id', () => {
    const s = new UndoStack();
    s.push(noop('a'));
    const afterA = s.position;
    s.push(noop('b'));
    s.undo(); // back to afterA
    s.push(noop('c')); // diverges — redo of b is gone
    expect(s.position).not.toBe(afterA);
    expect(s.position).toBeGreaterThan(afterA);
  });

  it('clear resets position to 0', () => {
    const s = new UndoStack();
    s.push(noop());
    s.push(noop());
    s.clear();
    expect(s.position).toBe(0);
  });

  it('the limit shifting the bottom off does not corrupt the top position', () => {
    const s = new UndoStack(2); // tiny limit
    s.push(noop('a'));
    s.push(noop('b'));
    s.push(noop('c')); // 'a' is shifted off the bottom
    const top = s.position;
    // Save here, then edit + undo back — dirty compares against `top`.
    s.push(noop('d'));
    expect(s.position).not.toBe(top);
    s.undo();
    expect(s.position).toBe(top); // returns to the saved id exactly
  });
});
