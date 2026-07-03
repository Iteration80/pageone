# PageOne Roadmap — 2026-07-03 (post-verification)

Author: Claude (Fable 5). Supersedes the remaining-work sections of
`specs/pageone-refactor-plan-2026-06-11.md` (keep that file as history — its Codex
continuation notes are the implementation record).

## Verification summary (2026-07-03)

Codex's implementation of the 2026-06-11 plan was independently audited: two deep code
audits (assistant unification; Phases 0/3/5), full test runs, and live end-to-end checks
(browser UI drive + real two-leg tool turns against the running server).

**Verdict: the work is real and well done.** Every structural claim checked out:

| Area | Status | Evidence |
|---|---|---|
| Phase 1/2 — assistant unification | ✅ Complete | All chat surfaces (stages 1–8, 10, global style creator) route through `/api/assistant` with native tools (`apply_revision` / `generate_style` / `generate_rewrite_plan`). Legacy `/api/brainstorm`, `/api/brainstorm-rewrite`, `/api/style-chat`, the flag contract, the client regex layer, the synthetic marker, `skill_brainstorm.md`, and agent_2's embedded conversation loop are all gone from code. Live test: Stage 2 direct instruction → clean tool call; failed receipt → honest failure report, no retry. Stage 9 correctly has no chat. |
| Phase 0 — safety rails | ✅ Complete | Build fingerprint in /health + UI footer + Settings + DOCX metadata; `utils/skills_cache.js` memoized with zero bypassing readFileSync; coverage agent uses `parseJsonWithRepair`. |
| Phase 3 — de-hardcoding | ✅ Code complete, ⚠️ migrations NOT run | Tier lists out of agent_3 (reads `tier_overrides`), Dapple beats out of the kernel (reads `protected_beats`), Stage 2 shield toggle UI, migration script exists. **But 0 of 9 saved projects have `tier_overrides` or `protected_beats` — the seed was never executed.** |
| Phase 4 — structural cleanup | ✅ Complete | Frontend approve helpers + `createStageApproveHandler` done; shared generation context/finalization helpers finished for stages 2–6; `server.js` split into `routes/assistant.js`, `routes/generation.js`, `routes/rewrite.js`, `routes/knowledge.js`, `routes/styles.js`, `routes/projects.js`, and `routes/export.js`. |
| Phase 5 — reliability | ✅ Complete | RMW read-inside-lock + atomic conversation saves; Stage 8 auto-save is awaitable with retry banner (saves via `PUT /api/projects/:id` — no dedicated endpoint, by design); Stage 10 pending rehydration + `/api/save-stage10-pending`; typed errors near-universal (1 remaining blanket 500-ish site, intentional); close-aware abort trackers on all streaming stages with `CLIENT_DISCONNECTED` normalization through both providers. |
| Phase 6 — frontend state | ✅ Code complete | State adapter + stages 2–6 now use state-first getters instead of DOM scraping; `scrapeOutline`, `scrapeCharacters`, `scrapeTreatment`, `scrapeTreatmentStage5`, and `scrapeStage6` are retired. |
| Tests | ✅ All green | 15 assistant + 55 prompt-regression + 70 knowledge + 2 review + 3 memory; knowledge suite 130. |
| Live UI | ✅ Clean | Hub loads, project opens, Stage 5 chat restores 24-message history, settings modal + fingerprint fine, zero console errors. |

**Codex's leftover list was accurate.** The audit found four additional items Codex
didn't flag — they're folded into the roadmap below as R1, R2, R5, and the R6 note.

---

## Remaining work

**Status 2026-07-03 (Codex R3/R4 completion pass):** R1 ✅ local side done — dry-run
correctly matches 0 local projects; the actual seed is a DEPLOYMENT step (see R1 below).
R5 ✅ done (commit `b01c185`). R2 ✅ done (commit `bc68be9` — includes a source-guard
test so raw parses can't creep back). R3 ✅ done (commits `d4e35ff`, `36e33b9`,
`470a2ed`, `61a2f68`, `0a9cd63`, `3d37285`, `d033263`, `437b7a4`). R4 ✅ code done
(commits `d8c1d6b`, `cb87881`, `dfefa7f`). Remaining: **R6 + deployment-side R1
(Carsten).** Full matrix green after each commit (latest: 152 + 132 tests); server
boot-smoked after each commit. Required browser passes for the R3/R4 follow-up were
blocked in this Codex session because the in-app browser backend exposed no available
browsers (`agent.browsers.list()` returned `[]`).

### R1 — Run the data migrations (5 minutes) — ⚠️ DEPLOYMENT-SIDE, not local
**2026-07-03 finding:** the I.M.A.G.I.N.E./Dapple project does not exist in local
`data/projects/` (dry-run correctly matches 0 of 9 local projects) — it lives on the deployed
webserver (Railway `DATA_ROOT`, per DEPLOYMENT.md and the June-10 handoff). Local projects
use structure-based tier inference, which is fine as-is. To finish R1, on the deployment:
1. `npm run migrate:stage3-tiers -- --write` (dry-run first without `--write`).
2. Re-shield the I.M.A.G.I.N.E. outline's ending beats via the Stage 2 shield toggles — the
   old kernel's hardcoded ending protection is gone until this is done. Other projects: shield
   beats via the UI as you touch them; no batch script needed.

