# Phase 1b — Frontend Navigation & Stage Switching Rename

*Part of Stage 7 Style implementation. Execute AFTER Phase 1a (server rename) is verified.*
*Parent spec: `specs/stage-7-style-handoff.md`*

---

## Goal

Renumber all frontend stage references so the sidebar shows 10 stages, the user can navigate to all of them, and Stage 7 exists as a placeholder (the actual Style UI is Phase 2). After this phase, the app should boot cleanly and a user can click through all 10 stages.

## Prerequisite

Phase 1a is complete — server-side files are renamed and `server.js` uses the new stage numbering.

---

## Files to Change

### 1. `public/index.html`

**Sidebar navigation:**
- Update sidebar nav links: stage IDs, labels, badge numbers
- Add new Stage 7 "Style" nav entry between Scenes (6) and Draft (8)
- Renumber Draft→8, Coverage→9, Rewrite→10
- Remove Stage 10 Polish nav entry

**Workspace views:**
- Update all workspace `<main>` view IDs to match new numbering
- Delete the Stage 10 Polish workspace view entirely
- Add a new Stage 7 Style workspace view — for now, just a placeholder `<div>` with a message: "Style stage — coming soon." (Phase 2 builds the real UI)
- Renumber existing workspace view IDs: Draft `<main>` becomes stage 8, Coverage becomes stage 9, Rewrite becomes stage 10

**Modals:**
- Loopback modal: update ID and button text (references to "Stage 8 Coverage" become "Stage 9 Coverage", etc.)
- Post-rewrite completion modal: update references. Should now show:
  - "Export Finished Script" (generates .fountain/.pdf/.docx)
  - "Run Coverage on New Draft" (loops to Stage 9)

### 2. `public/app.js`

**Core navigation:**
- **`stageNames` dictionary** (line ~1132) — Add `7: "Style"`, shift Draft→8, Coverage→9, Rewrite→10. Remove Polish.
- **`switchStage()` cases** (lines ~1045-1087) — Add case for Stage 7. Renumber existing cases: Draft→8, Coverage→9, Rewrite→10.
- **Stage completion status logic** (line ~1016) — Update the stage-count check and completion detection for 10 stages. Stage 7 completion = style selected (or skipped for imported projects).
- **Navigation loop bounds** — If there's a "next stage" / "prev stage" loop, update bounds from 9 to 10.
- **Loopback modal button handlers** (lines ~4580-4599) — Update stage targets.
- **Version history `switch(stageNum)` cases** — Add case for Stage 7, renumber 7→8, 8→9, 9→10.

**Stage 7 placeholder init:**
- Add a minimal `initStage7()` function that just shows the placeholder view. Phase 2 replaces this with the real implementation.

### 3. `public/style.css`

- Add any CSS needed for the new Stage 7 workspace view (can be minimal for placeholder).
- Verify existing stage-specific styles use class names, not hardcoded stage numbers. If they use IDs like `#stage7-*`, those now belong to Style and Draft's IDs shift to `#stage8-*`.

---

## What NOT to Change in This Phase

These are handled in Phase 1c:
- Re-approval flow (Stage 3 modal targets, `showGenericRegenModal()`, stale indicators)
- Import flow (`importedProjectTarget`)
- FountainEditor toolbar slot DOM IDs
- Chat persistence key mapping

Leave them as-is for now — they'll still reference the old numbers but won't break navigation.

---

## Verification

After completing all changes:

1. App loads without console errors
2. Sidebar shows 10 stages in correct order: Pitch, Outline, Characters, Beats, Treatment, Scenes, **Style**, Draft, Coverage, Rewrite
3. Clicking each stage in the sidebar switches to the correct workspace view
4. Stage 7 (Style) shows placeholder content
5. Stage 8 (Draft) shows the former Draft workspace with all its functionality
6. Stage 9 (Coverage) shows the former Coverage workspace
7. Stage 10 (Rewrite) shows the former Rewrite workspace
8. Create a new project → navigate through stages 1-6 → verify Stage 7 placeholder appears → skip to Stage 8 Draft → verify it still generates scenes
9. Loopback modal from Stage 10 correctly offers "Run Coverage" (pointing to Stage 9)
10. Version history renders correctly for all stages

---

*After this phase is verified, proceed to `stage7-phase-1c-systems-rename.md`.*
