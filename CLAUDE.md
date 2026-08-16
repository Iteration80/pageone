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
- **Numeric contracts must live in the schema, not only the prompt.** A count stated to the model and never enforced in code has produced four separate bugs (Stage 1's three pitches, Stage 6 `total_estimated_pages`, `stage4_beats`, Stage 3's silently-dropped profile fields). When a prompt or SOP names a count, an enum, or a required field, put it in the schema too.
  ⚠️ **Gemini rejects `minItems`/`maxItems` on an array whose ITEMS schema itself contains an array** — bare `INVALID_ARGUMENT` at request time, and the whole request fails, not just the bound. Measured 2026-08-03: `pitch_options` and Stage 2 `beats` (flat items) accept it; Stage 2 `act_1/2/3` and Stage 3 `characters` (items contain arrays) do not. **Always verify a schema edit with one real request** — this class cannot be caught by any local test.
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
npm test                          # all suites (route harness, assistant tool loop, prompt regression, knowledge, memory)
npm run test:knowledge
```
(Note: bare `node --test test/` fails with an opaque single "test failed" on this Node version — `npm test` uses the glob form.)

**Route-invocation harness — `test/helpers/route_harness.js`.** `startTestServer({ env })` boots the real app (server.js exports `app` and only listens under `require.main === module`) on an ephemeral port against a throwaway `DATA_ROOT`, and returns a `request()` client that makes real HTTP calls. It re-requires the first-party module graph per call, so env captured at module load (`APP_SECRET`, `DATA_ROOT`) can differ per test — that is what lets one file exercise open / secret / google mode. **Reach for this whenever a change touches a route.** Source-string tests have missed three production bugs (`794c332`, `f923414`, the Stage 1 pitch loss); all three would have been caught by one real request. `test/auth_routes.test.js` is the worked example.

All suites must stay green. After frontend changes, also do a browser pass — the June gear-icon bug was invisible to syntax checks and curl; drive the real UI.

---

## Deployment Notes

### Authentication (Google session + access tokens + `APP_SECRET`)
API auth is layered and each layer is dormant unless configured:

1. Google sign-in is active only when `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `ALLOWED_EMAILS` are set. The server issues a signed `pageone_session` cookie after a successful Google OAuth callback, and `ALLOWED_EMAILS` is rechecked on every request.
2. **Personal access tokens** (`pgo_…`) for scripts and CLI use — minted in Settings → Access Tokens from a live Google session, stored as SHA-256 hash + metadata in `<DATA_ROOT>/access-tokens.json`, sent as `X-Api-Key` or `Authorization: Bearer`. A token carries its owner's email and is re-checked against `ALLOWED_EMAILS` on every request, so removing an address kills that person's tokens instantly without anyone revoking them.
3. `APP_SECRET` remains the break-glass/admin credential even when Google auth is primary. API requests can use `X-Api-Key: <APP_SECRET>` or `Authorization: Bearer <APP_SECRET>`. It is the one credential that resolves to no email; keep it in Railway env only, never on a laptop.
4. If none of the above is configured, local development runs open.

⚠️ **Every credential type must resolve to an email and re-check `ALLOWED_EMAILS` per request.** The allowlist is the deployment's kill switch — it has to sever access through every door at once, without anyone tracking which credentials a given person holds. An anonymous credential added to `requireAuth` breaks the multi-user identity model outright; `APP_SECRET` is the single deliberate exception.

⚠️ **A token cannot manage tokens.** `/api/tokens` is guarded by a session-only check inside `routes/tokens.js`, not by `requireAuth` — otherwise one leaked token could mint its own successors and revoke the real ones, surviving revocation of the credential that leaked.

**Identity is also carried in the async context.** `requireAuth` calls `next()` inside `runWithIdentity` (`utils/request_identity.js`), which is what lets the project-ownership chokepoints know who is asking without every route passing it down. `session` and `token` are scoped to a person; `secret` (break-glass) and `open` (unconfigured dev) are not, and both see every project deliberately.

