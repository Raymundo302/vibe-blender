import { describe, it, expect } from 'vitest';
import { layoutText } from './layout';

describe('layoutText', () => {
  it('lays words on one line when wrap is off', () => {
    const r = layoutText([1, 1, 1], { spaceWidth: 0.25 });
    expect(r.lineCount).toBe(1);
    expect(r.placements.map((p) => p.line)).toEqual([0, 0, 0]);
    expect(r.placements[0].xOffset).toBeCloseTo(0);
    expect(r.placements[1].xOffset).toBeCloseTo(1.25);
    expect(r.placements[2].xOffset).toBeCloseTo(2.5);
  });

  it('greedy-wraps at wrapWidth', () => {
    // 4 words of width 1, space 0.25, wrap at 2.5 → 2 per line.
    const r = layoutText([1, 1, 1, 1], { spaceWidth: 0.25, wrap: true, wrapWidth: 2.5 });
    expect(r.lineCount).toBe(2);
    expect(r.placements.map((p) => p.line)).toEqual([0, 0, 1, 1]);
  });

  it('center alignment centers a short line in the wrap box', () => {
    const r = layoutText([2], { spaceWidth: 0.25, wrap: true, wrapWidth: 6, align: 'center' });
    expect(r.placements[0].xOffset).toBeCloseTo((6 - 2) / 2);
  });

  it('right alignment pushes the line to the right edge', () => {
    const r = layoutText([2], { spaceWidth: 0.25, wrap: true, wrapWidth: 6, align: 'right' });
    expect(r.placements[0].xOffset).toBeCloseTo(6 - 2);
  });

  it('justify spreads gaps on non-last lines but not the last', () => {
    // Two lines of two words each (widths 1, space 0.25, wrap 2.25 → 2/line).
    const r = layoutText([1, 1, 1, 1], {
      spaceWidth: 0.25, wrap: true, wrapWidth: 3, align: 'justify',
    });
    expect(r.lineCount).toBe(2);
    const line0 = r.placements.filter((p) => p.line === 0);
    // Justified: second word ends at refWidth (3).
    expect(line0[1].xOffset + 1).toBeCloseTo(3, 6);
    const line1 = r.placements.filter((p) => p.line === 1);
    // Last line stays natural (word2 at 1.25, not stretched to 3).
    expect(line1[1].xOffset).toBeCloseTo(1.25, 6);
  });

  it('single-word justified lines stay left-aligned', () => {
    const r = layoutText([1, 5], { spaceWidth: 0.25, wrap: true, wrapWidth: 3, align: 'justify' });
    // Word 0 alone on line 0 (adding word1 width 5 overflows) → left at 0.
    expect(r.placements[0].xOffset).toBeCloseTo(0);
    expect(r.placements[0].line).toBe(0);
  });

  it('stacks lines downward by lineHeight', () => {
    const r = layoutText([1, 1], { spaceWidth: 0.25, wrap: true, wrapWidth: 1, lineHeight: 1.5 });
    expect(r.placements[0].y).toBeCloseTo(0);
    expect(r.placements[1].y).toBeCloseTo(-1.5);
    expect(r.height).toBeCloseTo(3);
  });
});
