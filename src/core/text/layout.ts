/**
 * Text layout (pure) — line breaking and horizontal alignment.
 *
 * Works purely on per-word advance widths (em units), so it is unit-testable
 * without a canvas. Coordinates are em; +x is right, lines stack downward with
 * y = -line * lineHeight (baseline of each line).
 */

export type Align = 'left' | 'center' | 'right' | 'justify';

export interface LayoutOpts {
  /** Space glyph advance between words (em). */
  spaceWidth: number;
  /** Enable greedy word wrap at wrapWidth. */
  wrap?: boolean;
  /** Wrap column (em). Also the reference width for right/center/justify. */
  wrapWidth?: number;
  align?: Align;
  /** Line advance (em). Default 1.25. */
  lineHeight?: number;
}

export interface WordPlacement {
  /** Index into the input advances array. */
  index: number;
  line: number;
  /** Left edge x of the word (em), after alignment. */
  xOffset: number;
  /** Baseline y of the word's line (em, downward negative). */
  y: number;
}

export interface LayoutResult {
  placements: WordPlacement[];
  /** Widest laid-out line (em). */
  width: number;
  /** Total block height (em) = lineCount * lineHeight. */
  height: number;
  lineCount: number;
  lineHeight: number;
}

/**
 * Lay out words given their advance widths (em).
 * @param advances per-word advance width (em).
 */
export function layoutText(advances: number[], opts: LayoutOpts): LayoutResult {
  const lineHeight = opts.lineHeight ?? 1.25;
  const align: Align = opts.align ?? 'left';
  const space = opts.spaceWidth;
  const wrap = !!opts.wrap;
  const wrapWidth = opts.wrapWidth ?? Infinity;

  // Group word indices into lines (greedy).
  const lines: number[][] = [];
  let cur: number[] = [];
  let curW = 0;
  for (let i = 0; i < advances.length; i++) {
    const w = advances[i];
    if (wrap && cur.length > 0 && curW + space + w > wrapWidth + 1e-9) {
      lines.push(cur);
      cur = [i];
      curW = w;
    } else {
      if (cur.length > 0) curW += space;
      curW += w;
      cur.push(i);
    }
  }
  if (cur.length > 0) lines.push(cur);
  if (lines.length === 0) {
    return { placements: [], width: 0, height: 0, lineCount: 0, lineHeight };
  }

  // Natural width of each line (advances + inter-word spaces).
  const lineWidth = (line: number[]): number => {
    let w = 0;
    for (let k = 0; k < line.length; k++) {
      w += advances[line[k]];
      if (k > 0) w += space;
    }
    return w;
  };

  const naturalWidths = lines.map(lineWidth);
  const maxNatural = Math.max(...naturalWidths);
  const refWidth = wrap && isFinite(wrapWidth) ? wrapWidth : maxNatural;

  const placements: WordPlacement[] = [];
  let widest = 0;

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const natural = naturalWidths[li];
    const y = -li * lineHeight;
    const isLast = li === lines.length - 1;

    let start = 0;          // left edge of the line
    let gap = space;        // inter-word gap (justify widens it)

    if (align === 'center') start = (refWidth - natural) / 2;
    else if (align === 'right') start = refWidth - natural;
    else if (align === 'justify') {
      // Distribute leftover into gaps for every line except the last;
      // single-word lines stay left-aligned.
      if (!isLast && line.length > 1) {
        const slack = refWidth - natural;
        gap = space + slack / (line.length - 1);
      }
    }

    let x = start;
    let lineRight = start;
    for (let k = 0; k < line.length; k++) {
      const wi = line[k];
      placements.push({ index: wi, line: li, xOffset: x, y });
      lineRight = x + advances[wi];
      x += advances[wi] + gap;
    }
    widest = Math.max(widest, lineRight - start);
  }

  return {
    placements,
    width: isFinite(refWidth) ? refWidth : widest,
    height: lines.length * lineHeight,
    lineCount: lines.length,
    lineHeight,
  };
}