⚠️ **multer loses that context.** It calls back from a stream event on the request socket — an async resource created *before* `requireAuth` ran — so without a re-entry the handler runs as a trusted system call and the chokepoints wave it through. `upload` in server.js is therefore a wrapper (`preserveIdentity`) that re-enters the identity `admit` stashed on `req`; use it, never `multer(...)` directly. Found 2026-08-16 (a cross-user multipart `POST /api/execute` returned 200); pinned by a probe-route test in `test/project_ownership.test.js`. Any future middleware that calls back from a foreign async resource needs the same wrap.

**Shared vs private resources (multi-user Phase 3).** Styles go through `utils/style_store.js`: bundled styles (`data/styles` in the repo, seeded into `DATA_ROOT/styles`) are the shared library — visible to everyone, editable by no one signed in (403); user-created styles carry `owner:` in their front matter, stamped by the server at creation, and are visible/editable only to their creator (404 otherwise, never 403). **Unowned user styles fail closed** exactly like unowned projects, so a deployment with user-created styles needs `POST /api/maintenance/style-owners/stamp` (admin) right after the Phase 3 deploy — same shape as the project-owner migration. ⚠️ "Bundled" is decided by filename against `BUNDLED_STYLES_DIR`, not by the `tier:` line — the bundle ships two trained styles and one conversational one. AI rate limits (`aiLimiter`/`strictLimiter`) are keyed to `req.userEmail`, falling back to IP only for break-glass/open; every mount is `requireAuth, <limiter>` in that order — keep it. `GET /api/usage` is the caller's spend rollup across their projects (tokens; the client prices them); `GET /api/maintenance/usage` is every owner's, admin-only.

Split by kind, not by sensitivity: `utils/auth.js` and `utils/tokens.js` own every decision about whether a request is authenticated (config gating, session signing/verification, cookie parsing, token hashing and expiry, the live allowlist check); `routes/auth.js` and `routes/tokens.js` only wire those decisions to URLs. Route-level coverage is `test/auth_routes.test.js` and `test/access_tokens.test.js`.

Set `SESSION_SECRET` for session signing, or let it fall back to `APP_SECRET`. Deployed tester builds should keep `APP_SECRET` set even with Google enabled so maintenance scripts and recovery access still work. The public frontend reads `GET /api/auth-config` before booting so it can show either the Google button, the access-key form, or no auth overlay.

⚠️ `ANTHROPIC_API_KEY` is **deliberately unset** in local `.env` (commented out 2026-08-02). The key that was there returned 401, so selecting any Claude model in Settings failed opaquely; with no key at all the failure is honest. All stages run Gemini. Add a working key to that line to re-enable the Claude models. Production sets its own key via Railway env vars — this note is about the local file.

### Process rule
**One AI coding session per working tree at a time; commit between sessions.** Concurrent uncommitted edits to `server.js`/`public/app.js` caused the June 11 closure-scope collision.

---

## Recent Changes
*Keep last 2–3 weeks here. Archive older or superseded entries to `CHANGELOG-archive.md`.*

