# PageOne — Project Instructions for Claude Code

## Project Overview
PageOne is a 9-stage AI screenplay development pipeline (Node.js + Express, vanilla-JS frontend, JSON-file persistence — no database). Each visible stage is driven by a skill file (SOP) in `skills/` that shapes model behavior, plus a per-stage editorial chat assistant where appropriate. The quality of the pipeline depends on the skill files; improving them is the highest-leverage activity in this project.

**Visible stages:** 1 Pitch · 2 Outline · 3 Characters · 4 Treatment · 5 Scene Blueprint · 6 Style · 7 Draft · 8 Coverage · 9 Rewrite.

⚠️ **Legacy data-key naming trap:** internal stage ids and saved keys do not match the visible 1-9 pipeline. Current mapping: visible 1 Pitch = internal 1 / `stage1_pitch`; visible 2 Outline = internal 2 / `stage2_outline`; visible 3 Characters = internal 3 / `stage3_characters`; visible 4 Treatment = internal 5 / `stage5_treatment`; visible 5 Scene Blueprint = internal 6 / `stage6_scenes`; visible 6 Style = internal 7 / `stage7_style`; visible 7 Draft = internal 8 / scene draft fields plus `stage7_approved`; visible 8 Coverage = internal 9 / `stage8_coverage`; visible 9 Rewrite = internal 10 / `stage9_rewrites`, with Rewrite chat persisted to `conversations.stage9`. `stage4_beats` remains a derived compatibility key generated from Stage 2 Outline for downstream Treatment/Scene Blueprint reads; it is not a visible stage. Do not "fix" these names without a data migration.

## Architecture (current — June 2026 re-architecture)

### The stage assistant: native tool calling via `POST /api/assistant`
All chat surfaces (internal stages 1, 2, 3, 5, 6, 7, 8, 10, and the projectless global style creator `stageId: "style_global"`) route through one endpoint. Coverage (visible Stage 8 / internal 9) intentionally has no chat.

- The model gets real tools per stage — `apply_revision` (stages 1–6, 8), `generate_style` (7, style_global), `generate_rewrite_plan` (10) — defined declaratively in `agents/assistant.js` (`STAGE_CONFIG`, `buildTools`).
- **Client-executed tool pattern:** when the model calls a tool, the server returns `{type:'tool_call', turnState}`; the browser executes it through the existing revision machinery (`toolAssistantTurn()` in `public/app.js`), then POSTs the structured receipt (or error) back with `turnState`; the model writes its closing message only after seeing the real result. `turnState` is the serialized neutral-format message list — the server is stateless across the two HTTP legs.
- **Honest failure is enforced structurally:** `toolResultsContainFailure()` treats `changed:false`/`error`/`isError` as failure and withholds tools on the resume leg, so a failed revision gets *reported*, never silently retried. `MAX_TOOL_ROUNDS = 3` bounds a turn.
- Provider translation lives in `agents/tool_messages.js` (neutral format ⇄ Anthropic `tool_use`/`tool_result` ⇄ Gemini `functionCall`/`functionResponse`). **Gemini 3 requires each functionCall part's `thoughtSignature` to be echoed back on resumed turns** — parse from candidate parts, not the `.functionCalls` getter.
- Assistant SOP: `skills/skill_assistant_core.md`. There is no `suggest_plan`/`execute_immediately` flag contract, no confirmation regexes, and no `[Revision applied successfully]` marker — those were removed in June 2026; do not reintroduce them.

### Server conventions
- **Typed API errors:** throw `BadRequestError`/`NotFoundError`/`RateLimitError` and respond via `sendApiError()` (server.js top). Streaming routes report failures as SSE error packets after headers are flushed. The only bare 404 is the unknown-route diagnostic.
- **Project JSON writes:** `updateProjectJSON(projectId, updater)` reads *inside* the per-project write lock — use it for read-modify-write; never mutate a request-start snapshot and save it later.
- **Streaming disconnects:** stages 2/5/6 generation attach a close-aware abort tracker; `agents/ai-client.js` propagates abort signals to both providers and normalizes them as `CLIENT_DISCONNECTED` (never retried).
- **Skill loading:** always `loadSkill('skill_name')` from `utils/skills_cache.js` (memoized). Never `readFileSync` a skill directly.
- **Model output parsing:** use `agents/json_parse.js::parseJsonWithRepair(text, { schema, label })` — never raw `JSON.parse` on model output.
- **Model config:** `getAssistantModelConfig(stageN)` for chat, `getModelConfig(stageN)` for generation; per-stage models + BYOK keys live in `data/settings.json` (gitignored), `.env` as fallback.
- Build fingerprint: `/health` (+ UI footer, Settings modal, DOCX metadata) via `utils/build_info.js` — check it first when "the server isn't running my code".

