import { describe, it, expect } from 'vitest';
import { applyTextKey } from './textEdit';

describe('applyTextKey', () => {
  it('inserts a printable char at the caret', () => {
    expect(applyTextKey('ab', 2, 'c')).toEqual({ content: 'abc', caret: 3 });
    expect(applyTextKey('ac', 1, 'b')).toEqual({ content: 'abc', caret: 2 });
  });

  it('Backspace deletes before the caret; Delete deletes at it', () => {
    expect(applyTextKey('abc', 2, 'Backspace')).toEqual({ content: 'ac', caret: 1 });
    expect(applyTextKey('abc', 0, 'Backspace')).toEqual({ content: 'abc', caret: 0 });
    expect(applyTextKey('abc', 1, 'Delete')).toEqual({ content: 'ac', caret: 1 });
    expect(applyTextKey('abc', 3, 'Delete')).toEqual({ content: 'abc', caret: 3 });
  });

  it('Enter inserts a newline', () => {
    expect(applyTextKey('ab', 1, 'Enter')).toEqual({ content: 'a\nb', caret: 2 });
  });

  it('arrows move the caret within bounds', () => {
    expect(applyTextKey('abc', 1, 'ArrowLeft')).toEqual({ content: 'abc', caret: 0 });
    expect(applyTextKey('abc', 3, 'ArrowRight')).toEqual({ content: 'abc', caret: 3 });
    expect(applyTextKey('abc', 0, 'ArrowLeft')).toEqual({ content: 'abc', caret: 0 });
  });

  it('Up/Down move across lines keeping the column', () => {
    // "abc\ndef", caret at col 2 on line 1 (index 6, the 'f' position)
    expect(applyTextKey('abc\ndef', 6, 'ArrowUp')).toEqual({ content: 'abc\ndef', caret: 2 });
    expect(applyTextKey('abc\ndef', 2, 'ArrowDown')).toEqual({ content: 'abc\ndef', caret: 6 });
  });

  it('returns null for non-editing keys (F1, etc.)', () => {
    expect(applyTextKey('abc', 1, 'F1')).toBeNull();
    expect(applyTextKey('abc', 1, 'Shift')).toBeNull();
  });
});