### 2026-08-16 — Multi-user Phase 3: shared vs private styles, per-user limits and spend
**Styles.** Every read and write of a style file now goes through `utils/style_store.js` — fourteen direct `STYLES_DIR` reads across server.js and routes/styles.js served every style to every signed-in user (verified in a browser 08-11: a tester saw Carsten's trained styles). Bundled styles are the shared library (visible to all, 403 on PUT/DELETE for anyone signed in); user-created styles are stamped `owner:` at creation on both create paths (directive AND reference for trained styles) and are 404 to anyone else — listing, `GET/PUT/DELETE /api/styles/:slug`, `select-style`, `preview-style-scene`, the draft-time `loadProjectStyle`, the sync readiness reader, and both assistant "saved styles" scans. A PUT re-applies server-owned provenance (`slug/owner/created/project_id`) from disk, so an edit cannot rename, disown or re-own a style. **Unowned user styles fail closed**; migration = `npm run migrate:style-owners` or `GET/POST /api/maintenance/style-owners/{audit,stamp}` (admin, defaults to the signed-in email, fills blanks only, never touches the bundle — decided by filename against `BUNDLED_STYLES_DIR`, not by tier). Rehearsed end to end on a copy of the real store under two identities. UI: Edit/Delete hidden and "Shared library style — read-only" shown for the bundle; a "Shared" chip on bundled non-preset cards.
**Limits.** `aiLimiter`/`strictLimiter` key on `req.userEmail` (IP only for break-glass/open). **Spend.** `usageRollup()` sums `apiUsage` per owner; `GET /api/usage` (own) + `GET /api/maintenance/usage` (admin); the project spend modal now ends with the account-wide total.
17 + 5 route-harness tests (`test/style_ownership.test.js`, `test/per_user_limits_usage.test.js`), each guard verified to fail the suite when removed (13 / 4 / 1 / 1 / 1 — distinct signatures), plus a completeness walk of the live route table for `/style/`.
⚠️ Slug uniqueness stays global (filenames) — a tiny "slug is taken" oracle, documented above `styleSlugExists`. ⚠️ Local dev needs no migration; `data/styles` IS the bundle there, so everything is shared and open mode sees it all.

### 2026-08-16 — Cross-tenant fix: identity survives multer
Nine multipart routes (`/api/execute`, `refine-pitch`, `generate-outline`, `generate-characters`, `generate-stage5-treatment`, both style generators, `import-script`, knowledge source upload) ran their handlers with **no identity** — multer calls back from a socket stream event created before `requireAuth` entered the context — so the Phase 2 chokepoints saw a system call and trusted it. Proven by test before fixing: Bob's multipart `POST /api/execute` with Alice's `projectId` returned **200 and generated a pitch into her project**. `upload` is now a wrapper whose middlewares re-enter the identity `admit` stashes on `req.identity`; two new tests in `test/project_ownership.test.js` (all seven body-projectId multipart routes both directions, plus a probe route that reads the identity inside a multer callback). Also: the route harness now blanks `GEMINI_API_KEY`/`ANTHROPIC_API_KEY`/`GEMINI_MODEL` by default — the developer's `.env` was leaking in, and a route that got past its guards spent real money silently (the only clue was a 20-second test).

### 2026-08-11 — Multi-user Phase 2: project ownership + isolation
Every project carries an `owner` email, stamped at creation on both creation paths (`/api/projects` and `/api/import-script`). Enforcement is at the **chokepoints, not the routes**: `readProjectJSONById`, `updateProjectJSON` and `writeProjectJSON` in server.js. There are ~110 project call sites across 8 route modules, and a per-route check means a new route can opt out by forgetting one — which would look completely ordinary in review.

The caller is carried in an **AsyncLocalStorage** context (`utils/request_identity.js`) entered by `requireAuth`, so the chokepoint reads the identity itself and no route has to pass it. 12 route-harness tests with two signed-in identities; all four guards were verified to fail the suite when removed (disabling the ownership check fails 6, read-guard-only fails 4, listing filter fails 3, admin gate fails 1).

⚠️ **`next()` is called INSIDE `runWithIdentity`.** Moving it out would leave every request looking like a trusted system call, and no test can tell that apart from "the user owns everything."

⚠️ **UNOWNED PROJECTS FAIL CLOSED** — denied to everyone, including their real owner. Treating "no owner" as "everyone's" is the silent hole this phase closes, so the migration is a hard ordering requirement on any deployment with existing data.

**On a deployment, run it over HTTP** (same pattern and same reason as the Stage 3 seed above — a migration you can't run without shell access is a migration that doesn't happen). This is what makes Phase 2 a one-step deploy: the gap where every project 404s is one authenticated request wide.
```
GET  /api/maintenance/project-owners/audit   # coverage report, never writes
POST /api/maintenance/project-owners/stamp   # owner defaults to the signed-in admin
```
Both are `requireAdmin`. The stamp **only fills in blanks** — it never reassigns a project that already has an owner, so it cannot be used to take someone else's work.

Locally, or with shell access:
```
npm run migrate:project-owners -- --verify                              # gate: 0 unowned
npm run migrate:project-owners -- --owner you@example.com               # dry run
npm run migrate:project-owners -- --owner you@example.com --write
```
Honours `DATA_ROOT`, so on Railway it targets the volume with no `--dir`. `--verify` exits non-zero while any project is unowned. Rehearsed end to end on a copy of the real 10-project store, and the HTTP path is covered by a test that walks the whole sequence: unowned → everything 404s → one POST → visible again.

⚠️ **Local dev needs no migration.** With Google auth unconfigured the server runs open, ownership enforcement is inert, and unowned projects open normally.

**404, never 403, for a project you don't own** — a 403 confirms the project exists, which is a cross-tenant disclosure to anyone who can guess an id. A non-owner cannot distinguish an existing project from an absent one.

**Two cross-tenant leaks found in the route audit and closed:** the `/api/maintenance/*` family swept every tenant's projects (two of them writing) behind plain `requireAuth`, and the global style creator fed **every** project's title, genre and logline into the prompt as "WRITER'S PROJECTS". Maintenance is now `requireAdmin`; the style context is owner-scoped. ⚠️ `isAdminEmail` (utils/auth.js) is **provisional** — the first address in `ALLOWED_EMAILS`. Phase 4 replaces it; it is the single place to change.

⚠️ Three helpers resolve project files directly rather than through the chokepoint — the project listing, the style-context scan, and (since Phase 3) `usageRollup` — so each carries its own owner filter. All are commented as such. Styles got their own chokepoint in Phase 3 (`utils/style_store.js`).

### 2026-08-11 — Multi-user Phase 1: personal access tokens
Scripts can now authenticate as a person instead of as the deployment. `utils/tokens.js` mints `pgo_` + 32 random bytes, stores SHA-256 + `{id, name, owner, created, lastUsed, expires}` in `<DATA_ROOT>/access-tokens.json`, and `requireAuth` grew one branch between the cookie and `APP_SECRET`. Settings → Access Tokens creates (shown once), lists with last-used, and revokes. 18 route-harness tests in `test/access_tokens.test.js`; both the new branch and the allowlist re-check were verified to fail the suite when removed.

Three real defects found while building it, all fixed and pinned:
- **`updateStore` rewrote the file even when the updater changed nothing**, giving every fire-and-forget `touchToken` a lost-update window over any concurrent write — it surfaced as a token that was minted with a 201 and then failed to authenticate. An updater now returns `false` for "no change" and no write happens. The store path is resolved once per update and passed to both halves, so a read and its write can never target different files.
- **Two overlapping `renderTokenList()` calls each appended to the same emptied list**, showing every row twice. The clear moved to after the fetch, plus a sequence counter so an overtaken render drops its result.
- `.modal-input` is `width:100%`; a non-shrinking `<select>` in a nowrap flex row crushed the name input to 18px. Needs `width:auto` on the select *and* `min-width:0` on the input.

⚠️ **A token cannot manage tokens** — `/api/tokens` is session-only on purpose (see the auth section). ⚠️ Token auth is inert unless Google sign-in is configured: a token authenticates *as an allowlisted email*, and with no allowlist there is no identity for it to be.

### 2026-08-09 — Live pagination (editor plan item 6) — THE EDITOR PLAN IS NOW FULLY BUILT
Stage 7's continuous view shows real page geometry (`1955a2a`): a "p. N" chip on every scene, a dashed rule where each page begins, and a live total in the header, updating as you type. **The numbers come from the exporter's own math by construction**: `parseFountain` + the whole layout walk moved to shared `public/screenplay-layout.js` (browser `<script>` + server `require`, same pattern as script-diff), and `generateScreenplayPdf` now just draws `layoutScreenplay`'s ops. `test/screenplay_layout.test.js` pins the math, the 1-line-per-element mapping the overlay relies on, and (by real invocation) that the PDF's physical page count equals the layout's plus the title page.

⚠️ **Never add a second pagination estimate anywhere** — the entire point of the shared module is that there is exactly one. ⚠️ **Page-numbering convention changed deliberately:** the title page is no longer counted; the first content page is page 1 and unnumbered (Final Draft convention). The pre-refactor exporter printed "2." on its first content page. Refactor parity was proven against the old exporter on a 118-page real script — every drawn op byte-identical except those labels. Also fixed en route: a raw NUL byte in `agents/export.js` made grep treat the file as binary and silently return nothing — if a grep over a source file returns nothing you *know* is there, check `file <path>`.

### 2026-08-09 — Stage 9 per-change accept/reject + restore-from-left (editor plan item 7)
The compare view's whole-scene rewrite is no longer all-or-nothing (`7144757`). Every change hunk — the same contiguous run the change navigation steps through — carries **✓ Keep / ✕ Reject** in the proposed pane, and the previous-state pane offers **↩ Restore** on each removed or replaced block (a deletion's only handle, since it has nothing to click on the right). Keep marks the hunk reviewed (counter shows `N changes · M kept`; content-keyed, session-only). Reject/Restore rebuild the pending text via new `ScriptDiff.mergeHunks`, write it through `stage10SetPending` + the pending-save queue, and reload the hidden editor so Edit mode can't resurrect the rejected text. `test/stage9_hunk_review.test.js` pins that chain structurally.

