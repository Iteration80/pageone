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

### 2026-03-18 — Gemini model name made configurable
All 19 hardcoded `'gemini-3.1-pro-preview'` strings across `agents/*.js` replaced with `process.env.GEMINI_MODEL`. (Superseded by per-stage model selection above.)

---

## Meta-Skill: Task Observer

At the start of any task-oriented session — any interaction where you will use tools and produce deliverables — activate the Task Observer protocol below.

When working on any PageOne skill file, also check `data/skill_observations/log.md` for OPEN observations tagged to that skill. Apply their insights to the current work, even if the skill file itself hasn't been updated yet.

---

### Task Observer Protocol
*Adapted from "One Skill to Rule Them All" by Eoghan Henn (rebelytics.com), CC BY 4.0*

**Purpose:** Systematically capture skill improvement signals during real work sessions so that PageOne's skill files evolve based on actual usage rather than guesswork.

#### What to Observe
1. **Corrections** — When a stage output is wrong and the user submits notes for regeneration, that's a signal of a gap or ambiguous rule in the skill file.
2. **Gaps** — When something is fixed manually that the skill should handle automatically.
3. **Patterns** — When the same type of error recurs across sessions or projects.

#### How to Log (silently, without interrupting the user's flow)
Append to `data/skill_observations/log.md` using this format:

```
### Observation [N]: [Short title]
**Status:** OPEN
**Date:** [YYYY-MM-DD]
**Skill:** skills/skill_stage[N]_[name].md
**Signal:** [What happened — user correction, gap noticed, pattern observed]
**Issue:** [The specific rule or gap that caused or failed to prevent this]
**Suggested improvement:** [A concrete change to make to the skill file]
**Principle:** [The generalizable lesson this illustrates]
```

Use monotonically increasing observation numbers. Check the log for the highest existing number before appending to avoid collisions.

#### When to Surface Observations
At the end of any session where observations were logged, add a brief note: "I've logged [N] observation(s) to `data/skill_observations/log.md`."

Do not interrupt the user during work to surface observations. Log silently; report at session end.

#### Review Trigger
When the user runs `/review-skills`, follow the protocol defined in `skills/skill_meta_review.md`.
