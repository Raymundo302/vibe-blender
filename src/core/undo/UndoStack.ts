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

  constructor(private readonly limit = 64) {}

  push(cmd: Command): void {
    this.undoStack.push(cmd);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    this.pushes++;
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
  }

  /** Returns the undone command's name, or null if nothing to undo. */
  undo(): string | null {
    const cmd = this.undoStack.pop();
    if (!cmd) return null;
    cmd.undo();
    this.redoStack.push(cmd);
    return cmd.name;
  }

  redo(): string | null {
    const cmd = this.redoStack.pop();
    if (!cmd) return null;
    cmd.redo();
    this.undoStack.push(cmd);
    return cmd.name;
  }
}
