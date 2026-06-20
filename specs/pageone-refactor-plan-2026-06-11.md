# PageOne Refactor Plan — 2026-06-11

Author: Claude (Fable 5), based on full-codebase audit 2026-06-11.
Status: Phase 2 assistant unification is implemented for active chat surfaces. Stages 1–8, Stage 10 planning chat, and global style creation now route through the tool-calling assistant; legacy `/api/brainstorm`, `/api/brainstorm-rewrite`, `/api/style-chat`, frontend flag/regex scaffolding, `skill_brainstorm.md`, and the embedded Stage 2 outline transcript-bundle parser have been removed.

## Why

The audit found that the per-stage AI assistant struggles are architectural, not prompt-level:

1. **The `suggest_plan` / `execute_immediately` flag contract is enforced nowhere.** It's a JSON envelope the model fills in; the server doesn't validate it; on Claude models the schema is only pasted into the system prompt. Every "Done — I've revised..." lie happens because *execution is invisible to the model* — the frontend reads the flags, calls a separate endpoint, then injects a synthetic `[Revision applied successfully]` string back into chat so the assistant can pretend it saw the result.
2. **Two competing decision-makers.** `public/app.js` has a regex layer (`isRevisionConfirmation`, `isStage2DirectRevisionRequest`, `isStage3DirectRevisionRequest`, `isStage6DirectRevisionRequest`, `pendingRevision` state) that fires revisions *before the model is consulted*, plus the model's flags. They drift independently.
3. **Four chat systems**: `/api/brainstorm` (stages 1–9), `/api/brainstorm-rewrite` (stage 10), `/api/style-chat` (stage 7), and a fourth conversation loop embedded in `agents/agent_2_outline.js` (1,427 lines).
4. Supporting issues: 38 sequential `conversationPrompt +=` mutations in one endpoint, SOP files `readFileSync`'d per request, RMW race on project JSON that can drop chat messages, hardcoded project data (I.M.A.G.I.N.E. tier lists in `agent_3_characters.js`, Dapple beat names in `stage_revision_kernel.js`), agent_9_coverage parsing JSON with no repair, two god files (server.js 7.4k lines, app.js 10.5k lines).

## The core architectural change (Phase 1)

Replace the flag envelope with **native tool calling** (supported by both Anthropic and Gemini APIs), using the **client-executed tool pattern**:

```
Writer message
  → POST /api/assistant  (server builds context, calls model with tools)
  → Model returns either:
      (a) text             → done; reply shown, conversation persisted
      (b) apply_revision({revision_brief})  → server returns {type:'tool_call', turnState}
            → Browser executes the EXISTING executeRevision machinery
              (DOM scrape, SSE consume, render, approve-button reset — unchanged)
            → Browser POSTs tool result (receipt or error) + turnState back
            → Model sees the real receipt, writes its closing message
```

Why client-executed: the existing `executeRevision` callbacks legitimately live in the browser
(they scrape the rendered artifact as the revision input, consume SSE streams, re-render, and
manage button state). Moving execution server-side would require extracting five large endpoint
bodies AND changing the "current artifact = DOM" semantics in one step. The client-tool pattern
gets the full benefit — the model only says "done" after seeing a real receipt, failures are
visible to the model, no flags, no regexes, no synthetic marker — with minimal blast radius.

`turnState` is an opaque JSON blob (the in-flight neutral-format message list) round-tripped
through the client so the server stays stateless across the two HTTP legs of a tool turn.

