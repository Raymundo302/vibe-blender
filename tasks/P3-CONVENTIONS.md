# P3 batch — shared conventions (read first, then your task spec)

`tasks/P1-CONVENTIONS.md` and `tasks/P2-CONVENTIONS.md` still apply in full
(escape hatch, file discipline, style, strict TS, undo patterns, commit protocol).
Phase 3 additions:

## e2e
Phase 3 checks go in NEW `e2e/ship.mjs` (create it in the first task that needs
it, using `runE2e` from `e2e/harness.mjs` like `e2e/edit.mjs` does). Keep
`node e2e/smoke.mjs` and `node e2e/edit.mjs` green too — run all three before
committing. Dev server already runs at http://localhost:5199 (never restart it);
CDP port 9222 means never two e2e runs at once.

## Topbar buttons
UI entry points for Phase 3 (save/load/import/export/help) are small chip
buttons on the RIGHT side of the topbar, before the status span. Add a
`topbar-btn` CSS class (once, first task to need it — model it on `topbar-chip`
with `cursor: pointer` and a hover state) and give each button a stable
`data-action` attribute (e.g. `data-action="export-obj"`) so e2e can click it.
`src/ui/topbar.ts` takes new constructor deps as needed — keep them explicit
(pass scene/undo/callbacks in, no globals).

## File downloads / uploads in e2e
Test download paths by intercepting: generate the file content via the same
exported function the button uses, and assert on the string (do NOT assert real
browser downloads). Test upload/import by calling the exported parse/apply
function through `window.__app` with a fixture string, then asserting scene
state. The DOM plumbing (anchor click, file input) stays thin and untested.

## Serialization stability
Scene JSON and OBJ output must be deterministic (stable key order, fixed number
formatting `toFixed(6)` trimmed, insertion-order iteration) so round-trip tests
can compare structurally. Never serialize live class instances — plain data only.
