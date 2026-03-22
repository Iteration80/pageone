# Phase 3 — Thread Style into Draft + Rewrite

*Part of Stage 7 Style implementation. Execute AFTER Phase 2 (Style feature) is verified.*
*Parent spec: `specs/stage-7-style-handoff.md`*

---

## Goal

Connect the Style skill file generated in Stage 7 to the stages that consume it: Stage 8 (Draft) as primary consumer and Stage 10 (Rewrite) as secondary consumer. Stage 9 (Coverage) does NOT consume style — it's analytical.

After this phase, the full pipeline is complete: a user can set a writing style in Stage 7 and see it reflected in how scenes are drafted and rewritten.

## Prerequisite

Phase 2 is complete — Stage 7 generates and stores style files in `data/styles/`.

---

## Files to Change

### 1. `agents/agent_8_draft.js` (was `agent_7_draft.js`)

**What to add:**

The Draft agent already works one scene at a time. Before drafting each scene, it loads the scene outline (Stage 6), character profiles (Stage 3), and the humanizer skill.

Add: load the selected style skill file (if not `"none"`) and insert it into the system prompt.

**Implementation:**
- Accept a new parameter: `styleContent` (string, the full markdown content of the style file, or `null`)
- If `styleContent` is provided, prepend it to the system prompt with this header:

```
STYLE DIRECTIVES
The following directives describe the writing style for this project.
Treat them as primary craft instructions when making decisions about dialogue rhythm,
action detail, tonal register, pacing, and voice.

[style file content]
```

**Precedence order in the prompt:**
1. Scene outline (what happens) — highest priority
2. Style directives (how it's written)
3. Character profiles (who they are)
4. Humanizer skill (secondary safeguards) — lowest priority

The humanizer still fires after each scene draft as a secondary net. No change to humanizer behavior.

### 2. `agents/agent_10_rewrite.js` (was `agent_9_rewrite.js`)

**What to add:**

Same mechanism as Draft. The Rewrite agent rewrites individual scenes based on Coverage notes. It should maintain the style voice rather than defaulting to generic.

- Accept `styleContent` parameter
- Insert style directives into system prompt with the same header format
- Style is secondary to the rewrite instructions (the Coverage note is the primary directive)

**Precedence order for Rewrite:**
1. Rewrite plan / Coverage note (what to change) — highest priority
2. Style directives (maintain voice while rewriting)
3. Character profiles
4. Existing scene content (context)

### 3. `server.js` — Draft Endpoints

**Scene drafting endpoint(s):**
- Before calling `agent_8_draft`, read the project's `stage7_style` value
- If it's not `"none"` and not empty, load the style file from `data/styles/[slug].md`
- Pass the file content as `styleContent` to the agent
- If `"none"` or missing, pass `null` (agent behaves exactly as before — no style influence)

### 4. `server.js` — Rewrite Endpoints

**`/api/rewrite-single-scene` and `/api/plan-rewrite`:**
- Same pattern: read `stage7_style`, load file if set, pass to agent
- For the planner (`agent_10_planner`), style is context but NOT a rewrite instruction — the planner should know the style exists but not treat it as something to "fix"

### 5. `skills/skill_stage8_draft.md` (was `skill_stage7_draft.md`)

Add a note about style integration:
- "If STYLE DIRECTIVES are present in the system prompt, treat them as primary craft instructions for dialogue rhythm, action detail, tonal register, pacing, and voice. Apply them consistently across all scenes. If no style directives are present, use your default professional screenplay voice."

### 6. `skills/skill_stage10_rewrite.md` (was `skill_stage9_rewrite.md`)

Add a note:
- "If STYLE DIRECTIVES are present, maintain the established style voice when rewriting scenes. The rewrite should fix what Coverage identified while preserving the project's stylistic identity."

### 7. `skills/skill_stage10_planner.md` (was `skill_stage9_planner.md`)

Add context awareness:
- "The project may have a writing style set (visible as STYLE DIRECTIVES in the rewrite agent's context). When planning rewrites, do not treat the style itself as a problem to fix — it's an intentional choice. Only flag style-related issues if Coverage explicitly raised them."

---

## What Does NOT Consume Style

### Stage 9 Coverage (`agent_9_coverage.js`)

Coverage does NOT use style directives. Coverage is analytical — it evaluates whether the draft works structurally, dramatically, and technically, regardless of voice. The coverage agent may reference the style for context ("this was written in the Nancy Meyers style") but should NOT use it as a constraint or scoring criterion.

**No changes to `agent_9_coverage.js` or `skill_stage9_coverage.md`.**

### Stages 1-6

No style consumption. Stage 7 generates the style; Stage 8 is the first consumer.

### Humanizer

No changes. The humanizer fires after Draft (Stage 8) as a secondary net. It catches AI-isms regardless of style. The style and humanizer are complementary, not competing.

---

## Edge Cases

### No style selected
If `stage7_style === "none"` or is unset, the Draft and Rewrite agents behave exactly as they did before this feature. No style directives are injected. This is the default for existing projects.

### Style file deleted
If the style file referenced by a project has been deleted from `data/styles/`, handle gracefully:
- Log a warning
- Draft/Rewrite without style (fallback to no-style behavior)
- Show a notice in the UI: "The style '[name]' is no longer available. Drafting without style directives."

### Imported projects
If `stage7_style_skipped === true` and user later adds a style:
- Style applies to Stage 10 (Rewrite) only
- Stage 8 (Draft) scenes are the original imported text — they were not AI-drafted and should not be re-drafted with style
- The Rewrite agent will use the style when rewriting individual scenes

### Style changed mid-project
If user returns to Stage 7 and changes the style after some scenes are already drafted:
- The `style_version` field on each scene tracks which version it was drafted under (set in Phase 2)
- Draft agent should check: if a scene has `style_version` matching the current style version, skip. If mismatched, it's a candidate for re-drafting (user chooses in the re-draft modal from Phase 2).

---

## Verification

1. **Full pipeline with style:**
   - Create project → complete Stages 1-6 → set a style in Stage 7 → approve
   - Generate scenes in Stage 8 (Draft) → verify the writing reflects the style directives
   - Compare: create a second project with the same content but no style → Draft output should be noticeably different

2. **Rewrite with style:**
   - Run Coverage (Stage 9) on the styled draft
   - Execute rewrites in Stage 10 → verify rewritten scenes maintain the style voice
   - The rewrite should fix Coverage issues WITHOUT losing the style

3. **No style (backward compatibility):**
   - Open an existing project that was created before this feature
   - Verify Stage 8 Draft still works exactly as before
   - Verify Stage 10 Rewrite still works exactly as before
   - No errors about missing style files

4. **Coverage doesn't use style:**
   - Verify Coverage analysis is the same quality/approach regardless of whether a style is set
   - Coverage should not penalize or reward stylistic choices

5. **Imported project + late style addition:**
   - Import a script → skip to Coverage → complete some rewrites
   - Go back to Stage 7 → add a style
   - Rewrite another scene → verify it now uses the style
   - Verify previously rewritten scenes are unchanged

---

*This is the final phase. After verification, the Stage 7 Style feature is fully implemented.*
*The parent spec (`stage-7-style-handoff.md`) remains the design rationale reference.*