### What gets deleted once a stage is migrated
- `suggest_plan` / `execute_immediately` handling for that stage
- `pendingRevision` / `pendingNotes` state and `isRevisionConfirmation` gating
- per-stage direct-revision regexes (`isStageNDirectRevisionRequest`)
- `buildRevisionNotes` scaffolding (the model writes a self-contained `revision_brief`)
- `postRevisionFollowUp` + the `[Revision applied successfully]` synthetic marker
- the Execution Boundary / banned-phrases sections of the SOP (the failure mode can't occur)

### New files (Phase 1)
- `agents/ai-client.js` — add `chatWithTools()` with a neutral message format translated to
  Anthropic tool_use/tool_result blocks or Gemini functionDeclarations/functionCall/functionResponse.
- `agents/assistant.js` — unified assistant turn runner + per-stage declarative config
  (stage name, available tools, context fragments, entry-analysis prompts).
- `skills/skill_assistant_core.md` — editorial SOP for the tool-based assistant. Derived from
  `skill_brainstorm.md` minus the Execution Boundary / flag-output sections, plus a Tools section.
  Cached at module load. `skill_brainstorm.md` was removed after cutover.
- `POST /api/assistant` in server.js. Pilot was **Stage 5 (Treatment)**; the route now serves active stage/global chat surfaces.
- Frontend: stage chat routes through the tool assistant; the old `TOOL_ASSISTANT_STAGES` cutover flag was removed after all active consumers migrated.

### Rollout order
1. Pilot Stage 5; Carsten tests conversationally. **Done.**
2. Stages 2, 3, 4, 6 (same shape; stage-specific context fragments carried over). **Done for routing + guardrail carry-over; needs live conversational smoke on real projects.**
3. Stage 1 (refine-pitch as the tool), Stage 7 (tool = `generate_style`), then fold Stage 10
   (`/api/brainstorm-rewrite` becomes config: priority-list context + `apply_priority_rewrite` tool)
   and Stage 7's `/api/style-chat`. **Stage 1, project Stage 7, Stage 8, Stage 10 planning chat, and global style creation are done.**
4. Delete `/api/brainstorm`, `/api/brainstorm-rewrite`, `/api/style-chat`, the regex layer,
   and the embedded loop in agent_2_outline (its revision path stays; its conversation logic goes). **Done.**

### Conversation persistence compatibility
The new endpoint persists to the same `projectData.data.conversations.stageN` shape
(user/assistant text only — tool calls are not stored) via `persistStageConversation()`,
so history restore, prior-stage context injection, and the legacy stages keep working unchanged.

### Carried-over behaviors (re-implemented as context fragments, not code branches)
- Stage entry analysis (isInit) for stages 5/6/7
- Decision cadence checkpoint (exchange-count based)
- Knowledge context block, prior-stage conversations, attachments
- Stage 4 deterministic bypasses moved into `/api/assistant` as pre-model short-circuits.

### Codex continuation notes — 2026-06-13
- Stage 5 check found and fixed one contract leak: a no-op revision receipt (`changed: false`) is now treated as a failed tool turn, so tools are withheld on the resume leg and the assistant must report the failure.
- `/api/assistant` now carries memory recall, Stage 4 current-event/current-artifact guardrails, Stage 4 confirmation short-circuit as a real `apply_revision` tool call, Stage 6 source-comparison/external-feedback modes, source-location grounding, and scoped-polish scope locks.
- `TOOL_ASSISTANT_STAGES` was expanded to `[2, 3, 4, 5, 6]` in the first pass.
- Build fingerprint loading was corrected to use the unwrapped `nativeFetch('/health')`, matching the Phase 0 safety-rail test.
- Verified: `node --check agents/assistant.js agents/tool_messages.js agents/ai-client.js server.js public/app.js`, `node --test test/assistant_tool_loop.test.js`, and `npm run test:knowledge` (110 tests).

### Codex continuation notes — 2026-06-13 (second pass)
- Stage 1 now routes through `/api/assistant` and uses the existing `apply_revision` browser executor for pitch refinement.
- Project Stage 7 now routes through `/api/assistant` with a first-class `generate_style` tool; its proactive 3-writer opening message and saved-style context are carried over.
- The browser tool loop now supports both `apply_revision` and `generate_style`, returning tool-specific receipts to the model before the closing message.
- Remaining Phase 2 work: selected-scene Stage 10 feedback cleanup if desired and embedded `agent_2_outline` conversation-loop cleanup.

### Codex continuation notes — 2026-06-13 (third pass)
- Stage 10 no-scene-selected planning chat now routes through `/api/assistant` with a `generate_rewrite_plan` tool.
- The browser executes `generate_rewrite_plan` through the existing `/api/plan-rewrite` flow, renders the plan card, and returns affected-scene/strategy receipt data before the model writes its closing message.
- Stage 10 conversations still persist to `conversations.stage9` for compatibility with existing project data and frontend hydration.
- Selected-scene Stage 10 feedback remains on the direct `/api/rewrite-scene-feedback` endpoint because it is already an explicit scene rewrite action, not an assistant planning chat.

### Codex continuation notes — 2026-06-13 (fourth pass)
- Global style creation now routes through `/api/assistant` with `stageId: "style_global"` and the existing `generate_style` browser tool executor.
- The standalone style assistant carries existing style-library names plus project pitch context, but does not require or persist to a project conversation.
- The create-style modal no longer calls `/api/style-chat` or consumes `execute_immediately`; it waits for the real saved-style receipt before opening the new style detail.
- Legacy `/api/style-chat` remained in the server only until the explicit deletion pass.

### Codex continuation notes — 2026-06-13 (fifth pass)
- Stage 8 Draft chat now routes through `/api/assistant` with `apply_revision`, passing the active `currentDraftSceneNumber` so the model sees and revises the selected scene.
- Frontend `TOOL_ASSISTANT_STAGES`, `pendingRevision`/`pendingNotes`, local confirmation regexes, direct Stage 2/3/6 revision detectors, `buildRevisionNotes`, and synthetic post-revision follow-up scaffolding were removed.
- Server `/api/brainstorm`, `/api/brainstorm-rewrite`, and `/api/style-chat` were deleted after the last active consumer migrated.
- `skill_brainstorm.md` was removed; active assistant behavior now lives in `skill_assistant_core.md`.
- Remaining cleanup target from Fabel 5's Phase 2 list after this pass: selected-scene Stage 10 cleanup if desired.

### Codex continuation notes — 2026-06-13 (sixth pass)
- `agent_2_outline` no longer parses old frontend transcript bundles (`LATEST USER REQUEST`, `RECENT CONVERSATION CONTEXT`, confirmation handoffs) to recover a revision request.
- Stage 2 outline revision still accepts a self-contained revision brief and keeps its surgical revision path, checklist repair, deterministic patching, and post-revision safeguards.
- Prompt regressions were updated to exercise the tool-assistant contract: the assistant sends the concrete Stage 2 revision brief directly.
- Remaining Phase 2 cleanup, if desired before Phase 3: selected-scene Stage 10 feedback cleanup; it is currently an explicit `/api/rewrite-scene-feedback` action rather than a planning chat.

---

## Phase 0 — Safety rails (hand-off-able, ~half day)
1. **Build fingerprint**: `/health` already returns BUILD_COMMIT/BUILD_DEPLOYMENT_ID (server.js:183-184).
   Add a build timestamp, surface commit+timestamp in the UI footer and Settings modal, and stamp it
   into DOCX export metadata. Ends "is my code even running" sessions.
2. **Cache skill files**: replace per-request `readFileSync` of skills/*.md (server.js:4865, 5065, 5520,
   6035, 6322 + 13 call sites in agents/) with a small memoized `loadSkill(name)` util (`utils/skills_cache.js`).
3. **JSON repair for coverage**: `agents/agent_9_coverage.js` does raw `JSON.parse(response.text)`;
   route it through `agents/json_parse.js::parseJsonWithRepair` like agent_4 does.
4. Commit baseline before any of this (working tree is clean except this spec).

## Phase 2 — Finish assistant unification (Claude, after Phase 1 pilot validates)
See rollout order above: remaining stages, Stage 10, style-chat, agent_2 loop removal, SOP cleanup.

## Phase 3 — De-hardcode project data (schema by Claude, implementation hand-off-able)
1. Move character tier assignments out of `agents/agent_3_characters.js` into project JSON:
   `data.stage3_characters.tier_overrides = { "<name>": 1|2|3 }`. Normalization reads overrides
   first, then falls back to structure-based inference (cameo_profile→3, functional_profile→2).
2. One-off migration script seeds the I.M.A.G.I.N.E. project's overrides from the current hardcoded lists.
3. UI: tier selector on character cards already exists — wire it to write `tier_overrides`.
4. Remove Dapple-specific beat names/regexes from `utils/stage_revision_kernel.js`; protected
   beats become `data.stage2_outline.protected_beats: [labels]`, editable via Stage 2 UI.
5. Mirror: frontend `projectTierForCharacterName()` reads overrides from `window.currentProjectData`
   instead of a hardcoded list.

### Codex continuation notes — 2026-06-13 (Phase 3 first pass)
- Stage 3 character tiering now reads `data.stage3_characters.tier_overrides` in both `agent_3_characters.js` and `public/app.js`.
- `/api/generate-characters` accepts/persists `tierOverrides`; the browser writes override maps when tiers are toggled, saved, approved, or sent through chat revisions.
- The Stage 3 agent prompt no longer embeds the I.M.A.G.I.N.E. character tier lists; project-specific tier guidance is generated only from project JSON overrides.
- The one-off I.M.A.G.I.N.E. migration utility now exists at `scripts/seed-stage3-tier-overrides.js` (`npm run migrate:stage3-tiers -- --write` to persist; dry-run by default).

### Codex continuation notes — 2026-06-13 (Phase 3 protected beats)
- `utils/stage_revision_kernel.js` no longer embeds Dapple/ending beat labels or default descriptions; deterministic protected-beat behavior now comes from `protectedBeats` / `data.stage2_outline.protected_beats`.
- `/api/generate-outline` accepts `protectedBeats`, passes them into `applyStageRevisionPlan`, and persists `protected_beats` alongside the Stage 2 outline.
- Stage 2 beat cards expose a shield toggle; manual saves, revisions, chat revisions, and regeneration preserve/send the label list.
- Remaining Phase 3 cleanup: run the Stage 3 tier migration when ready to mutate saved project JSON; consider a Stage 2 protected-beat seed/migration for existing projects if desired before broad production use.

## Phase 4 — Structural cleanup (hand-off-able; do AFTER Phase 2 deletes code)
1. Extract shared generation-endpoint factory for stages 2–6 (~70% duplicated scaffolding:
   read project → validate → source packet → agent call → revision transaction → stamp → save → trackUsage).
2. Split server.js into route modules: routes/generation.js, routes/assistant.js, routes/knowledge.js,
   routes/styles.js, routes/export.js, routes/projects.js. Helpers to utils/.
3. Frontend: extract approve-button state helper (~30 duplicated sites), shared approve-handler factory.

### Codex continuation notes — 2026-06-13 (Phase 4 frontend pass)
- Added `setApproveButtonState()` in `public/app.js` and migrated low-risk approve-state call sites around project hydration/restores, Stage 1, Stage 2, Stage 3-5, source-audit revisions, and Stage 2-5 chat resets.
- Stage 6/8 and the custom Stage 7/9/10 approval flows now use the shared state helper too; the next frontend cleanup is extracting a shared approve-handler factory from the now-normalized stage approve handlers.
- Added `createStageApproveHandler()` and migrated Stage 2-6 plus Stage 8 approval saves onto the shared guard/snapshot/version/PUT/curation/state flow; Stage 7 style and Stage 10 rewrite approval remain custom flows.
- Server generation cleanup started: added shared project-context loading for Stage 2-6 generation endpoints and shared artifact finalization for Stage 2-6, including Stage 2's post-save outline verification hook.

## Phase 5 — Data safety & reliability (hand-off-able, well-specified)
1. **RMW race**: in `updateProjectJSON()` (server.js:120-130), move the read inside
   `withProjectWriteLock()` so read-modify-write is atomic per project. Audit call sites that
   mutate a stale `projectData` captured before the lock (notably `persistStageConversation`).
2. **Stage 8 auto-save**: surface failures (toast/banner + retry), don't fire-and-forget.
3. **Verify Stage 10 pending-rewrite hydration** survives reload (March fix may have broken in renumbering).
4. Typed error classes + correct HTTP codes (400/404/429/500) instead of blanket 500s.
5. Streaming endpoints: handle `res.on('close')` to stop work on client disconnect.

### Codex continuation notes — 2026-06-14 (Phase 5 RMW pass)
- `updateProjectJSON()` already performs its read inside `withProjectWriteLock()`; `persistStageConversation()` now uses it so assistant chat history merges into the latest project JSON instead of writing a stale request snapshot.
- Stage 10 init cleanup of `characterChangeContext` now uses `updateProjectJSON()` as well. Remaining stale-write audit candidates are larger artifact/source save paths and should be handled in focused endpoint-specific passes.

### Codex continuation notes — 2026-06-15 (Phase 5 Stage 8 auto-save)
- Stage 8 draft auto-save is now awaitable, leaves dirty edits dirty until the server save succeeds, shows a retry banner on failure, and blocks scene switching / Stage 8 approval while the save is unresolved.

### Codex continuation notes — 2026-06-16 (Phase 5 Stage 10 pending rewrites)
- Stage 10 pending rewrites now rehydrate with an explicit saved-text cache, selected-scene feedback persists its proposed text to `stage9_rewrites.pending`, manual edits to pending rewrites auto-save through `/api/save-stage10-pending`, and scene switching / priority approval / finalization wait for unresolved pending saves.
- Stage 10 pending, priority approval, and finalization writes now use `updateProjectJSON()` so long-running rewrite work merges into the latest project JSON instead of writing a stale request snapshot.

### Codex continuation notes — 2026-06-17 (Phase 5 streaming disconnects)
- Stage 2/4/5/6 streaming generation and Stage 6 streaming revision now attach a close-aware abort tracker; if the browser disconnects, in-flight model calls receive an abort signal and the route stops before writing late results to project JSON.
- `agents/ai-client.js` now passes abort signals through Gemini and Anthropic calls, including long Claude streamed requests, and normalizes SDK aborts as `CLIENT_DISCONNECTED` so agent retry loops do not retry intentional client disconnects.

### Codex continuation notes — 2026-06-17 (Phase 5 typed API errors)
- Added typed API errors (`BadRequestError`, `NotFoundError`, `RateLimitError`) plus a shared JSON responder that exposes intentional 4xx messages and keeps unexpected 5xx details behind fallback text.
- Migrated rate limit responses, project CRUD/import routes, project knowledge load, and project source upload/asset/delete/update routes onto the shared responder; source helper failures now throw typed 400/404 errors instead of hand-setting `statusCode`.

### Codex continuation notes — 2026-06-18 (Phase 5 typed API errors, style/export pass)
- Migrated Stage 7 style generation, preview, selection, trained-style creation, and style CRUD routes onto typed 400/404 errors plus the shared API responder.
- Export helpers and DOCX/PDF export routes now use `readProjectJSONById()` and typed `BadRequestError` failures for missing stage data, unknown export stages, and empty screenplay exports while preserving binary responses on success.

### Codex continuation notes — 2026-06-19 (Phase 5 typed API errors, memory route pass)
- Migrated project memory decision, accepted divergence, stage curation, handoff refresh, diagnostics, compact/review, and source-bible rebuild routes onto typed validation errors and the shared API responder.
- Memory routes now reuse `readProjectJSONById()` or `assertProjectExists()` instead of hand-reading project files and returning ad hoc 400/500 JSON responses.

### Codex continuation notes — 2026-06-19 (Phase 5 typed API errors, Stage 1 pass)
- Migrated Stage 1 pitch generation and pitch refinement routes onto `readProjectJSONById()`, typed validation errors, and `sendApiError()` while preserving projectless random pitch generation.

### Codex continuation notes — 2026-06-19 (Phase 5 typed API errors, Stage 3 pass)
- Added an opt-in typed-error mode to `prepareGenerationProjectContext()` and migrated Stage 3 character generation onto it, preserving the shared generation context path while routing invalid project IDs, missing projects, missing prerequisites, and unexpected failures through typed API errors.

### Codex continuation notes — 2026-06-20 (Phase 5 typed API errors, Stage 4/5 streaming prep pass)
- Migrated Stage 4 beat generation and Stage 5 treatment pre-stream project/prerequisite validation onto the typed generation context path; validation failures now return shared JSON API errors before SSE headers are flushed, while in-flight model failures still report through SSE error packets.

### Codex continuation notes — 2026-06-20 (Phase 5 typed API errors, Stage 6 blueprint pass)
- Migrated Stage 6 scene-blueprint generation pre-stream validation and Stage 6 blueprint revision validation/project loading onto typed API errors and shared project loading.
- Non-stream Stage 6 revision failures now use `sendApiError()`, including an explicit exposed `NO_BLUEPRINT_CHANGES` API error, while streamed revision/generation failures still report through SSE error packets after headers are flushed.

### Codex continuation notes — 2026-06-20 (Phase 5 typed API errors, Stage 8 draft pass)
- Migrated Stage 8 draft generation, draft revision, and continuity resolution routes onto typed validation/not-found errors, shared project loading, and `sendApiError()` while preserving existing validation messages.
- Draft routes now reuse `findProjectScene()` instead of hand-scanning scene arrays in each endpoint.

### Codex continuation notes — 2026-06-20 (Phase 5 typed API errors, Stage 9 coverage pass)
- Migrated Stage 9 coverage generation onto typed validation errors, shared project loading, and `sendApiError()` while preserving existing approval/blueprint/draft validation messages.

### Codex continuation notes — 2026-06-20 (Phase 5 typed API errors, Stage 10 state pass)
- Migrated Stage 10 rewrite initialization, pending rewrite save, priority approval, and finalization routes onto typed validation/not-found errors and `sendApiError()`.
- Stage 10 state mutation routes now check project existence before `updateProjectJSON()` so missing projects return intentional 404s.

### Codex continuation notes — 2026-06-20 (Phase 5 typed API errors, Stage 10 rewrite pass)
- Migrated Stage 10 rewrite planning, priority batch rewrites, single-scene rewrites, and selected-scene feedback rewrites onto typed validation/not-found errors and `sendApiError()`.
- Stage 10 rewrite routes now use shared project loading, and single-scene rewrites reuse `findProjectScene()` instead of hand-scanning Stage 6 scene arrays.

### Codex continuation notes — 2026-06-20 (Phase 5 typed API errors, assistant route pass)
- Migrated the unified `/api/assistant` route onto typed project/stage validation, shared project loading, and `sendApiError()` while preserving the projectless global style assistant path.
- Stage IDs are validated before assistant context construction, so unknown stages return intentional 400s without swallowing unrelated context-building failures.

### Codex continuation notes — 2026-06-20 (Phase 5 typed API errors, Stage 2/helper pass)
- Migrated Stage 2 outline pre-stream validation and non-stream failures onto typed API errors and `sendApiError()` while preserving SSE error packets after streaming starts.
- Simplified `prepareGenerationProjectContext()` so it always throws typed validation/not-found errors instead of optionally writing ad hoc 400/404 responses.

## Phase 6 (later, optional) — Frontend state
Stop using the DOM as the source of truth: in-memory project state object, render-from-state,
edit-state-directly; retire the four scrape functions. Large; only worth it if PageOne keeps growing.

---

## Verification per phase
- Phase 1: `node --check` on all touched files; unit test for the neutral⇄provider message
  translators (`test/assistant_tool_loop.test.js` with a mocked provider); manual conversational
  test on Stage 5 (Carsten): brainstorm → confirm → revision applies → model's closing message
  reflects the real receipt; failure path: kill the revision endpoint and confirm the assistant
  reports the failure instead of claiming success.
- Existing suites must stay green: `node --test test/prompt_regression.test.js`, `npm run test:knowledge`.
