import type { SceneObject } from '../core/scene/Scene';
import { cloneTextData, type TextData } from '../core/scene/objectData';

/**
 * Text Edit mode (UR8-2 typing) — pressing Tab with a text object active starts
 * a typing session that edits `text.content` at a caret. There is NO in-viewport
 * caret in v1: the live-updating mesh plus a status chip is the feedback; the
 * caret index only controls WHERE edits land. All other viewport keys are
 * swallowed by the InputManager while a session is active (F1 must not fire),
 * and the whole session is ONE undo entry (payload captured at entry, pushed on
 * exit if the content changed).
 *
 * State is module-level and viewport-ish, exactly like pageModeState.
 */
export const textEditState: { session: TextEditSession | null } = { session: null };

/** True while a text object is being typed into. */
export function inTextEdit(): boolean {
  return textEditState.session !== null;
}

/**
 * Apply one key to a (content, caret) pair. Returns the new pair, or null when
 * the key is not an editing key (arrows that would leave the string, unknown
 * keys) — the caller still swallows it, it just doesn't mutate. Pure, so it is
 * unit-testable without a DOM.
 */
export function applyTextKey(
  content: string,
  caret: number,
  key: string,
): { content: string; caret: number } | null {
  const c = Math.max(0, Math.min(caret, content.length));
  switch (key) {
    case 'Enter':
      return { content: content.slice(0, c) + '\n' + content.slice(c), caret: c + 1 };
    case 'Backspace':
      if (c === 0) return { content, caret: 0 };
      return { content: content.slice(0, c - 1) + content.slice(c), caret: c - 1 };
    case 'Delete':
      if (c >= content.length) return { content, caret: c };
      return { content: content.slice(0, c) + content.slice(c + 1), caret: c };
    case 'ArrowLeft':
      return { content, caret: Math.max(0, c - 1) };
    case 'ArrowRight':
      return { content, caret: Math.min(content.length, c + 1) };
    case 'Home':
      return { content, caret: content.lastIndexOf('\n', c - 1) + 1 };
    case 'End': {
      const nl = content.indexOf('\n', c);
      return { content, caret: nl < 0 ? content.length : nl };
    }
    case 'ArrowUp':
      return { content, caret: moveLine(content, c, -1) };
    case 'ArrowDown':
      return { content, caret: moveLine(content, c, +1) };
    default:
      // A single printable character (letters, digits, space, punctuation).
      if (key.length === 1) {
        return { content: content.slice(0, c) + key + content.slice(c), caret: c + 1 };
      }
      return null;
  }
}

/** Move the caret up/down one visual line, keeping the column where possible. */
function moveLine(content: string, caret: number, dir: -1 | 1): number {
  const lineStart = content.lastIndexOf('\n', caret - 1) + 1;
  const col = caret - lineStart;
  if (dir < 0) {
    if (lineStart === 0) return caret; // already on the first line
    const prevStart = content.lastIndexOf('\n', lineStart - 2) + 1;
    const prevLen = lineStart - 1 - prevStart;
    return prevStart + Math.min(col, prevLen);
  }
  const lineEnd = content.indexOf('\n', caret);
  if (lineEnd < 0) return caret; // already on the last line
  const nextStart = lineEnd + 1;
  const nextEnd = content.indexOf('\n', nextStart);
  const nextLen = (nextEnd < 0 ? content.length : nextEnd) - nextStart;
  return nextStart + Math.min(col, nextLen);
}

/** One typing session on one text object. */
export class TextEditSession {
  caret: number;
  readonly payloadAtEntry: TextData;

  constructor(readonly object: SceneObject) {
    if (!object.text) throw new Error('TextEditSession: object has no text payload');
    this.payloadAtEntry = cloneTextData(object.text);
    this.caret = object.text.content.length; // start at the END of the string
  }

  private get content(): string {
    return this.object.text!.content;
  }

  /** Process one keydown; returns true if it edited the content. */
  handleKey(key: string): boolean {
    const next = applyTextKey(this.content, this.caret, key);
    if (!next) return false;
    const edited = next.content !== this.content;
    this.object.text!.content = next.content;
    this.caret = next.caret;
    return edited;
  }

  /** Did the content change since the session started? */
  changed(): boolean {
    return this.content !== this.payloadAtEntry.content;
  }
}
