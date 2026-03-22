# PageOne — Stage 7 "Style" Implementation Handoff

*Created: 2026-03-21 — Carsten + Claude brainstorm session*
*Status: Planning complete, ready to implement*

---

## Context

Stage 9 (Rewrite) is now complete. The original Stage 10 (Polish) was supposed to apply a "voice" or style to the finished script — but that means running another full pass of 80+ API calls to retrofit style onto an already-drafted screenplay. That's expensive, inefficient, and architecturally backwards. Style isn't a coat of paint — it belongs in the bones of how scenes are written.

**Decision:** Remove Stage 10 Polish entirely. Insert a new Stage 7 (Style) between the current Stage 6 (Scenes) and Stage 7 (Draft). Renumber everything downstream.

---

## New Stage Order

| # | Stage | Change |
|---|-------|--------|
| 1 | Pitch | No change |
| 2 | Outline | No change |
| 3 | Characters | No change |
| 4 | Beats | No change |
| 5 | Treatment | No change |
| 6 | Scenes | No change |
| **7** | **Style** | **NEW — insert here** |
| 8 | Draft | Was Stage 7 |
| 9 | Coverage | Was Stage 8 |
| 10 | Rewrite | Was Stage 9 |

Old Stage 10 (Polish) is deleted.

---

## Stage 7 Style — Design Spec

### What the User Sees

When the user enters Stage 7, they see a **chat panel** with a "Quick Start" option:

**Chat-first:** "Tell me about the writing style you want for this screenplay. Reference specific directors, films, writers, or describe the vibe in your own words."

**Quick Start:** For users who want structured input, a form is available with:
- Style name field
- Tonal sliders (Warm ←→ Dry, Restrained ←→ Operatic, Grounded ←→ Stylized)
- Key characteristics (multi-select: "Minimal dialogue," "Rich action lines," "Fast-paced," etc.)
- Reference film/director autocomplete
- File upload for samples (optional)

Both paths lead to the same style generation. The chat path is primary; the form is a fallback for users who prefer structure.

### Style Creation Workflow

1. **Chat path:**
   - User describes style ("Nancy Meyers but darker," "Coen Brothers deadpan," etc.)
   - Agent asks clarifying questions if needed (dialogue style, pace, tone, etc.)
   - Agent offers a "refine on the form" option before generating
   - Agent generates style file and shows preview scene

2. **Form path:**
   - User fills out structured inputs (name, sliders, references, optional samples)
   - Agent generates style file and shows preview scene

3. **Preview:** An example scene from the current project is drafted using the new style for gut-check
4. **Approval:** User approves the style card, which shows name + tonal summary
5. **Selection:** Style is saved and selected for this project

### Style References

Users can specify style by:
- **Director/writer name** (with autocomplete from a curated reference database)
- **Film title** (autocomplete suggests director + film description)
- **Free text** (agent does its best to interpret)
- **Uploaded writing samples** (agent analyzes .txt, .pdf, or .fountain files)

The agent prioritizes uploaded samples over references (if both are provided, samples are primary).

### Binary Mode + Gradient via References

Style is on or off (no intensity dial). However, the reference selection allows subtle gradation: "80% Nancy Meyers, 20% Kelly Reichardt" gives the agent directional guidance toward a specific blend. The agent then generates a single unified style file that captures the blend.

When style is "on," the skill file is written to be tasteful by default — influence without takeover.

### Style Files — Storage & Scope

Style skill files live in a **shared location** outside per-project data:

```
/data/styles/
  nancy-meyers.md
  nancy-meyers.meta.json
  my-voice.md
  coen-brothers.md
```

Each style file includes **YAML front matter** with metadata (creation date, references, tonal summary, preview scene index):

```markdown
---
name: "Nancy Meyers"
created: "2026-03-22"
references: ["Nancy Meyers", "Something's Gotta Give"]
tonal_summary: "Warm, grounded, dialogue-forward"
preview_scene: "stage6_scenes[0]"
word_count: 520
---

# Style: Nancy Meyers
[skill file content]
```

Each project's JSON stores only the name/path of the selected style — not the content. This means:
- Styles are available across ALL projects (create once, use everywhere)
- The user doesn't recreate a style for each new screenplay
- Styles can be edited, deleted, or regenerated independently
- UI displays style name + tonal summary from metadata

---

