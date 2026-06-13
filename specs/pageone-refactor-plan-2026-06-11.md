# PageOne Refactor Plan — 2026-06-11

Author: Claude (Fable 5), based on full-codebase audit 2026-06-11.
Status: Phase 1 pilot validated and Phase 2 stage rollout started. Stages 2, 3, 4, 5, and 6 now route through the tool-calling assistant; legacy chat routes remain for unmigrated stages.

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
  Cached at module load. `skill_brainstorm.md` stays untouched for legacy stages.
- `POST /api/assistant` in server.js (additive; `/api/brainstorm` untouched until cutover).
- Frontend: `TOOL_ASSISTANT_STAGES` set in app.js; member stages route through the new
  endpoint/handler. Pilot: **Stage 5 (Treatment)** — single clean revision path, has entry analysis.

### Rollout order
1. Pilot Stage 5; Carsten tests conversationally. **Done.**
2. Stages 2, 3, 4, 6 (same shape; stage-specific context fragments carried over). **Done for routing + guardrail carry-over; needs live conversational smoke on real projects.**
3. Stage 1 (refine-pitch as the tool), Stage 7 (tool = `generate_style`), then fold Stage 10
   (`/api/brainstorm-rewrite` becomes config: priority-list context + `apply_priority_rewrite` tool)
   and Stage 7's `/api/style-chat`.
4. Delete `/api/brainstorm`, `/api/brainstorm-rewrite`, `/api/style-chat`, the regex layer,
   and the embedded loop in agent_2_outline (its revision path stays; its conversation logic goes).

### Conversation persistence compatibility
The new endpoint persists to the same `projectData.data.conversations.stageN` shape
(user/assistant text only — tool calls are not stored) via `persistStageConversation()`,
so history restore, prior-stage context injection, and the legacy stages keep working unchanged.

### Carried-over behaviors (re-implemented as context fragments, not code branches)
- Stage entry analysis (isInit) for stages 5/6/7
- Decision cadence checkpoint (exchange-count based)
- Knowledge context block, prior-stage conversations, attachments
- Stage 4 deterministic bypasses stay in the legacy endpoint until Stage 4 migrates;
  when it does, the bypasses move into the new endpoint as pre-model short-circuits (unchanged logic).

### Codex continuation notes — 2026-06-13
- Stage 5 check found and fixed one contract leak: a no-op revision receipt (`changed: false`) is now treated as a failed tool turn, so tools are withheld on the resume leg and the assistant must report the failure.
- `/api/assistant` now carries memory recall, Stage 4 current-event/current-artifact guardrails, Stage 4 confirmation short-circuit as a real `apply_revision` tool call, Stage 6 source-comparison/external-feedback modes, source-location grounding, and scoped-polish scope locks.
- `TOOL_ASSISTANT_STAGES` is now `[2, 3, 4, 5, 6]`.
- Build fingerprint loading was corrected to use the unwrapped `nativeFetch('/health')`, matching the Phase 0 safety-rail test.
- Verified: `node --check agents/assistant.js agents/tool_messages.js agents/ai-client.js server.js public/app.js`, `node --test test/assistant_tool_loop.test.js`, and `npm run test:knowledge` (110 tests).

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

## Phase 4 — Structural cleanup (hand-off-able; do AFTER Phase 2 deletes code)
1. Extract shared generation-endpoint factory for stages 2–6 (~70% duplicated scaffolding:
   read project → validate → source packet → agent call → revision transaction → stamp → save → trackUsage).
2. Split server.js into route modules: routes/generation.js, routes/assistant.js, routes/knowledge.js,
   routes/styles.js, routes/export.js, routes/projects.js. Helpers to utils/.
3. Frontend: extract approve-button state helper (~30 duplicated sites), shared approve-handler factory.

## Phase 5 — Data safety & reliability (hand-off-able, well-specified)
1. **RMW race**: in `updateProjectJSON()` (server.js:120-130), move the read inside
   `withProjectWriteLock()` so read-modify-write is atomic per project. Audit call sites that
   mutate a stale `projectData` captured before the lock (notably `persistStageConversation`).
2. **Stage 8 auto-save**: surface failures (toast/banner + retry), don't fire-and-forget.
3. **Verify Stage 10 pending-rewrite hydration** survives reload (March fix may have broken in renumbering).
4. Typed error classes + correct HTTP codes (400/404/429/500) instead of blanket 500s.
5. Streaming endpoints: handle `res.on('close')` to stop work on client disconnect.

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
