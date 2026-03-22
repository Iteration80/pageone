# PageOne — Project Instructions for Claude Code

## Project Overview
PageOne is a 9-stage AI screenplay development pipeline. Each stage is driven by a skill file (SOP) in `skills/` that instructs the Gemini AI agent on how to produce output. The quality of the entire pipeline depends on the quality of these skill files. Improving them is the highest-leverage activity in this project.

## Skill Files (the core assets)
All stage SOPs live in `skills/`:
- `skills/skill_stage2_outline.md` — Broad outline / beat structure
- `skills/skill_stage3_characters.md` — Character casting and profiling
- `skills/skill_stage4_beats.md` — 15-beat sequence sheet
- `skills/skill_stage5_treatment.md` — Scene-by-scene treatment
- `skills/skill_stage6_scenes.md` — Full scene writing
- `skills/skill_stage7_draft.md` — Full screenplay draft
- `skills/skill_stage8_coverage.md` — Quality coverage report
- `skills/skill_stage9_planner.md` — Rewrite planning
- `skills/skill_stage9_rewrite.md` — Surgical scene rewriting
- `skills/skill_coverage_consolidator.md` — Coverage synthesis
- `skills/skill_humanizer.md` — AI-artifact removal

## Project Data (observation signals)
User feedback and quality signals are stored in `data/projects/*.json`. Relevant fields:
- `stage{N}.notes` — User feedback text submitted when regenerating a stage output
- `stage8_coverage.evaluation_grid` — Structured quality ratings (concept / structure / characterization / pacing / dialogue)
- `stage8_coverage.analytical_comments` — Detailed qualitative notes on the output
- `stage8_coverage.blueprint` — Macro/micro to-do lists that identify recurring weaknesses

---

## Recent Changes
*Keep last 2–3 weeks here. Archive older or superseded entries to `CHANGELOG-archive.md`.*

### 2026-03-21 — Sticky toolbar + parenthetical auto-wrap (Stage 7 & 9)

Fixed the FountainEditor formatting toolbar scrolling out of view when editing long scenes.

- **`public/index.html`** — Stage 7: restructured DOM so the generation control bar (Generate Scene, Lock & Next, Generate All) and the formatting toolbar live in a fixed `#stage7-sticky-header` above the scroll container. Stage 9: added `#stage9-toolbar-slot` between the "Proposed Rewrite" header and the scrollable editor mount.
- **`public/fountain-editor.js`** — `constructor()` accepts new `externalToolbarSlot` option; when provided, the toolbar mounts into that external element instead of inside the editor container. `destroy()` clears both the container and the external slot. `setElementType()` now auto-wraps text in `()` when switching to parenthetical and strips them when switching away. Parser keeps `()` in parenthetical text so they display in the editor (serializer already normalizes).
- **`public/app.js`** — `stage7LoadEditor()` and Stage 9's `FountainEditor` instantiation both pass their respective toolbar slot elements via `externalToolbarSlot`.
- **`public/style.css`** — `.fe-toolbar` uses `position: relative` (anchor for absolute dropdown). Removed stale `padding-bottom: 200px` from `.draft-editor-container`. Added `overflow: visible` on sticky headers so dropdowns aren't clipped. `#stage7-toolbar-slot:empty` and `#stage9-toolbar-slot:empty` collapse when no editor is active.

**Architecture note:** The `externalToolbarSlot` pattern keeps FountainEditor reusable — any future stage can choose inline (default) or external toolbar mounting.

### 2026-03-21 — Import existing screenplay for rewrite

New "Import Script" feature on the project hub allows importing an existing `.fountain`, `.fdx` (Final Draft), or `.pdf` screenplay. The script is parsed into scenes, Stage 6/7 data is populated, and the user lands directly at Stage 8 (Coverage) to begin the rewrite workflow.

