# Phase 2 — New Stage 7 Style Feature

*Part of Stage 7 Style implementation. Execute AFTER all Phase 1 rename surgery is verified.*
*Parent spec: `specs/stage-7-style-handoff.md`*

---

## Goal

Build the complete Stage 7 Style feature: agent, skill file, UI, backend endpoint, style file storage. After this phase, a user can enter Stage 7, describe a writing style (via chat or form), generate a style skill file, preview it against a scene, and approve it for the project.

## Prerequisite

Phase 1a/1b/1c are complete — the app runs cleanly as a 10-stage pipeline with Stage 7 as a placeholder.

---

## New Files to Create

### 1. `agents/agent_7_style.js`

**Purpose:** Analyzes user input (chat description, form data, uploaded writing samples) and generates a style skill file.

**Inputs:**
- User's style description (free text from chat, or structured form data)
- Optional: uploaded writing samples (.txt, .pdf, .fountain)
- Optional: Stage 6 scene summaries (for style suggestion)
- Model config (from settings)

**Output:** A markdown style skill file (400-600 words) with YAML front matter.

**Behavior:**
- If samples are provided, analyze them to extract: scene construction patterns, action line style, dialogue fingerprint, tonal register, signature moves, what they avoid
- If references are provided (director/writer names), use training knowledge to construct style directives
- If both, samples take priority — references serve as supplementary context
- Generate actionable craft directives, NOT literary analysis. The output reads as instructions for the Draft agent.

**YAML front matter format:**
```yaml
---
name: "Nancy Meyers"
created: "2026-03-22"
references: ["Nancy Meyers", "Something's Gotta Give"]
tonal_summary: "Warm, grounded, dialogue-forward"
preview_scene: "stage6_scenes[0]"
word_count: 520
---
```

**Style file sections** (see parent handoff for full Nancy Meyers example):
- Scene Construction
- Action Lines
- Dialogue
- Tone
- Signature Moves
- Avoid

### 2. `skills/skill_stage7_style.md`

**Purpose:** SOP for the Style agent — what to extract, how to format, quality criteria.

**Key rules:**
1. Output must be actionable directives, not analysis
2. 400-600 words max — compact enough to fit in a scene-drafting prompt without bloating context
3. Each section uses imperative voice ("Open scenes mid-moment" not "Scenes tend to open mid-moment")
4. Avoid section is mandatory — knowing what to avoid is as important as what to do
5. If user provides contradictory references (e.g., "Nancy Meyers but gritty"), resolve the tension explicitly in the directives
6. Tags must be unique per project (no two projects should generate identical style files from different inputs)

### 3. `data/styles/` directory

- Create if it doesn't exist
- Styles are saved here as `[slug].md` files (e.g., `nancy-meyers.md`, `my-custom-voice.md`)
- Each project's JSON stores only the name/path of the selected style — NOT the content

---

## Backend Changes (`server.js`)

### New Endpoint: `POST /api/generate-stage7-style`

**Request body:**
```json
{
  "projectId": "...",
  "mode": "chat" | "form",
  "description": "Nancy Meyers but darker...",
  "formData": { "name": "...", "sliders": {...}, "references": [...], "characteristics": [...] },
  "sampleFiles": ["uploaded-sample.fountain"],
  "conversationHistory": [...]
}
```

**Behavior:**
1. Load `skill_stage7_style.md`
2. If `mode === "chat"`, pass conversation history + description to agent
3. If `mode === "form"`, convert form data to structured prompt for agent
4. If sample files are provided, read them and pass content to agent
5. Agent generates style skill file
6. Save to `data/styles/[slug].md`
7. Update project data: `stage7_style = "[slug]"`
8. Return the generated style content + metadata

### New Endpoint: `POST /api/preview-style-scene`

**Request body:**
```json
{
  "projectId": "...",
  "styleSlug": "nancy-meyers",
  "sceneIndex": 0
}
```

**Behavior:**
1. Load the style file from `data/styles/[slug].md`
2. Load Scene 1 from `stage6_scenes`
3. Draft the scene using the style directives (same mechanism as Stage 8 Draft, but single scene)
4. Return the drafted scene for preview

### New Endpoint: `GET /api/styles`

Returns list of all available styles (reads `data/styles/` directory, parses YAML front matter from each file).

### New Endpoint: `POST /api/select-style`

Sets `stage7_style` on a project to an existing style slug (for reuse across projects).

### Chat Support

Stage 7 should use the existing `/api/brainstorm` chat infrastructure:
- Add Stage 7 to the brainstorm routing
- System prompt should include `skill_stage7_style.md`
- Chat can be conversational (clarifying questions) before triggering generation