### Project-configurable data (do NOT hardcode project specifics)
- Character tiers: `data.stage3_characters.tier_overrides` (`{name: 1|2|3}`), editable via Stage 3 tier buttons; structure inference is the fallback. Seed script: `npm run migrate:stage3-tiers -- --write` (dry-run default; matches I.M.A.G.I.N.E. projects, which live on the deployment, not in local `data/projects/`).
- Protected outline beats: `data.stage2_outline.protected_beats`, editable via the Stage 2 shield toggles. The revision kernel (`utils/stage_revision_kernel.js`) contains no project-specific labels anymore.

### Frontend state
`public/app.js` now uses the state-first pattern for generated/editable stages: render seeds `currentProjectData`, edits update state, and readers use getters (`getCurrentStage2Outline()`, `getCurrentStage3Characters()`, `getCurrentStage5Treatment()`, `getCurrentStage6Blueprint()`) instead of DOM scraping. `stage4_beats` is derived server-side from the Stage 2 Outline, not edited in the UI. Shared helpers: `setApproveButtonState()`, `createStageApproveHandler()`.

## Roadmap / specs
- `specs/pageone-roadmap-2026-07-03.md` — **current remaining work** (R1–R6) with verification status.
- `specs/pageone-refactor-plan-2026-06-11.md` — the June re-architecture plan + Codex implementation record. Historical.

## Skill Files (the core assets)
All stage SOPs live in `skills/`:
- `skills/skill_assistant_core.md` — the stage assistant SOP (tool contract, editorial voice, cadence)
- `skills/skill_stage2_outline.md` — 8-sequence outline with Save the Cat beat annotations
- `skills/skill_stage3_characters.md` — character casting and profiling (tier system)
- `skills/skill_stage5_treatment.md` — scene-by-scene treatment
- `skills/skill_stage6_scenes.md` — scene blueprint
- `skills/skill_stage7_style.md` — style directive generation
- `skills/skill_stage8_draft.md` — screenplay draft
- `skills/skill_stage9_coverage.md` — coverage report
- `skills/skill_stage10_planner.md` / `skills/skill_stage10_rewrite.md` — rewrite planning / surgical rewriting
- `skills/skill_coverage_consolidator.md` — coverage synthesis
- `skills/skill_humanizer.md` — AI-artifact removal
- `skills/skill_continuity_supervisor.md` — scene-to-scene fact tracking
- `skills/skill_meta_review.md` — `/review-skills` protocol

## Project Data (observation signals)
User feedback and quality signals are stored in `data/projects/*.json`:
- `stage{N}.notes` — user feedback text submitted when regenerating a stage output
- `stage6_scenes_audit` — advisory Stage 6 dramaturgical audit (`generated_at`, `blueprint_hash`, and dismissible flags for redundancy, no-shift/filler, and overload); it never mutates `stage6_scenes`
- `stage8_coverage.evaluation_grid` / `.analytical_comments` / `.blueprint` — coverage quality ratings, qualitative notes, and macro/micro to-do lists (Coverage = visible Stage 8 despite the key name)
- `data.conversations.stageN` — persisted assistant chats (Rewrite under `stage9`)

## Testing
```sh
node --test 'test/*.test.js'      # all suites (assistant tool loop, prompt regression, knowledge, memory)
npm run test:knowledge
```
(Note: bare `node --test test/` fails with an opaque single "test failed" on this Node version — use the glob form.)
All suites must stay green. After frontend changes, also do a browser pass — the June gear-icon bug was invisible to syntax checks and curl; drive the real UI.

---

## Deployment Notes

### Authentication (Google session + `APP_SECRET`)
API auth is layered and each layer is dormant unless configured:

