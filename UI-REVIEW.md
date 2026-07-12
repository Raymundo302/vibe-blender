# UI Review — quality-of-life & interface theory (2026-07-11)

Reviewed from live screenshots of the current build (boot, object/edit mode,
shading dropdown, add menu, N panel, help overlay, properties, timeline).
Ordered by impact-per-effort within each group. Each item: the problem → the
proposal → rough size (S/M/L).

The three principles doing the most work here:
- **Progressive disclosure** — show what the current mode needs, tuck the rest.
- **Visibility of system status** — the app should always answer "what mode am
  I in, what can I press next?" without F1.
- **Recognition over recall** — labels and hints beat memorized shortcuts for
  everyone who isn't us.

## A. First-run & discoverability (highest leverage for "other people")
1. **Modal-key hint bar (the single biggest QoL win).** During any modal op,
   the status chip says the op name — but not the live options (axis locks,
   numeric input, G-cycle, Shift precision). Blender solves this with a
   status-bar keymap strip. Proposal: a persistent one-line bar along the
   viewport bottom that rewrites per context — idle object mode: "G move · R
   rotate · S scale · Shift+A add"; during Move: "X/Y/Z axis · Shift precise ·
   G slide · type number · Esc cancel". We already own every string. (M)
2. **Toolbar hover labels.** Icon-only glyph buttons (↖ ✥ ⟳ …) are a wall for
   a newcomer; browser-native `title` is slow and tiny. Proposal: styled
   instant tooltip (name + shortcut) after ~150 ms, same look as the shading
   dropdown rows. (S)
3. **Splash: add three doors.** The splash teaches 3 keys, good — but it's a
   dead end. Add: Open recent (autosave slot exists already) · Load demo scene
   (donut / fly-through via existing ?scene= links) · New empty. First-launch
   users get somewhere to GO. (S–M)
4. **Empty states that point forward.** "No active object" (properties) →
   "No active object — Shift+A adds one". Empty timeline → "Select an object
   and press I to key a pose". One-line copy changes, big recall savings. (S)

## B. Topbar: group by job (it currently reads as 14 unrelated pills)
5. **Cluster + separate.** Left→right today: workspace tabs, mode chip, Snap,
   X-ray, Overlays, Pivot, 2 unlabeled round toggles, Save/Open, Export/Import
   OBJ, Render, misc icons, help. Proposal: four visually separated clusters —
   [Workspace tabs] · [Mode + viewport toggles: Snap/X-ray/Overlays/Pivot] ·
   [File: Save/Open/Import/Export under ONE "File" menu button] · [Render] —
   right-aligned [theme/help]. Folding 4 file buttons into a File menu is the
   cheapest density win in the app. (M)
6. **The two unlabeled round toggles** (💡 / ●) are unguessable. Either label
   them in a cluster ("Lights", "Icons"?) or move them into Overlays where
   they conceptually live. (S)
7. **Buttons that wrap to two lines** ("Export OBJ") read broken. Fixed by 5's
   File menu; otherwise white-space: nowrap + tighter padding. (S)

## C. Panels: hierarchy & affordances
8. **Properties tab strip has no current-tab name.** The icon rail (16 px) is
   fine, but nothing says which tab you're on — the panel header always reads
   "Properties". Make the header read "Properties · Material" (or swap the
   generic header for the tab name). (S)
9. **Collapsible sections in Object/Material tabs** (Location/Rotation/Scale/
   Maps/…) — we proved the pattern in the shading dropdown (UR9-1). Persist
   collapsed state like shadePrefs.sections. Long tabs (Material with maps +
   nodes) need it most. (M)
10. **Outliner selected-row volume.** The full-width saturated orange bar is
    the loudest element in the app — louder than the viewport selection it
    mirrors. Calm it: accent border-left + tinted row instead of solid fill.
    Also: persistent type icons per row (we have kind glyphs), faint indent
    guides for parented chains, and the per-row eye/× visible on hover for
    every row, not just selected. (S–M)