- **`utils/script-import.js`** (new) — `parseFountain(text)` splits by scene headings, extracts title from Fountain title page. `parseFdx(xmlString)` parses Final Draft XML via `xml-js`, converts paragraph types to Fountain format. `parsePdfScript(pdfBuffer, modelConfig)` extracts text via `pdf-parse` then uses AI to identify scene boundaries. `buildStage6FromScenes(scenes)` groups scenes into ~8 sequences by page-count distribution.
- **`server.js`** — `POST /api/import-script` endpoint (multipart via multer). Detects file type, runs appropriate parser, creates project with `stage6_scenes` + `stage7_approved: true` + `imported: true`. No AI calls needed for `.fountain`/`.fdx` (deterministic parsing).
- **`public/index.html`** — "Import Script" button on hub header. Import modal with drag-and-drop file zone, optional title field, progress spinner.
- **`public/app.js`** — Full import UI flow (modal, file selection, upload). After import, `window.importedProjectTarget = 8` navigates directly to Stage 8. `openProject()` reads this flag to skip Stage 1.

**Architecture notes:**
- Imported projects have `data.imported = true` and `data.importedFrom = filename` for identification.
- Stages 1–5 are empty on imported projects — they show as incomplete in sidebar but don't block coverage or rewrite.
- Coverage only needs `stage6_scenes` with `draft_text` populated — no dependency on earlier stages.
- `humanized_draft_text = draft_text` on import (no humanization needed for human-written scripts).

### 2026-03-21 — Stage 9 rewrite UX: priority labels, preview default, diff fix

Three improvements to the Stage 9 rewrite workflow:

1. **Brainstorm priority labels** — `server.js` labels changed from `MACRO 1` to `MACRO TO-DO P1` (matching UI). Init prompt tightened to require verbatim priority presentation. After-approval prompt includes progress count ("3 of 12 done"). `skills/skill_brainstorm.md` Mode 3 rewritten to require exact labels and task text under MACRO TO-DO / MICRO TO-DO headings.

2. **Preview as default view** — Stage 9 right panel now defaults to "Preview" mode (read-only with green diff highlights) instead of "Formatted" (editor). "Source" mode removed entirely. Two tabs remain: "Preview" and "Edit". Editor is lazily created when user switches to Edit mode.

3. **Diff highlight fix** — `stage9FlushEditPanel()` now only writes to `stage9Pending` if the scene already had pending changes. Previously it unconditionally overwrote pending text with editor-normalized output on every scene navigation, which could collapse diffs on revisited scenes.

### 2026-03-21 — Project cost tracking + spend modal

Token usage tracked per API call across all models. Each project stores its own usage history.

- **`agents/ai-client.js`** — Both `callGemini()` and `callClaude()` return `{ text, usage: { model, inputTokens, outputTokens } }`.
- **All 12 agent files** — Updated to return `{ result, usage }` or `{ result, usageList }`.
- **`server.js`** — `trackUsage(projectId, usageOrList)` helper appends to `project.data.apiUsage[]`. All 15 AI endpoints call it after each generation.
- **`public/app.js`** — `MODEL_PRICING` table with per-token costs for all supported models. `openSpendModal()` aggregates usage by model, calculates costs, renders breakdown table. "$" button in sidebar footer opens the modal.
- **`public/index.html`** — Spend modal + "$" icon button in sidebar.

### 2026-03-21 — Professional screenplay formatting editor (Stage 7 & 9)

New `public/fountain-editor.js` (~400 lines) provides a shared WYSIWYG screenplay editor with professional formatting controls, used in both Stage 7 (Draft) and Stage 9 (Rewrite).