1. Google sign-in is active only when `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `ALLOWED_EMAILS` are set. The server issues a signed `pageone_session` cookie after a successful Google OAuth callback, and `ALLOWED_EMAILS` is rechecked on every request.
2. `APP_SECRET` remains the break-glass/admin credential even when Google auth is primary. API requests can use `X-Api-Key: <APP_SECRET>` or `Authorization: Bearer <APP_SECRET>`.
3. If neither Google auth nor `APP_SECRET` is configured, local development runs open.

Set `SESSION_SECRET` for session signing, or let it fall back to `APP_SECRET`. Deployed tester builds should keep `APP_SECRET` set even with Google enabled so maintenance scripts and recovery access still work. The public frontend reads `GET /api/auth-config` before booting so it can show either the Google button, the access-key form, or no auth overlay.

⚠️ The `ANTHROPIC_API_KEY` currently in `.env` is dead (401). All stages run Gemini today; replace or remove that key before selecting any Claude model in Settings.

### Process rule
**One AI coding session per working tree at a time; commit between sessions.** Concurrent uncommitted edits to `server.js`/`public/app.js` caused the June 11 closure-scope collision.

---

## Recent Changes
*Keep last 2–3 weeks here. Archive older or superseded entries to `CHANGELOG-archive.md`.*

### 2026-07-16 — Stage 6 per-sequence generation (progressive render + resume + manual step-through)
Reworked Scene Blueprint generation so it produces one sequence at a time instead of one long 8-call request. `generateStage6Scenes(..., options)` takes `{ fromSequence, toSequence, existingSequences, meta, onMeta, onSequence }` (defaults reproduce the original one-shot). `/api/generate-stage6-scenes` accepts `{ mode: 'auto'|'manual', resume }`, persists each sequence via `updateProjectJSON` as it lands (crash-safe/resumable), caches setup artifacts (location scan + continuity ledger) in `data.stage6_meta` so a continuation skips them, streams `sequence` events, and runs `finalizeGenerationEndpointArtifact` + `kickStage6Audit` **only when the 8th sequence lands** (manual/partial runs emit `sequence-batch-complete` and are never stamped generated early). Client renders each sequence live, adds a "One Sequence at a Time" regenerate option, and shows a continue bar on any partial (1–7/8) blueprint. ⚠️ Because finalize saves the whole `context.projectData`, anything written incrementally (`stage6_meta`) is mirrored onto `context.projectData.data` so the final save can't drop it. The mid-stream polling recovery (2026-07-15) remains as the transport-break fallback.

### 2026-07-15 — Stage 6 dramaturgical audit
Added the advisory Stage 6 scene audit for redundancy, missing value shift/quiet function, and overloaded scenes. Deterministic nominators bound the candidate list, a prosecutor/defense model pass adjudicates flags, writer dismissals persist in `stage6_scenes_audit`, non-dismissed flags feed Stage 9 coverage, and the Stage 6 UI shows stale-aware badges without auto-cutting or page targets.

### 2026-07-12 — Outline absorbs Beats; visible pipeline is 9 stages
Merged the former Beats pass into Stage 2 Outline. Stage 2 now owns Save the Cat beat names, emotional arcs, pacing notes, genre notes, and `stc_genre_category`; the server deterministically derives the compatibility `stage4_beats` artifact after Stage 2 saves/revisions. Removed the Stage 4 Beats route, agent, skill file, nav/workspace/chat UI, and assistant entry. Visible stages now run 1-9 while internal ids/data keys remain backward-compatible.

### 2026-07-08 — Google sign-in live + auth audit prep
Google OAuth sign-in with an email allowlist now sits in front of the private tester build, with `APP_SECRET` preserved as break-glass access. Added route-level auth coverage for config/me/callback/logout, hardened cookie parsing against malformed percent-encoded values, updated auth deployment docs, and changed the assistant Anthropic fallback from the superseded Sonnet 4.6 model to Sonnet 5.

### 2026-07-03 — R3/R4 completion: route split + state-first stages 4–6
Finished the generation-endpoint finalization factory for stages 2–6 (`d4e35ff`), split `server.js` into route modules one module per commit (`36e33b9`, `470a2ed`, `61a2f68`, `0a9cd63`, `3d37285`, `d033263`, `437b7a4`), and retired the remaining Stage 4/5/6 DOM scrape functions in favor of state-first getters (`d8c1d6b`, `cb87881`, `dfefa7f`). Full test gate and `/health` smoke passed after each commit; R3/R4 browser passes were blocked in Codex because the in-app browser backend exposed no available browsers.

### 2026-07-03 — Roadmap verification + docs truth pass
Codex's implementation of the June refactor plan was independently verified (2 code audits, 275 tests, live UI + tool-turn checks) — see `specs/pageone-roadmap-2026-07-03.md` for the verdict table and remaining work (R1–R6). This CLAUDE.md was rewritten to describe the post-refactor architecture; 18 pre-refactor changelog entries moved to `CHANGELOG-archive.md` with a superseded banner. `getBrainstormModelConfig()` renamed to `getAssistantModelConfig()`.

### 2026-06-11 → 2026-06-23 — Assistant re-architecture + reliability overhaul (Claude plan, Codex implementation)
Replaced the brainstorm flag contract with native tool calling through a unified `POST /api/assistant` (client-executed tools, turnState round-trip, honest failure reporting); deleted `/api/brainstorm`, `/api/brainstorm-rewrite`, `/api/style-chat`, `skill_brainstorm.md`, the frontend confirmation-regex layer, and the synthetic post-revision marker. Also: build fingerprint (Phase 0), skills cache, coverage JSON repair, character-tier + protected-beat de-hardcoding (Phase 3), RMW lock fix, awaitable Stage 8 auto-save, Stage 10 pending persistence, typed API errors across all routes, streaming abort handling (Phase 5), frontend approve-handler consolidation and Stage 2/3 state-first migration (Phases 4/6, partial). Full record: the Codex continuation notes inside `specs/pageone-refactor-plan-2026-06-11.md`.

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
