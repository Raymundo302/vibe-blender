# Vibe Coded Blender

## Project Goal
Build a Blender-style 3D modeling app from scratch, documented as a YouTube video ("can AI recreate Blender?"). The interesting deliverable is both the app AND the story of how it was built with AI orchestration.

## Orchestration Strategy (decided 2026-07-02)
- **Fable 5 (main session)** = architect + project manager. Keeps for itself: overall architecture, core mesh data structure, undo/redo system, viewport/camera math, integration review — anything where a wrong early decision poisons downstream work.
- **Opus subagents** = implementation workers for well-specified subtasks: UI panels, individual modeling tools (once the tool interface exists), importers/exporters, shortcut handling. Spawn via Agent tool with `model: "opus"`. Opus is half Fable's token price; workers burn ~95% of tokens, so this is where the savings are.
- **Sequencing rule:** Fable designs/builds core interfaces FIRST, then writes subtask specs referencing real existing code (not imagined shapes). Specs include: exact file paths, interfaces to conform to, out-of-scope list, acceptance criteria the worker can self-check.
- **Worker escape hatch:** every subagent prompt includes "if the spec is ambiguous or wrong, stop and report rather than improvising."
- **Verify loop:** Workflow tool per phase — implement batch → verify each against acceptance criteria → collect failures → re-dispatch fixes. Fable reads results between phases and decides the next workflow. Run mechanical stages at low effort, verify/review at high effort.

## State Management
- Task registry lives IN THIS REPO (human decision: git is the source of truth, not Notion). Use `PLAN.md` / `tasks/` with per-module status: pending / built / verified / failed. Every subagent marks its own completion; verify passes update statuses.
- Any session can read the state and know what's next — this is what makes the build resumable.

## Safe-Stop / Credit Exhaustion Plan
- No built-in pause/resume on usage limits. Approximation:
  1. Workflow runs journal completed agent calls → `resumeFromRunId` replays finished work from cache at zero cost after an interruption.
  2. Budget-cap each workflow phase (`budget.remaining()`) so phases end cleanly with state written, instead of dying mid-task.
  3. Optional: scheduled job (/schedule or /loop) fires every few hours with "read task state, continue the build" — runs during exhausted limits just fail; first run after reset resumes from disk state.

## Notion (human notes only — NOT project state)
- Notion MCP server connected at user scope (authenticated 2026-07-02).
- At natural checkpoints (phase complete, blocker hit), write a short plain-language update to the user's Notion project notes: where the build stands, decisions made and why, anything waiting on his input.
- Never put operational state (task statuses, specs) in Notion.

## Safety Note
User runs bypass-permissions mode. Keep ALL work inside this directory; verify stages should check for out-of-scope file changes.

## Tech Stack (decided 2026-07-02)
- **TypeScript + raw WebGL2, no engine** (no Three.js). Rationale: "from scratch" credibility for the video narrative, fast refresh-the-browser iteration for parallel Opus workers, demoable via a link in the video description. We hand-write the math library, shaders, camera/projection, and mesh system.

## Avatar → separate project (moved 2026-07-02)
- Fable's avatar (cyborg fox, 25-expression library, talk cycle, performance pipeline plans) is now its own project: **`~/Fable Fox/`** — see that folder's CLAUDE.md for all character/PixelLab details.
- This video USES the avatar; it doesn't own it. Reference assets from `~/Fable Fox/expressions/` and `~/Fable Fox/animations/`.
- Avatar process log lives in its own Notion page: "Building my AI avatar".

## Video Production (planning in Notion)
- The video plan (structure, entertainment strategy, how to present Fable as a character) lives in the Notion page **"Vibe Coding Blender"** — this is a human-notes doc, not operational state.
- Creative direction: entertaining first, but grounded in real math — teach how 3D software works "at the moment of need" (each concept introduced when it fixes a visible bug or unlocks a feature), not as lectures.

## Status
- [x] Strategy decided, folder + git repo created
- [x] Tech stack decision — TypeScript + raw WebGL2, no engine (2026-07-02)
- [x] Video plan drafted in Notion ("Vibe Coding Blender") — avatar decided, built, split into ~/Fable Fox (2026-07-02)
- [x] Architect/worker workflow validated on the Fable Fox pixel optimizer — 6 spec→implement→verify Opus increments, zero deviations (2026-07-02)
- [x] Game plan generated — architecture decisions (modal operators, BMesh-lite, color-ID picking, snapshot undo, DOM panels, matcap), module map, 4-phase task registry in PLAN.md (2026-07-05)
- [x] Phase 0 core built & verified — viewport with grid/axes, matcap cube, orbit/pan/zoom, click-select with orange outline, modal G-translate with axis locks, undo/redo. 18 unit tests + 12-check headless e2e (`node e2e/smoke.mjs`). Run with `npm run dev`. (2026-07-05)
- [x] Phase 1 object mode built & verified — 5 primitives + PRIMITIVES registry, R/S modal operators (axis locks, numeric input), translate gizmo (picking-based handles), outliner, properties panel (editable transform, euler↔quat), Shift-A/Shift-D/X, header bar + Blender-dark theme. Workflow `p1-object-mode`: 7× Opus implement → adversarial verify; 1 fix round (P1-4 sidebar shrank canvas → floated panel). 55 unit tests, 12/12 e2e. (2026-07-05)
- [x] Phase 2 edit mode built & verified — Tab/1-2-3 edit-mode core + cage overlay (Fable), element picking, G/R/S on elements, extrude, inset, delete/merge menu, box select + invert (Opus workflow `p2-edit-mode`, 6/6 verified, 0 fix rounds), loop cut with quad-strip walk + yellow preview (Fable). 107 unit tests, full `e2e/edit.mjs` suite. (2026-07-05)
- [x] Phase 3 shipped — scene save/load (versioned JSON, Ctrl+S/O), OBJ import/export, Z-cycled shading (matcap/wireframe/studio), splash + F1 shortcut overlay (Opus workflow `p3-ship-demo`, 4/4 verified, 0 fix rounds). Deployed by Fable to **https://raymundo302.github.io/vibe-blender/** (repo: github.com/Raymundo302/vibe-blender, Pages from gh-pages; re-deploy = `npm run build` + force-push dist to gh-pages). 126 unit tests, 3 e2e suites. (2026-07-05)
- [ ] **BUILD COMPLETE.** Remaining work is video production (script, capture, edit) — plan lives in Notion "Vibe Coding Blender". Possible app follow-ups if the video needs them: bevel, subdivision surface, materials, edge slide after loop cut.