- **`FountainEditor` class** — `contenteditable` surface where each line is a `<div>` with `data-element` type and CSS class. `loadFountain(text)` parses Fountain markup into typed elements; `toFountain()` serializes back. Round-trips cleanly with all existing export/diff/coverage flows.
- **Element types**: Scene Heading, Action, Character, Parenthetical, Dialogue, Transition — styled to match professional screenwriting software (ArcStudio Pro reference).
- **Toolbar**: Compact bar with current-type dropdown button and keyboard shortcut badges. `⌘1–6` sets element type, `Tab` cycles contextually (e.g., Character→Dialogue→Action), `Enter` auto-advances to the next logical type.
- **Stage 7 integration**: Replaced static `contenteditable` div with FountainEditor. Added 2-second debounced auto-save via `onDirty` callback — fixes long-standing bug where manual edits were lost on scene navigation.
- **Stage 9 integration**: FountainEditor loads in "Formatted" mode (default). 3-way toggle: Formatted (WYSIWYG) | Source (raw textarea) | Preview (read-only diff). `stage9FlushEditPanel()` handles both editor and textarea.
- **Version History**: Removed assistant chat panel, added View (preview modal) and Download (.txt) buttons. `snapshotToText()` renders all stage types including evaluation grid, analytical comments, and blueprint.

### 2026-03-21 — Deleted scenes filtered from coverage and exports

`[SCENE DELETED]` markers (15-char truthy strings) were passing `.filter(Boolean)` and leaking into coverage agent input, PDF exports, and .fountain downloads.

- **`server.js`** — Coverage loopback and PDF export filter out `[SCENE DELETED]` explicitly.
- **`public/app.js`** — Fountain export adds `.filter(t => t && t !== '[SCENE DELETED]')`.

### 2026-03-19 — BYOK Settings + Per-Stage Model Selection
Full multi-provider settings system shipped. Key changes:

- **`agents/ai-client.js`** (new) — unified wrapper supporting Gemini (`gemini-*`) and Anthropic (`claude-*`) providers. Detects provider from model name prefix. Handles content format conversion, PDF inline data, JSON schema enforcement (native on Gemini, system-prompt injection on Claude). Gemini-only features (`googleSearch` tool, `thinkingConfig`) are silently dropped for Claude.
- **All 11 agent files** migrated from direct `GoogleGenAI` SDK to `ai-client.js`. Each accepts `modelConfig = {}` as last optional param (`model`, `geminiApiKey`, `anthropicApiKey`) with `.env` as fallback. `agent_humanizer.js` intentionally left unchanged (hardcoded flash model).
- **`server.js`** — `loadSettings()` at startup reads `data/settings.json`; `getModelConfig(stageNum)` returns the right model+keys per stage; `GET /api/settings` and `POST /api/settings` endpoints added; all agent call sites updated.
- **`data/settings.json`** (gitignored) — stores `geminiApiKey`, `anthropicApiKey`, and `stageModels.stage1`–`stage9`.
- **Frontend** — gear icon in sidebar footer + hub header opens a settings modal with API key fields and per-stage model dropdowns (Gemini 3.1 Pro, Gemini 2.0 Flash, Claude Opus 4.6, Claude Sonnet 4.6, Claude Haiku 4.5).
- **`.gitignore`** created covering `.env`, `data/settings.json`, `data/projects/`, `node_modules/`.

**Architecture notes:**
- Coverage consolidator (`agent_8_coverage.js`) always uses hardcoded `gemini-3-flash-preview` — intentional cost optimization, not user-configurable.
- `.env` remains fully functional as fallback if no `settings.json` exists.
- Settings changes take effect immediately (no restart needed) — `appSettings` is updated in-memory on POST.

### 2026-03-19 — Skill file upgrades from avoid-ai-writing + obra/superpowers-skills collection

Three skill files improved based on review of external skills collections:

- **`skills/skill_humanizer.md`** — Priority 1 banned vocabulary expanded from 11 to 28 words (added screenplay-relevant Tier 1 AI vocabulary from avoid-ai-writing v2.2.0 with replacements). Priority 2 soft-intensifiers expanded. Three new priority categories added: Priority 6 (tourism/promotional language in action lines), Priority 7 (copula avoidance — serves as/boasts/features), Priority 8 (participial string analysis — "-ing, -ing, -ing" chains that interpret rather than show).

