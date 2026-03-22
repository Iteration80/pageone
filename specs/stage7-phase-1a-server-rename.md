# Phase 1a — Server-Side Rename Surgery

*Part of Stage 7 Style implementation. Execute this FIRST before any frontend changes.*
*Parent spec: `specs/stage-7-style-handoff.md`*

---

## Goal

Renumber all server-side stage references: 7→8, 8→9, 9→10. Remove Stage 10 Polish. Rename agent and skill files. After this phase, the server is ready for a 10-stage pipeline but the frontend still shows the old numbering (that's Phase 1b).

## New Stage Order

| # | Stage | Was |
|---|-------|-----|
| 1-6 | Unchanged | — |
| 7 | Style | NEW (empty placeholder for now) |
| 8 | Draft | Was 7 |
| 9 | Coverage | Was 8 |
| 10 | Rewrite | Was 9 |

Old Stage 10 (Polish) is **deleted**.

---

## Critical Rule: Don't Rename Data Keys

Project JSON files store data as `stage1_pitch`, `stage2_outline`, `stage6_scenes`, `stage7_humanized`, `stage8_coverage`, `stage9_rewrites`, etc. **Do NOT rename these keys.** They're the permanent storage schema. Renaming them breaks every existing project.

The mismatch (data key `stage8_coverage` maps to "Stage 9 Coverage" in the UI) is an intentional internal detail.

**New data keys to add:**
- `stage7_style` — stores name/path of selected style for this project, or `"none"`
- `stage7_style_skipped` — boolean, `true` for imported projects that auto-skipped Style

---

## Files to Change

### 1. `server.js`

- **`stageNames` dictionary** (line ~754) — Add `7: "Style"`, shift Draft→8, Coverage→9, Rewrite→10. Remove Polish.
- **`priorStageNames` dictionary** (line ~787) — Same renumbering.
- **`getModelConfig()` function** (line ~49) — Add `stage7` entry. Shift existing 7→8, 8→9, 9→10.
- **API endpoint references** — Any endpoint that references stage numbers in comments or routing logic.
- **Export stage routing switch** (lines ~1409-1483) — Update case numbers. Add empty/placeholder case for Stage 7 Style export.
- **`/api/finalize-stage9`** — Rename endpoint to `/api/finalize-stage10`. Update all references.
- **Coverage loopback logic** (lines ~606-627) — Currently loops from Stage 8 Coverage back. Update to Stage 9 numbering.
- **`stampRevisedStage` logic in `PUT /api/projects/:id`** — Verify stage cascade numbering works with new 10-stage pipeline.
- **`/api/brainstorm-rewrite` init** — `characterChangeContext` detection currently targets Stage 9. Update to target Stage 10.
- **Chat persistence: prior-stage conversation injection** — The code loads `conversations.stageN` keys from project data. Since data keys don't change, the server-side mapping of "which prior stages to load for stage X" needs updating. Example: Stage 10 Rewrite should now load prior conversations that include the new stage count.

### 2. Rename Agent Files

| Current | New |
|---------|-----|
| `agents/agent_7_draft.js` | `agents/agent_8_draft.js` |
| `agents/agent_8_coverage.js` | `agents/agent_9_coverage.js` |
| `agents/agent_9_rewrite.js` | `agents/agent_10_rewrite.js` |

Update all `require()` / `import` references in `server.js` to point to new filenames.

### 3. Rename Skill Files

| Current | New |
|---------|-----|
| `skills/skill_stage7_draft.md` | `skills/skill_stage8_draft.md` |
| `skills/skill_stage8_coverage.md` | `skills/skill_stage9_coverage.md` |
| `skills/skill_stage9_planner.md` | `skills/skill_stage10_planner.md` |
| `skills/skill_stage9_rewrite.md` | `skills/skill_stage10_rewrite.md` |

Update all file path references in agent files and server.js that load these skill files (usually via `fs.readFileSync`).

### 4. `agents/export.js`

- Update function names and export routing to match new stage numbering.
- Add placeholder for Stage 7 Style export (may not need a dedicated export function — style is metadata, not prose).

### 5. `data/settings.json`

- Add `stage7` model config entry (default to same model as other stages).
- Renumber existing `stage7`→`stage8`, `stage8`→`stage9`, `stage9`→`stage10` entries.

### 6. `utils/stageMetadata.js`

- Check whether `stampRevised()` / `stampGenerated()` uses hardcoded stage numbers or derives them dynamically.
- If hardcoded, update the upper bound from 7 to 8 (Style is now part of the pre-draft pipeline, so staleness cascade should include it).

### 7. `skills/skill_brainstorm.md`

- Update any stage number references (e.g., "stages 1-7" → "stages 1-8").

---

## Files That DON'T Change

- `agents/agent_humanizer.js` — Still fires after Draft (now Stage 8). Check for hardcoded "Stage 7" string references and update if found, but the logic itself doesn't change.
- `agents/ai-client.js` — Generic provider logic, stage-agnostic.
- `skills/skill_humanizer.md` — No changes.
- `skills/skill_coverage_consolidator.md` — No changes.
- `skills/skill_meta_review.md` — No changes.
- Stages 1-6 agent and skill files — No changes.
- `utils/script-import.js` — Import logic is stage-agnostic at the server level (frontend target is Phase 1c).

---

## Verification

After completing all changes:

1. `node server.js` starts without errors
2. `GET /api/settings` returns stage7-stage10 model configs
3. All existing skill files are loadable at their new paths (no `ENOENT` errors)
4. Create a new project and verify stages 1-6 still work end-to-end
5. Verify `/api/brainstorm` endpoints still function for existing stages
6. Load an existing project — verify no data corruption (data keys unchanged)

---

*After this phase is verified, proceed to `stage7-phase-1b-frontend-rename.md`.*
