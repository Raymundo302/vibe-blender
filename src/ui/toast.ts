/**
 * Lightweight transient toasts (UR14-1, item 17/19). A shared, dependency-free
 * notifier for destructive-but-undoable actions — outliner delete, Convert to
 * Mesh, modifier Apply — that reads "Deleted Cube — Ctrl+Z restores" and fades.
 *
 * Reuses the app's chip/toast look (see theme.css .vb-toast*). The container is
 * `pointer-events: none` so toasts never intercept viewport/panel clicks; newest
 * appears at the bottom of a bottom-centred stack. Duration defaults to 4000 ms —
 * 2× the old transient-status feel (item 19: "keep the last toast 2× longer").
 */

const DEFAULT_DURATION_MS = 4000;

let container: HTMLElement | null = null;

function ensureContainer(): HTMLElement {
  if (container && container.isConnected) return container;
  const el = document.createElement('div');
  el.className = 'vb-toast-layer';
  document.body.appendChild(el);
  container = el;
  return el;
}

/**
 * Show a transient toast. Returns a dismiss() to remove it early (idempotent).
 * `durationMs` overrides the default; pass 0 for a sticky toast.
 */
export function showToast(message: string, durationMs = DEFAULT_DURATION_MS): () => void {
  const layer = ensureContainer();
  const el = document.createElement('div');
  el.className = 'vb-toast';
  el.textContent = message;
  layer.appendChild(el);

  // Enter transition on the next frame (class toggle so CSS drives the fade-in).
  requestAnimationFrame(() => el.classList.add('vb-toast-in'));

  let removed = false;
  const dismiss = (): void => {
    if (removed) return;
    removed = true;
    el.classList.remove('vb-toast-in');
    el.classList.add('vb-toast-out');
    // Remove after the fade-out; guard against double removal.
    window.setTimeout(() => el.remove(), 220);
  };

  if (durationMs > 0) window.setTimeout(dismiss, durationMs);
  return dismiss;
}