- **`skills/skill_brainstorm.md`** — Two analytical techniques added inside Mode 2 (Brainstorm): **Inversion** (deploy when writer treats structural choice as unavoidable; inverts 2–3 core assumptions to reveal hidden dependencies) and **Collision-Zone Thinking** (deploy when writer feels locked in genre conventions; forces domain collision to surface fresh structural possibilities). Both include explicit trigger phrases, deployment criteria, and screenplay-specific examples. Mode 3 (Stage 9 Opening) extended with a **Priority Deliberation** protocol: when the writer selects a coverage priority, the assistant must (1) restate it in concrete scene-specific terms, (2) scope-check which scenes are affected, (3) challenge the note if coverage may have misread the script, and (4) only then discuss implementation. Steps fold into natural editorial conversation — not a rigid checklist.

- **`skills/skill_stage8_coverage.md`** — Section 5 (Analytical Comments) restructured from single-voice to three named critical voices: **Story Analyst** (structural/character arc, existing coverage), **Dialogue Specialist** (voice distinctiveness, subtext, on-the-nose dialogue — must cite specific lines), **Devil's Advocate** (stress-tests praised elements — interrogates whether strengths actually hold). No schema or frontend changes; Devil's Advocate and Dialogue bullets are attributed via headline prefix.

### 2026-03-19 — Cross-stage chat persistence
Stage assistant conversations are now persisted to the project file and shared across stages.

- **`server.js`** — `/api/brainstorm`: after each exchange, full message array saved to `projectData.data.conversations.stageN`. Prior-stage conversations (last 20 messages each) injected into the system prompt so later-stage assistants have full context. `/api/brainstorm-rewrite` (Stage 9): same persistence on non-init calls.
- **`public/app.js`** — `ChatWindow` class: added `restoreHistory(messages)` method that renders prior sessions with `— previous session —` / `— continuing —` separators and seeds `this.history`. Added `const stageChatWindows = {}` to hold all 7 instances; all `initStageChat()` calls now assign into it. `openProject()`: clears all chat windows on load, then restores any saved conversations from `projectData.data.conversations`.

**Data shape:** `projectData.data.conversations = { stage1: [{role, content}, …], stage2: […], … }`

### 2026-03-20 — Stage 9 plan generation: socket timeout fix + diagnostics

Fixed recurring "socket connection was closed unexpectedly" error during plan generation:

- **`agents/ai-client.js`** — Added `httpOptions: { timeout: 300_000 }` to `GoogleGenAI` constructor. The global undici dispatcher does not reach the Google SDK's internal HTTP client; timeout must be set at the SDK level. Node 24's default is 60s, but plan generation on a full screenplay can take longer.
- **`server.js`** — Added `undici` package with global dispatcher (300s timeout) as a safety net for other fetch calls. Trimmed `conversationContext` sent to planner to last 4000 chars to reduce prompt size. Added diagnostic logging (model, prompt size, attempt timing) to `/api/plan-rewrite`.
- **Root cause of repeated failures:** A stale `bun` process was holding port 3000. Every `pkill -f "node server.js"` killed Node but left bun running, so all requests hit the old unfixed code. Fixed by explicitly killing the bun PID.

**Operational note:** When restarting the server, always verify with `lsof -i :3000 -P | grep LISTEN` that `node` (not `bun`) is listening.

### 2026-03-20 — Stage 9 UX: thinking dots + persistence + retry logic

- **`public/app.js`** — Thinking dots (`setThinking`) now show on every Send across all stages (1–9), during plan generation, during Execute Plan, and during Approve & Continue. `stage9Pending` is restored from `stage9_rewrites.pending` on project load so rewrites survive page refresh. Guards added to prevent duplicate plan generation (`stage9GeneratingPlan`, `window.stage9CurrentPlan`).
- **`server.js`** — `/api/rewrite-single-scene` persists each rewrite to `stage9_rewrites.pending` on disk as it completes. `/api/approve-rewrite-priority` clears pending from disk. `/api/plan-rewrite` has 3-attempt retry with exponential backoff.
- **`agents/agent_9_rewrite.js`** — 3-attempt retry with exponential backoff. Prompt restructured: `PLANNED CHANGE FOR THIS SCENE` is now the PRIMARY instruction (was buried as secondary). Deletion short-circuited server-side before LLM call.
- **`skills/skill_stage9_rewrite.md`** — Added `PROMPT SECTIONS` guide explaining primary vs background context. Added deletion instruction (`[SCENE DELETED]`).