---

## Frontend Changes

### `public/index.html`

Replace the Phase 1b placeholder with the real Stage 7 workspace view:

**Layout:**
- Left panel: Chat interface (primary interaction path)
- Right panel: Style card display (shows current style or "No style selected")
- "Quick Start" button that opens the form as an alternative to chat

**Chat panel:**
- Opening message: "Tell me about the writing style you want for this screenplay. Reference specific directors, films, writers, or describe the vibe in your own words."
- If Stage 6 scenes exist, agent opens with a style suggestion based on story context
- Standard chat input with send button

**Quick Start form** (shown in modal or expandable panel):
- Style name field (text input)
- Tonal sliders: Warm ←→ Dry, Restrained ←→ Operatic, Grounded ←→ Stylized
- Key characteristics multi-select pills: "Minimal dialogue," "Rich action lines," "Fast-paced," "Poetic," "Terse," etc.
- Reference film/director text input (autocomplete if feasible, free text is fine)
- File upload zone for writing samples (.txt, .pdf, .fountain)

**Style card** (right panel, shown after generation):
- Style name
- Tonal summary (from YAML front matter)
- References used
- "Preview Scene" button → shows a sample scene drafted in this style
- "Approve" button → locks style for this project, marks Stage 7 complete
- "Edit" / "Regenerate" options

**Imported project handling:**
- If `data.imported === true` and `stage7_style_skipped === true`, show message:
  > "This imported script went straight to Coverage. You can set a writing style now if you'd like to guide future rewrites, but it won't affect the existing draft."
- User can still create/select a style — it applies to Stage 10 (Rewrite) only

**"My Styles" selector:**
- Dropdown or sidebar panel showing all styles from `GET /api/styles`
- User can select an existing style instead of creating a new one
- Shows which styles are used in other projects (metadata)

### `public/app.js`

**New functions:**
- `initStage7()` — Initialize the Style workspace, load chat, load existing style if any
- `stage7LoadChat()` — Set up chat interface for Style stage
- `stage7GenerateStyle()` — Call `/api/generate-stage7-style`
- `stage7PreviewScene()` — Call `/api/preview-style-scene`, show result
- `stage7ApproveStyle()` — Lock style, mark stage complete, enable navigation to Stage 8
- `stage7SelectExistingStyle()` — Pick from "My Styles" list
- `stage7LoadForm()` — Show Quick Start form

**Stage 7 completion logic:**
- Stage 7 is "complete" when `stage7_style` is set to a valid slug (not `"none"`)
- For imported projects with `stage7_style_skipped === true`, Stage 7 shows as "skipped" — not a blocker for Stage 8+

**Stage 6 → Stage 7 handoff:**
- When user navigates from Stage 6 to Stage 7, optionally read Stage 6 scene summaries
- Agent can generate a style recommendation: "Based on your story, I suggest a [sparse, intimate, dialogue-forward] approach."
- User can accept (chat seeded with suggestion) or ignore (fresh chat)

### `public/style.css`

- Style card styling (match existing card patterns from Stage 3 characters)
- Tonal slider styling
- Multi-select pill styling
- Preview scene display formatting

---

## Style Editing After Stage 8 Has Started

Users can return to Stage 7 after Stage 8 (Draft) to change the style. When they do:

1. Stage 7 re-opens showing current style selection
2. User can "Refine current style" or "Switch to a different style"
3. After change, present three options:
   - **Re-draft all scenes** — expensive, all scenes re-drafted with new style
   - **Apply to new scenes only** — previously drafted scenes stay
   - **Keep current draft** — style file updated but scenes not re-drafted

Add `style_version` field to each scene in Draft data (see parent handoff for schema).

---

## Verification

1. Navigate to Stage 7 → chat opens with style prompt
2. Describe "Nancy Meyers but darker" → agent asks clarifying questions → generates style file
3. Style card appears with name, tonal summary, references
4. Click "Preview Scene" → see a scene drafted in the style
5. Click "Approve" → Stage 7 marked complete, can navigate to Stage 8
6. Open a different project → Stage 7 shows "My Styles" with the previously created style available
7. Select existing style → approve → works without regeneration
8. Import a .fountain file → Stage 7 shows as skipped → can optionally add style
9. Quick Start form: fill in sliders + references → generates style → preview → approve
10. Upload a .fountain writing sample → agent analyzes it → generates style based on sample

---

*After this phase is verified, proceed to `stage7-phase-3-thread-style.md`.*
