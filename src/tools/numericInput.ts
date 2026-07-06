/**
 * Shared numeric-entry buffer for modal operators (Blender behavior).
 *
 * While an operator is modal, typing builds a number that overrides the
 * pointer: digits and a single `.` append, a leading `-` toggles the sign,
 * Backspace deletes. An empty buffer means "no override" (pointer control),
 * signalled by `value === null`.
 */
export class NumericInput {
  private buffer = '';

  /** Returns true if the key was consumed. */
  handleKey(key: string): boolean {
    if (key === 'Backspace') {
      if (this.buffer.length === 0) return false;
      this.buffer = this.buffer.slice(0, -1);
      return true;
    }
    if (key === '-') {
      // Minus toggles the sign rather than only being valid at the front.
      this.buffer = this.buffer.startsWith('-') ? this.buffer.slice(1) : `-${this.buffer}`;
      return true;
    }
    if (key === '.') {
      // Only one decimal point; still consume duplicates so they don't leak.
      if (!this.buffer.includes('.')) this.buffer += '.';
      return true;
    }
    if (key.length === 1 && key >= '0' && key <= '9') {
      this.buffer += key;
      return true;
    }
    return false;
  }

  /** Parsed value, or null if empty/not a number (e.g. '', '-', '.'). */
  get value(): number | null {
    if (this.buffer === '') return null;
    const n = Number(this.buffer);
    return Number.isFinite(n) ? n : null;
  }

  /** Raw string for the status bar ('' when empty). */
  get text(): string {
    return this.buffer;
  }
}