### 2026-03-19 — Approve button state: consistent disabled/re-enable logic (Stages 2–6)
Fixed `public/app.js` so the Approve button behaves identically across all stages:

- **After approval:** button shows "Approved ✓" (green), `disabled = true` — not clickable
- **After any edit:** first keystroke/input resets button to "Approve →" (blue), `disabled = false`
- **On page reload:** if stage data exists in project JSON, button is restored to disabled "Approved ✓"

**Stages fixed:** 2, 3, 4, 6. Stage 5 was already correct (reference implementation). Stage 1 uses a slightly different `{ once: true }` pattern but behaves the same way. Stage 7+ has a different approval model.

Root causes fixed per stage:
- **Stage 2** — `finally` block was re-enabling button after successful approval; load-time hydration wasn't setting `disabled = true`; change-detection listener wasn't setting `disabled = false`
- **Stages 3, 4** — textarea `input` listeners only called `autoResize()`, never reset the approve button
- **Stage 6** — same as 3/4, plus `disabled = false` also needed on `renderStage6()` re-render (no `finally` block in approval handler left `disabled` stuck as `true` on nav-back)

---

## Meta-Skill: Task Observer

At the start of any task-oriented session — any interaction where you will use tools and produce deliverables — activate the Task Observer protocol below.

**Monday Auto-Review:** If today is Monday, read `data/skill_observations/log.md` immediately. If any OPEN observations exist, run `/review-skills` before beginning the session's main work.

When working on any PageOne skill file, also check `data/skill_observations/log.md` for OPEN observations tagged to that skill. Apply their insights to the current work, even if the skill file itself hasn't been updated yet.

---

### Task Observer Protocol
*Adapted from "One Skill to Rule Them All" by Eoghan Henn (rebelytics.com), CC BY 4.0*

**Purpose:** Systematically capture skill improvement signals during real work sessions so that PageOne's skill files evolve based on actual usage rather than guesswork.

#### What to Observe
1. **Corrections** — When a stage output is wrong and the user submits notes for regeneration, that's a signal of a gap or ambiguous rule in the skill file.
2. **Gaps** — When something is fixed manually that the skill should handle automatically.
3. **Patterns** — When the same type of error recurs across sessions or projects.

#### How to Log
Use the Write/Edit tool to append to `data/skill_observations/log.md` immediately when a signal is detected — don't batch them up or defer to session end. The tool call itself is fine; just don't interrupt with discussion about it.

Minimal required fields (drop Principle if nothing generalizable):

```
### Observation [N]: [Short title]
**Status:** OPEN
**Date:** [YYYY-MM-DD]
**Skill:** skills/skill_[name].md
**Signal:** [What happened — user correction, gap noticed, pattern observed]
**Suggested improvement:** [A concrete change to make to the skill file]
```

Check the log for the highest existing observation number before appending to avoid collisions.

#### Session-End Checkpoint (mandatory)
Before wrapping up any session where tools were used, do a quick scan:
- Was any stage regenerated with user feedback notes?
- Did the user correct Claude's approach mid-task?
- Was any output manually fixed that a skill should have caught?

If yes to any: append observations now (if not already logged during the session).
If no: no action needed.

#### When to Surface Observations
At the end of any session where observations were logged, add a brief note: "I've logged [N] observation(s) to `data/skill_observations/log.md`."

#### Review Trigger
When the user runs `/review-skills`, follow the protocol defined in `skills/skill_meta_review.md`.