### R2 — JSON-parse hardening in remaining agents (hand-off-able, ~half day) 🆕
Phase 0 fixed only agent_9. Raw `JSON.parse` on model output remains in:
- `agent_5_treatment.js:331,384,407,430,453` — 5 calls, highest risk (multi-pass pipeline)
- `agent_continuity.js:62,66` — worst pattern: try → regex fallback → second raw parse
- `agent_3_characters.js:432,501` · `agent_1_refine.js:48,70` · `agent_1_pitch.js:71`
- `agent_6_revise.js:150,419` (check :419 — may be a deep-clone, not model output)
- `agent_7_style.js:253` (lenient try/catch — lowest priority)
Route all model-output parses through `agents/json_parse.js::parseJsonWithRepair` with a
label, matching the agent_4/agent_9 pattern. Add a regression test that feeds each parser
malformed-but-repairable JSON.

### R3 — Phase 4 completion: server structure (hand-off-able, 1–2 days)
✅ Complete in commits `d4e35ff`, `36e33b9`, `470a2ed`, `61a2f68`, `0a9cd63`, `3d37285`,
`d033263`, `437b7a4`.

Now safe to do — the assistant unification already deleted the code that would have moved.
1. Finish the generation-endpoint factory for stages 2–6 on top of the existing
   `prepareGenerationProjectContext()` / shared-finalization helpers (Codex started this).
2. Split server.js (7,175 lines) into route modules: `routes/assistant.js`,
   `routes/generation.js`, `routes/rewrite.js`, `routes/knowledge.js`, `routes/styles.js`,
   `routes/projects.js`, `routes/export.js`; shared helpers to `utils/`. Behavior-preserving;
   verify with the full test matrix + a boot smoke after each extraction. Commit per module.

### R4 — Phase 6 completion: retire the last three scrape functions (hand-off-able, ~1 day)
✅ Code complete in commits `d8c1d6b`, `cb87881`, `dfefa7f`; required browser passes were
blocked in this session by unavailable in-app browser tooling.

Follow the exact pattern Codex used for Stages 2/3 (render seeds state → edits update state →
readers use `getCurrentStageN*()`), one stage per commit:
1. Stage 4: `scrapeTreatment()` → `getCurrentStage4Beats()`
2. Stage 5: `scrapeTreatmentStage5()` → `getCurrentStage5Treatment()`
3. Stage 6: `scrapeStage6()` → `getCurrentStage6Blueprint()`
18 call sites total. After each: full tests + browser pass (open stage, edit, chat-revise,
approve, reload).

### R5 — Documentation truth pass (quick, high value for AI sessions) 🆕
`CLAUDE.md` still documents the DELETED architecture as current — it names
`skill_brainstorm.md`, the Execution Boundary flags, and `postRevisionFollowUp`, and its
skill-file list is stale. Any future AI session reading it will be misled (this repo's main
scar tissue is exactly this kind of drift).
1. Rewrite the CLAUDE.md architecture/skills sections to describe `/api/assistant`, the tool
   contract, `skill_assistant_core.md`, `tier_overrides`/`protected_beats`, and the Phase 5
   error/abort conventions.
2. Archive all pre-June changelog entries to `CHANGELOG-archive.md`; add one entry
   summarizing the June refactor with a pointer to the two spec files.
3. Cosmetic while in there: rename `getBrainstormModelConfig()` → `getAssistantModelConfig()`.

### R6 — Live conversational shakedown (Carsten, no code)
Codex itself flagged that stages beyond 5 had routing + unit coverage but no live
conversational smoke. Spend one session across real projects: Stage 1 pitch refine via chat,
Stage 4 (its deterministic bypasses now live in `/api/assistant`), Stage 6 revise, Stage 7
style generation via chat, Stage 8 draft chat with scene selected, Stage 10 plan generation,
global style creator. File anything odd as observations.
**Note:** all stages currently run Gemini and the `ANTHROPIC_API_KEY` in `.env` is still
dead — fine today, but replace or remove it before ever selecting a Claude model in Settings,
or those stages will 401 again.

### Explicitly NOT doing (agreed)
- Stage 10 selected-scene feedback stays on direct `/api/rewrite-scene-feedback` — it's an
  explicit rewrite action, not a planning chat. Correct call.
- Stage 9 has no chat. Correct.

## Suggested order
Remaining: deployment-side R1, then R6 live conversational shakedown. R1/R6 are
Carsten-side.

## Standing process rule
One AI session at a time per working tree, commit between sessions — the June 11 closure-scope
collision (gear-icon breakage) is the cautionary tale.