11. **"+ New Collection"** as a permanently visible jumbo button spends prime
    vertical space on a rare action — collapse to a small + in the Outliner
    header row. (S)
12. **N-panel vertical text tabs** (Item/View) are ~12 px hit targets.
    Widen the tab strip and give them 24 px minimum touch area. (S)
13. **Panel-header glyph mystery meat**: `::` (drag) and `⋮` (menu) carry all
    area management. Keep them, but add the same instant tooltips as item 2,
    and consider showing the corner-drag affordance (a subtle corner tick,
    Blender-style) on area hover — the split/merge gesture is currently
    invisible knowledge. (S)

## D. Viewport affordances
14. **Axis gizmo / view cube.** There's no persistent orientation widget; the
    only orientation cues are the grid's red/green axis lines. A mini axis
    ball (click = snap to front/right/top, the views we don't even have
    hotkeys for — numpad 1/3/7 are also missing) fills a real navigation gap.
    (M, pairs with adding numpad view shortcuts)
15. **Camera/view breadcrumb.** When looking through a camera there's no
    persistent "Viewing: Camera — Numpad 0 to exit" indicator beyond the
    passepartout. One chip, top-left of viewport. Same slot can announce
    "Page Mode", "Curve Edit", etc. — one consistent place for "what mode am
    I in" instead of today's scattered chips. (S–M)
16. **Selected-object name in viewport.** Blender shows active object name
    bottom-left. We have the topbar's tiny "Cube — 1 ob…" (truncated). Give
    the info chip the full name + mode. (S)

## E. Feedback & safety
17. **Destructive-action toasts.** Outliner × deletes instantly and silently.
    Keep it instant (undo exists) but toast "Deleted Cube — Ctrl+Z restores".
    Same for Convert to Mesh and modifier Apply. (S)
18. **Dirty-state indicator.** No visual difference between saved/unsaved.
    A dot on the Save button (like editor tabs) driven by the undo stack's
    position vs last save. (S)
19. **Undo depth visibility.** Status shows "Undo: <name>" transiently; a
    hold-to-preview or Edit-menu style undo LIST is overkill for now, but at
    minimum keep the last toast 2× longer — it currently vanishes before you
    read it. (S)

## F. Small frictions noticed while driving
20. **Double-signifier in the shading radio rows** (bullet + icon) — drop the
    bullet, the icon + highlight already carry state. (S)
21. **Grey-on-grey label contrast** (section headers like "Location" ~#999 on
    #2b2b2b ≈ 4.2:1) is borderline at 11 px — nudge to #b8b8b8 or bump weight.
    Run the app's themes through the same check; the 90s themes especially. (S)
22. **Type scale is flat** — panel titles, section heads, and field labels are
    all ~11-12 px. Keep sizes (density is right for a pro tool) but
    differentiate with weight (600 titles / 500 sections / 400 labels) and
    letterspacing on ALL-CAPS eyebrows (VIEWPORT SHADING does this well —
    propagate that pattern). (S)
23. **fps + frame fields** sit far apart on the timeline header; interp/easing
    dropdowns show even with nothing keyed — gate them on a selection with
    keys (progressive disclosure again). (S)

## Suggested batches
- **UR14-1 "status & hints"**: items 1, 4, 15, 16, 17, 18 — the visibility-of-
  status batch; transforms the newcomer experience.
- **UR14-2 "topbar & outliner"**: items 5, 6, 7, 10, 11 — organization pass.
- **UR14-3 "panel polish"**: items 2, 8, 9, 12, 13, 20, 21, 22, 23.
- **UR14-4 "navigation"**: item 14 + numpad view shortcuts (1/3/7/9, Ctrl
  variants) — pairs naturally.
Keep each batch behind the usual adversarial verify; items 1 and 5 want
eyes-on screenshots at every state (the AO lesson applies to UI too).
