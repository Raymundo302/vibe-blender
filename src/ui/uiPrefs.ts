/**
 * UR14-3 item 9 — tiny localStorage-backed UI-preferences store, currently the
 * home for collapsed/expanded state of the Properties panel's disclosure
 * sections (Location / Rotation / Scale / Web Page …). Mirrors the pattern of
 * shadePrefs / viewPrefs: read once, write on change, tolerate a corrupt or
 * absent blob by falling back to defaults.
 *
 * Kept deliberately generic (a flat string→boolean map keyed by a section id)
 * so future panels can reuse it without a schema change.
 */

const STORAGE_KEY = 'vibe-ui-prefs-v1';

interface UiPrefs {
  /** Section id → collapsed? (true = collapsed). Absent = expanded. */
  collapsed: Record<string, boolean>;
}

function load(): UiPrefs {
  const fallback: UiPrefs = { collapsed: {} };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<UiPrefs>;
    return { collapsed: parsed.collapsed && typeof parsed.collapsed === 'object' ? parsed.collapsed : {} };
  } catch {
    return fallback;
  }
}

const prefs = load();

function save(): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch { /* private mode / quota */ }
}

/** Is the section with this id collapsed? Defaults to expanded (false). */
export function isSectionCollapsed(id: string): boolean {
  return prefs.collapsed[id] === true;
}

/** Persist the collapsed state of a section. */
export function setSectionCollapsed(id: string, collapsed: boolean): void {
  if (collapsed) prefs.collapsed[id] = true;
  else delete prefs.collapsed[id];
  save();
}
