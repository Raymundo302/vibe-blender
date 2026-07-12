/**
 * Command-based undo (architecture decision A4).
 *
 * Convention: the operator has ALREADY applied its final state when the
 * command is pushed — push() stores, it does not execute. undo()/redo()
 * restore the before/after states the command captured.
 */
export interface Command {
  readonly name: string;
  undo(): void;
  redo(): void;
}

export class UndoStack {
  private readonly undoStack: Command[] = [];
  private readonly redoStack: Command[] = [];
  private pushes = 0;
  // Monotonic id stamped on each pushed command (never reused, never decremented).
  private seq = 0;
  // seq id of every command still on the undo stack, parallel to undoStack. Used
  // by position(): the top entry uniquely identifies the current stack state even
  // as the bottom is shifted off at the limit (UR14-1 dirty-state tracking).
  private readonly seqs: number[] = [];

  constructor(private readonly limit = 64) {}

  push(cmd: Command): void {
    this.undoStack.push(cmd);
    this.seqs.push(++this.seq);
    if (this.undoStack.length > this.limit) { this.undoStack.shift(); this.seqs.shift(); }
    this.redoStack.length = 0;
    this.redoSeqs.length = 0;
    this.pushes++;
  }

  /**
   * A value uniquely identifying the current undo position (UR14-1). It is the
   * seq id of the command on top of the undo stack, or 0 when the stack is empty.
   * undo() lowers it (top is now an older command), redo() raises it back, so
   * comparing position() against a saved snapshot detects unsaved edits robustly
   * — even after the limit shifts the oldest command off the bottom.
   */
  get position(): number {
    return this.seqs.length ? this.seqs[this.seqs.length - 1] : 0;
  }

  /**
   * READ-ONLY inspection (added for P15-3 auto-key). `pushCount` increments
   * ONLY on push (never on undo/redo), so a poller can detect "a new command
   * was committed" without being fooled by undo revealing an older command.
   * `peek()` returns the top command so the poller can see what kind it is.
   */
  get pushCount(): number {
    return this.pushes;
  }

  peek(): Command | null {
    return this.undoStack.length ? this.undoStack[this.undoStack.length - 1] : null;
  }

  /** Drop all history — for destructive context switches like loading a scene. */
  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.seqs.length = 0;
    this.redoSeqs.length = 0;
  }

  // seq ids of commands sitting on the redo stack, parallel to redoStack, so
  // redo() can restore the exact position id undo() lowered us from.
  private readonly redoSeqs: number[] = [];

  /** Returns the undone command's name, or null if nothing to undo. */
  undo(): string | null {
    const cmd = this.undoStack.pop();
    if (!cmd) return null;
    this.redoSeqs.push(this.seqs.pop()!);
    cmd.undo();
    this.redoStack.push(cmd);
    return cmd.name;
  }

  redo(): string | null {
    const cmd = this.redoStack.pop();
    if (!cmd) return null;
    this.seqs.push(this.redoSeqs.pop()!);
    cmd.redo();
    this.undoStack.push(cmd);
    return cmd.name;
  }
}
