# Post-Audit Fixes — Stage 7 Implementation Cleanup

*Created: 2026-03-22 — Cowork audit of codebase after Phase 1-3 implementation*
*Priority: Fix before further stage-by-stage testing*

---

## Bug 1: `utils/stageMetadata.js` — STAGE_ORDER array incomplete

**Problem:** `STAGE_ORDER` contains `stage7_draft` instead of `stage8_draft`, and is missing coverage and rewrite entries for the new numbering. Staleness cascade (amber dots in sidebar) won't work correctly for anything past Stage 7.

**Fix:** Update the `STAGE_ORDER` array to reflect the full 10-stage pipeline with correct data keys:
```js
// Data keys (NOT UI stage numbers — these are storage keys)
'stage7_style',    // UI Stage 7
'stage7_draft',    // UI Stage 8 (data key preserved per "don't rename" rule... BUT check if this was already renamed to stage8_draft)
'stage8_coverage', // UI Stage 9
'stage9_rewrites'  // UI Stage 10
```

**Important:** Cross-check whether Phase 1a renamed these in the array or left the original data keys. The data keys in project JSON files should NOT have been renamed, but the STAGE_ORDER array needs to reference whatever keys are actually used.

---

## Bug 2: `public/app.js` ~line 6342 — Settings modal STAGE_LABELS stale

**Problem:** There are TWO `STAGE_LABELS` definitions in app.js. The object-format one (~line 1220) is correct with all 10 stages. The array-format one (~line 6342, used by the settings modal) still shows 9 stages with old numbering (7=Draft, 8=Coverage, 9=Rewrite). Missing Stage 7=Style and Stage 10=Rewrite.

**Fix:** Update the array-format STAGE_LABELS near line 6342 to match:
```
Stage 1: Pitch, Stage 2: Outline, Stage 3: Characters, Stage 4: Beats, Stage 5: Treatment, Stage 6: Scenes, Stage 7: Style, Stage 8: Draft, Stage 9: Coverage, Stage 10: Rewrite
```

Also verify the settings modal rendering loop correctly iterates over all 10 entries and maps to the right `stageModels.stageN` keys in `data/settings.json`.

---

## Bug 3: `public/index.html` + `public/app.js` — Stage 3 re-approval button ID mismatch

**Problem:** In index.html, the button has `id="btn-regen-to-stage9"`. In app.js (~line 2371), the variable is named `btnRegenToStage10` but does `getElementById('btn-regen-to-stage9')`. The button label correctly says "Send to Stage 10 Rewrite" and `switchStage(10)` is correct. It works now, but it's fragile.

**Fix:**
- `index.html`: Change `id="btn-regen-to-stage9"` → `id="btn-regen-to-stage10"`
- `app.js`: Change `getElementById('btn-regen-to-stage9')` → `getElementById('btn-regen-to-stage10')`

---

## Bug 4: `server.js` — getModelConfig called with wrong stage numbers

**Problem:** Draft generation calls `getModelConfig(7)` instead of `getModelConfig(8)`. Rewrite calls `getModelConfig(9)` instead of `getModelConfig(10)`. This means the per-stage model selection in Settings doesn't map to the correct stages.

**Fix:** Search for all `getModelConfig()` calls and verify arguments match the NEW stage numbers:
- Style generation → `getModelConfig(7)`
- Draft generation → `getModelConfig(8)`
- Coverage generation → `getModelConfig(9)`
- Rewrite/planner → `getModelConfig(10)`

---

## Warning 5: `skills/skill_stage9_coverage.md` — Stale "Stage 9 Rewrite" references

**Problem:** Lines 8 and 102 say "Stage 9 Rewrite" — should be "Stage 10 Rewrite". The AI agent reads this SOP, so stale stage names could subtly affect how it frames coverage output.

**Fix:** Find and replace:
- "Stage 9 Rewrite" → "Stage 10 Rewrite"

---

## Warning 6: `skills/skill_stage10_rewrite.md` — Stale "Stage 8 Coverage" reference

**Problem:** Line 81 says "Stage 8 Coverage" — should be "Stage 9 Coverage".

**Fix:** Find and replace:
- "Stage 8 Coverage" → "Stage 9 Coverage"

---

## Warning 7: `app.js` ~line 6128 — Variable named `s9ToolbarSlot`

**Problem:** Variable is named `s9ToolbarSlot` but references `stage10-toolbar-slot`. Works fine, just confusing.

**Fix:** Rename variable to `s10ToolbarSlot` (and any other references to it).

---

## Warning 8: Console.log messages in `server.js` — Stale stage names

**Problem:** Several console.log messages around lines 686, 698 still say "Stage 8 Coverage" instead of "Stage 9 Coverage".

**Fix:** Search `server.js` for console.log strings containing "Stage 7", "Stage 8", "Stage 9" and verify they match new numbering. Specifically:
- "Stage 7" should only refer to Style
- "Stage 8" should only refer to Draft
- "Stage 9" should only refer to Coverage
- "Stage 10" should only refer to Rewrite

---

## Warning 9: `server.js` ~line 48 — Comment says stages 1-9

**Problem:** Comment says "stages 1-9" instead of "stages 1-10".

**Fix:** Update comment.

---

## Verification

After all fixes:
1. Open Settings → verify 10 stages listed with correct labels
2. Set a different model for Stage 8 (Draft) → generate a draft → verify the correct model is used (check console log)
3. Edit a character in Stage 3 → re-approve → verify modal button says "Stage 10" AND clicking it navigates to Stage 10
4. Edit Stage 2 → re-approve → verify stale dots appear on downstream stages
5. No console errors across full stage navigation
