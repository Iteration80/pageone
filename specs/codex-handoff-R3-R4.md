# Codex Handoff — R3 + R4 (2026-07-03)

You are picking up the last two code items of a verified roadmap. Before writing any code, read:
1. `CLAUDE.md` — current architecture + conventions (rewritten 2026-07-03; it is accurate).
2. `specs/pageone-roadmap-2026-07-03.md` — R3 and R4 sections + status header.
3. `specs/pageone-refactor-plan-2026-06-11.md` — only if you need history.

Already done (do not redo): R1 local, R2 (JSON-repair hardening + guard test), R5 (docs).
Working tree must be clean when you start and when you finish. One logical change per commit.

## R3 — Server structural cleanup (do first)

**R3a — Finish the generation-endpoint factory (stages 2–6).**
Build on the helpers you already started: `prepareGenerationProjectContext()` and the shared
artifact-finalization path. Goal: each of `/api/generate-outline`, `/api/generate-characters`,
`/api/generate-stage4-beats`, `/api/generate-stage5-treatment`, `/api/generate-stage6-scenes`
(and `/api/revise-stage6`) reduces to: shared context load → stage-specific agent call +
validation → shared finalization (revision transaction, snapshots, stamps, source usage,
queued write, trackUsage, response/SSE). Keep Stage 2's post-save outline verification hook
and each endpoint's SSE framing exactly as-is. No behavior changes, no route path changes.

**R3b — Split server.js (~7,200 lines) into route modules.**
Target shape: `routes/assistant.js`, `routes/generation.js` (stages 1–6 + 8 draft),
`routes/rewrite.js` (stage 9 coverage + stage 10), `routes/knowledge.js`,
`routes/styles.js`, `routes/projects.js` (CRUD + import + settings + health), with shared
helpers moved to `utils/` (or a `server/` lib dir) and server.js reduced to app wiring.
- Extract ONE module per commit. After each commit run the full gate (below).
- Preserve middleware order (`requireAuth`, `aiLimiter`, multer) and route registration order.
- Keep `sendApiError` + typed error classes in one shared module; every moved route keeps
  its typed-error behavior.

## R4 — Retire the last three DOM-scrape functions (after R3)

Follow the exact pattern you used for Stages 2/3 (`getCurrentStage2Outline` /
`getCurrentStage3Characters`): render seeds `currentProjectData`, edit listeners update
state in place, all readers use a getter. One stage per commit:
1. Stage 4: `scrapeTreatment()` → `getCurrentStage4Beats()`
2. Stage 5: `scrapeTreatmentStage5()` → `getCurrentStage5Treatment()`
3. Stage 6: `scrapeStage6()` → `getCurrentStage6Blueprint()`
~18 call sites total (snapshots, approvals, saves, chat `executeRevision`, source-audit
snapshots, regeneration payloads). Preserve the exact shapes the endpoints receive today
(e.g. Stage 5's `notes` field handling, Stage 6 sequence/scene structure).

## Hard constraints (verified by tests and by review)
- `test/json_repair_guard.test.js` fails the suite if any raw `JSON.parse` on model output
  appears in `agents/` — route new parses through `parseJsonWithRepair(text, {schema, label})`.
- Do NOT rename legacy data keys (`stage8_coverage`, `stage9_rewrites`, `conversations.stage9`).
- Do NOT touch the assistant tool contract (`/api/assistant`, turnState round-trip,
  `toolResultsContainFailure`, thoughtSignature echo in `agents/tool_messages.js`).
- Skills load only via `loadSkill()`; project RMW only via `updateProjectJSON()`.

## Gate after EVERY commit
```sh
node --test 'test/*.test.js'      # 150 tests — note: bare `node --test test/` breaks on Node 24
npm run test:knowledge            # 130 tests
PORT=3461 node server.js &        # boot smoke
curl -s http://127.0.0.1:3461/health   # expect ok:true + buildTimestamp; then kill it
```
For every R4 stage (and after finishing R3b): a real browser pass — open a project, visit the
touched stage, edit a field, run one chat revision, approve, reload, and check the console for
errors. Syntax checks and curl did NOT catch the June closure-scope bug; only the browser did.

## When done
- Update the status header in `specs/pageone-roadmap-2026-07-03.md` (mark R3/R4 done with
  commit hashes) and add a short entry under `## Recent Changes` in `CLAUDE.md`.
- Leave the tree clean, everything committed. Do not push unless asked.