⚠️ **Rejecting a hunk must go through `mergeHunks`, never a raw line splice.** Blank lines are excluded from the diff but are load-bearing in Fountain; `mergeHunks` emits each line with the blank-line gap from *its own source*, and an unchanged line takes the original's gap when the previously emitted line was restored. `diffOps` in `script-diff.js` is now the single alignment used by annotations, word-diff pairing, hunks and merging — they cannot disagree about what "a change" is.

### 2026-08-07 — Stage 7/9 editor UX: the whole plan built except pagination
Implemented `specs/pageone-editor-ux-plan-2026-08-06.md` end to end. Assistant collapsed by default on the writing stages, **SmartType** (characters/locations/times/transitions, consulted before the Tab/Enter handlers), **undo/redo over structural edits** (`8e845ce`); **word-level diff + synced scroll + next/prev change nav** in Stage 9 via new `public/script-diff.js` (`e967814`); **selection-scoped AI editing** — select a passage, instruct it, diff, Accept/Reject — via the editor selection API and `POST /api/revise-selection` (`8eb9940`); **starred-draft export** with right-margin revision marks, `?marks=0` for the clean draft (`101f009`); and the **continuous script view** (`0d9146a`).

⚠️ **Continuous view is "continuous read, scoped edit" by decision, not by accident.** The whole drafted script renders continuously but **exactly one scene is editable**; the others are `innerHTML` only. Full continuous-editable would require re-splitting text back into per-scene records on save, whose failure mode is *text silently migrating between scenes* — the same silent-200 family this project has already paid for four times. Two invariants must hold or the design breaks silently: the editor is built on **`stage8EditorHost`, never on `draftEditorMount`**, and that host is **detached before the container is cleared**. `test/continuous_view.test.js` pins both.

⚠️ **Diffing screenplay text: exclude blank lines from the sequence.** Blanks are formatting and all identical, so with unequal paragraph counts the LCS is free to match any blank to any blank and will pick an alignment that drags the prose out of correspondence. This produced a wrong pairing that *looked* right in three successive screenshots. Also: LCS tables hold **prefix** lengths — backtrack backward.

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