## What the Style Agent Should Extract

The style skill file is NOT a literary analysis essay. It's **actionable craft directives** for the Draft agent — 400-600 words max, structured as instructions.

### Data to Extract from Uploaded Samples

1. **Scene construction patterns** — How do scenes typically open and close? What's the default rhythm? (e.g., "Scenes tend to open mid-action, rarely with establishing shots. Endings favor emotional beats over plot resolution.")

2. **Action line style** — Sparse or lush? What details get described? What gets omitted? Tense/voice conventions? (e.g., "Action lines are warm and specific to the physical space — what characters are touching, holding, cooking. Rarely describes camera movement. Short paragraphs, 1-2 sentences max.")

3. **Dialogue fingerprint** — Sentence length patterns, subtext habits, how characters interrupt (or don't), humor style, verbal tics. (e.g., "Dialogue overlaps with domestic tasks. Characters say the opposite of what they mean. Humor comes from vulnerability disguised as competence.")

4. **Tonal register** — Where on the spectrum from dry to warm, restrained to operatic. (e.g., "Warm but never sentimental. Earned emotion, not manufactured.")

5. **Signature moves** — The 2-3 things this writer does that nobody else does. (e.g., "Extended kitchen scenes where the real conversation happens. Characters who are competent at their jobs. Architecture and interior design as character expression.")

6. **What they avoid** — Equally important. What's absent from their work? (e.g., "No graphic violence. No cynicism. No characters who are purely villainous. No exposition dumps.")

### Example Output (Nancy Meyers Style Skill File)

```markdown
# Style: Nancy Meyers

## Scene Construction
- Open scenes mid-moment, usually with a character already doing something physical
- Favor domestic spaces as primary locations — kitchens, living rooms, offices
- End scenes on a small emotional shift, not a plot twist
- Let scenes breathe — don't rush to the next beat

## Action Lines
- Warm, specific, grounded in physical detail
- Notice what characters are wearing, holding, cooking, arranging
- Short paragraphs (1-2 sentences)
- Never describe camera angles — stay in the world
- Interior spaces are described with care (architecture, light, texture)

## Dialogue
- Overlaps with physical activity (talking while cooking, packing, working)
- Characters are articulate but deflect emotion with humor
- Banter is affectionate, not combative
- Subtext > text — what's unsaid matters more than what's said
- Vulnerability gets disguised as competence or irritation

## Tone
- Warm but never saccharine
- Optimistic without being naive
- Humor comes from recognition, not absurdity
- Emotional moments are earned through accumulation, not manufactured through plot

## Signature Moves
- Extended two-person scenes in kitchens
- Characters who are very good at what they do
- Physical spaces that reflect inner lives
- The "small, true thing" — a detail or gesture that carries emotional weight

## Avoid
- Graphic violence or cruelty
- Pure villains — antagonists have understandable motivations
- Cynicism or nihilism
- Exposition dumps or characters explaining the plot to each other
- Rushed pacing — let moments land
```

---

## How Style Threads into Downstream Stages

### Stage 8 (Draft) — Primary Consumer

The Draft agent already works one scene at a time (prompt chaining). Before drafting each scene, it currently loads:
- The scene outline (from Stage 6)
- Character profiles (from Stage 3)
- The humanizer skill

**Addition:** Also load the selected style skill file (if not "None"). Insert it into the system prompt with a clear header:

```
STYLE DIRECTIVES
The following directives describe the writing style for this project.
Treat them as primary craft instructions when making decisions about dialogue rhythm,
action detail, tonal register, pacing, and voice.

# Style: [name]
[style file content]
```

**Precedence order:** Scene outline (what happens) > Style (how it's written) > Character profiles (who they are) > Humanizer (secondary safeguards)

The humanizer still fires after each scene draft as a secondary net.

**Risk assessment:** Low. The Draft agent handles one scene at a time, and the style skill file is compact (400-600 words). Adding it to the context is like adding one more skill file — the agent already works with multiple. The key is that the style file reads as *instructions* not *analysis*, so the LLM executes rather than ruminates.

### Stage 9 (Coverage) — Context Only

Coverage agent does NOT use style directives. Coverage is analytical — it evaluates whether the draft works, regardless of voice. The agent may reference the style for context ("this was written in the Nancy Meyers style") but should not use it as a constraint on its analysis.

### Stage 10 (Rewrite) — Secondary Consumer

The Rewrite agent needs access to the style skill file. When rewriting scenes based on Coverage notes, it should maintain the style voice rather than defaulting back to generic. Same mechanism: load the style file into the system prompt before each scene rewrite.

### Stages 1-7 (Pre-Draft)

Stages 1-6 do not need the style file. Stage 7 generates the style file itself and does not consume it. The file is first consumed in Stage 8.

---

## Imported Scripts — Graceful Handling

PageOne now supports importing existing screenplays (`.fountain`, `.fdx`, `.pdf`), which bypass Stages 1-7 and jump straight to Stage 9 (Coverage).

**For imported projects:**
- Stage 7 shows as **"skipped"** (not "incomplete," not a blocker)
- `stage7_style` is auto-set to `"none"`
- User can still click Stage 7 to **add a style** if they want it for Stage 10 (Rewrite) context
- If user adds a style after import, it applies to Stage 10 forward (does NOT re-draft the imported scenes)

**UI text when Stage 7 is clicked in an imported project:**
> "This imported script went straight to Coverage. You can set a writing style now if you'd like to guide future rewrites, but it won't affect the existing draft."

**Project JSON for imported scripts:**
```json
{
  "projectId": "...",
  "isImported": true,
  "importedScriptPath": "path/to/imported.fountain",
  "stage7_style": "none",
  "stage7_skipped": true,
  ...
}
```

---

## Stage 6 → Stage 7 Handoff: Scene Context

Stage 7 can optionally read the Stage 6 scene summaries to generate a **style suggestion** based on story context:

1. User enters Stage 7
2. Agent analyzes Stage 6 scenes and generates a style recommendation: "Based on your story [summary], I suggest a [sparse, intimate, dialogue-forward] approach."
3. User can accept the suggestion (chat seeded with recommendation) or ignore it (fresh chat)
4. User can also upload samples or name references directly (these override the suggestion)

This is opt-in; the user is never forced to accept the suggestion. If they do, they have a faster starting point.

---

## Post-Rewrite Completion Flow (Updated)

Currently after Stage 10 Rewrite approval, a modal shows:
- "Run Stage 9 Coverage on New Draft"
- "Proceed to Stage 10 Polish →"

**After this update, the modal should show:**
- **"Export Finished Script"** — Generates the final .fountain / .pdf / .docx
- **"Run Coverage on New Draft"** — Loops back to Stage 9 Coverage

---

## Style Editing After Stage 8 (Draft) Has Started

Users can return to Stage 7 from Stage 8 (or later) to **change or refine the style**. When they do:

1. Stage 7 re-opens showing the current style selection
2. User can "Refine current style" (tweaks using chat or form) or "Switch to a different style"
3. After change, user is presented with three options:
   - **Re-draft all scenes:** All scenes 1–N are re-drafted with the new style (expensive, API-heavy)
   - **Apply to new scenes only:** Previously drafted scenes stay; only future scenes use the new style
   - **Keep current draft:** Style file is updated, but scenes are not re-drafted (good for Coverage/Rewrite context, not for existing draft)

**Data tracking:**
Add a `style_version` field to each scene in `stage8_draft`:
```json
{
  "stage8_draft": [
    { "scene": 1, "style_version": 1, "content": "...", "locked": true },
    { "scene": 2, "style_version": 1, "content": "...", "locked": true },
    { "scene": 3, "style_version": 2, "content": "...", "locked": true }
  ]
}
```

This allows the Coverage and Rewrite agents to know which style version each scene was written under (helpful for context).

---

## Files That Need to Change

### Phase 1 — Rename Surgery (Mechanical)

Renumber stages 7→8, 8→9, 9→10. Remove Stage 10 Polish.

| File | What Changes |
|------|-------------|
| `public/index.html` | Sidebar nav links (stage IDs, labels, badge numbers). Workspace `<main>` view IDs. Loopback modal ID + button text. Delete Stage 10 Polish workspace view. Add new Stage 7 Style workspace view. Stage 3 re-approval modal ("Send to Stage 9 Rewrite" → "Send to Stage 10 Rewrite"). Universal regen modal (`showGenericRegenModal()`) stage references. Stale-stage banner text. DOM IDs: `#stage7-sticky-header` → `#stage8-sticky-header`, `#stage9-toolbar-slot` → `#stage10-toolbar-slot`. |
| `public/app.js` | `stageNames` dictionary (line ~1132). `switchStage()` cases (lines ~1045-1087). Stage completion status logic (line ~1016). Navigation loop bounds. Loopback modal button handlers (lines ~4580-4599). Version history `switch(stageNum)` cases. **Re-approval flow:** Stage 3 modal's "Send to Stage 9 Rewrite" navigation target → Stage 10. `characterChangeContext` diff target stage. `showGenericRegenModal()` next-stage references for Stages 2/4/5/6. `updateStageNav()` stale dot logic (reads `_meta.stale` — verify stage number mapping). **Import flow:** `window.importedProjectTarget = 8` → `= 9`. **FountainEditor slots:** `externalToolbarSlot` references in `stage7LoadEditor()` (becomes stage8) and Stage 9 editor init (becomes Stage 10). **Chat persistence:** `stageChatWindows` keys and `initStageChat()` calls — verify numbering. `restoreHistory()` loads from `projectData.data.conversations.stageN` — keys stay as-is per "don't rename data keys" rule, but the mapping logic (which UI stage reads which data key) must be updated. |
| `server.js` | `stageNames` dictionary (line ~754). `priorStageNames` dictionary (line ~787). `getModelConfig()` function (line ~49). API endpoint references. Export stage routing switch (lines ~1409-1483). `/api/finalize-stage9` endpoint name → `/api/finalize-stage10`. Coverage loopback logic (lines ~606-627). **Re-approval flow:** `stampRevisedStage` logic in `PUT /api/projects/:id` — verify stage cascade numbering. `/api/brainstorm-rewrite` init: `characterChangeContext` detection (currently targets Stage 9, becomes Stage 10). **Chat persistence:** Prior-stage conversation injection into system prompts — the code loads `conversations.stageN` keys; since data keys don't change, the server-side mapping of "which prior stages to load for stage X" needs updating (e.g., Stage 10 Rewrite should load conversations from stages that were formerly 1-8, now 1-9). |
| `agents/export.js` | Function names and the export routing. Add Style export function if needed. |
| `data/settings.json` | Add `stage7` model config entry. Renumber existing stage entries. |

### Phase 2 — New Stage 7 Style (Creative)

| File | Action |
|------|--------|
| `agents/agent_7_style.js` | **CREATE** — New agent that analyzes uploaded writing samples and generates a style skill file. |
| `skills/skill_stage7_style.md` | **CREATE** — SOP for the Style agent (what to extract, how to format output, quality criteria). |
| `public/index.html` | Add Stage 7 workspace view (style selector UI, upload area, preview). |
| `public/app.js` | Add `initStage7()` function, style selection logic, upload handling, preview generation. |
| `server.js` | Add `/api/generate-stage7-style` endpoint. Add `/data/styles/` directory management. |

### Phase 3 — Thread Style into Draft + Rewrite

| File | What Changes |
|------|-------------|
| `agents/agent_7_draft.js` (becomes agent_8) | Load selected style skill file into system prompt before each scene draft. |
| `agents/agent_9_rewrite.js` (becomes agent_10) | Load selected style skill file into system prompt before each scene rewrite. |
| `skills/skill_brainstorm.md` | Update stage references (stages 1-8 instead of 1-7). |

### Rename Skill Files

| Current | New |
|---------|-----|
| `skill_stage7_draft.md` | `skill_stage8_draft.md` |
| `skill_stage8_coverage.md` | `skill_stage9_coverage.md` |
| `skill_stage9_planner.md` | `skill_stage10_planner.md` |
| `skill_stage9_rewrite.md` | `skill_stage10_rewrite.md` |

### Files That DON'T Change

- `utils/stageMetadata.js` — Staleness cascade currently tracks stages 1-7. After renumber, it tracks 1-8 (Style is now part of the pre-draft pipeline). **Verify** whether the stale-stamp logic uses hardcoded stage numbers or derives them dynamically. If hardcoded, update the upper bound from 7 to 8.
- `agents/agent_humanizer.js` — Still fires after Draft (now Stage 8). May need a reference update if hardcoded to "Stage 7."
- `agents/ai-client.js` — Generic provider logic, stage-agnostic.
- `skills/skill_humanizer.md` — No changes.
- `skills/skill_coverage_consolidator.md` — No changes.
- `skills/skill_meta_review.md` — No changes.
- Stages 1-6 agent and skill files — No changes.

### Critical: Don't Rename Data Keys

Project JSON files store data as `stage1_pitch`, `stage2_outline`, `stage6_scenes`, `stage7_humanized`, `stage8_coverage`, `stage9_rewrites`, etc. **Do not rename these keys.** They're the permanent storage schema. Renaming them breaks every existing project.

Instead: stages 1-6 data keys stay identical. Stage 7+ logic layers get renumbered, but the underlying data keys remain as-is. This creates a minor mismatch under the hood (e.g., the data key `stage8_coverage` maps to "Stage 9 Coverage" in the UI) but that's an internal detail that doesn't affect the user.

**New data keys to add:**
- `stage7_style` (stores the name/path of the selected style for this project, or `"none"`)
- `stage7_style_skipped` (boolean, `true` if an imported project auto-skipped Stage 7)
- `isImported` (boolean, `true` if the project was created via Import Script)
- `importedScriptPath` (string, path to the original imported file)

**Schema update for `stage8_draft`:**
Each scene object should now include `style_version` to track which version of the style it was drafted under:
```json
{
  "scene": 1,
  "location": "...",
  "content": "...",
  "locked": true,
  "style_version": 1
}
```

---

## Estimated Scope

| Category | Files | Complexity |
|----------|-------|------------|
| HTML structure | 1 file, ~80 lines | Medium |
| JavaScript navigation & switching | 1 file, ~100 lines | Medium |
| Backend routing & endpoints | 1 file, ~150 lines | High |
| Export routing | 1 file, ~40 lines | Medium |
| New agent + skill | 2 new files | High |
| Skill/agent file renames | 7 files | Low (mechanical) |
| Config updates | 1-2 files | Low |
| **Total** | **~15 files, ~500+ lines** | |

---

## Recommended Implementation Order

1. **Phase 1 first** — Do the rename surgery so Stage 10 is clean and Polish is gone. Test that the app still works end-to-end with the renumbered stages before adding anything new.

2. **Phase 2** — Build Stage 7 Style (agent, skill, UI, endpoint). Test the creation workflow: upload samples → generate style file → preview scene → save.

3. **Phase 3** — Thread the style into Draft and Rewrite. Test a full pipeline run with style enabled vs. style set to None.

---

## Open Questions (Resolved by Brainstorm)

### Resolved

- ✅ **Interaction model:** Hybrid chat-first + form option (see Section 1 of brainstorm)
- ✅ **Style references:** Autocomplete from curated database + free text + uploaded samples (see Section 3 of brainstorm)
- ✅ **Editing after Stage 8:** Allowed; selective re-draft options (see Style Editing section above)
- ✅ **Imported script handling:** Auto-skip Stage 7; user can optionally add style for Rewrite context (see Imported Scripts section above)
- ✅ **Scene context in Stage 7:** Agent reads Stage 6 scenes and offers suggestion, user can accept/override (see Stage 6 → 7 Handoff section above)
- ✅ **Style in Stage 8 prompt:** Loaded as system prompt directive with explicit precedence (see How Style Threads section above)
- ✅ **Sidebar appearance:** Stage 7 shows as skipped/completed + style name when approved (see full brainstorm Section 5)
- ✅ **Upload format support:** Yes, .fountain files accepted along with .txt, .pdf (already noted in skill SOP)
- ✅ **Example scene for preview:** First scene from Stage 6 (simplest, most consistent)

### Still Open / For Future Implementation

- **Style library UI:** How should the "My Styles" view be organized? Sidebar panel? Separate modal? Grid vs. list?
- **Style sharing between projects:** Should the UI show "used in X other projects" metadata?
- **Style deletion safety:** Should there be a confirmation if user tries to delete a style used in other projects?
- **Style versioning:** If a style is regenerated, does the old version get archived or overwritten?

---

## Brainstorm Reference

For detailed UX decisions, see `/sessions/dazzling-pensive-thompson/mnt/COWORK/PROJECTS/PAGE-ONE/RESEARCH/stage7-style-ux-brainstorm.md`

This handoff document is the single source of truth for Stage 7 Style implementation spec. The brainstorm document is the design rationale reference.

---

*Last updated: 2026-03-22 — Brainstorm integrated, design spec finalized*
