# Codex Handoff — Stage 6 Dramaturgical Audit (redundancy / filler / bloat flags) — 2026-07-15

Decision by Carsten (2026-07-15): **no page budgets anywhere.** Length is an
output, not an input — there are long films that feel short and short films
that feel long. What gets policed is whether every scene *earns its place*.
The pipeline should surface **redundancy** (a scene repeating dramatic work
already done), **filler** (no value shift and no legitimate quiet function),
and **bloat** (one scene carrying 3+ distinct dramatic jobs) — as **advisory
flags the writer can dismiss**, never as automatic cuts. Trims happen in the
rewrite, by the writer, with evidence in hand.

Design principle that must survive implementation: **the model never
free-hunts for problems.** Deterministic code nominates candidates; the model
only adjudicates nominated candidates; and every flag must survive an
adversarial defense pass before it is shown. This is the anti-over-flagging
architecture — connective tissue (aftermath beats, breathers, setup scenes)
is exactly what a defense pass acquits, because its justification lives in the
*neighboring* scenes.

Context: the first post-merge I.M.A.G.I.N.E. blueprint ran 82 scenes / 145
true pages with excellent per-scene craft — the issue is not quality, it is
that nothing in the pipeline distinguishes load-bearing quiet scenes from
actual waste. `git log` for the recent related work: `518c45d` (derived page
totals), `0f518a5` (treatment tag strip), `10e260f` (confirmDialog +
Complete-Profiles removal — read its commit message for why advisory-not-
acting is the house pattern).

---

## Step 1 — SOP: the necessity contract (`skills/skill_stage6_scenes.md`)

Add a "DRAMATIC NECESSITY CONTRACT" section. Every scene's
`dramaturgical_function` must declare, using EXACTLY these parseable text
markers (code will parse them — see Step 2):

- `VALUE SHIFT: <state> (+/-) to <state> (-/+)` — required unless the scene
  declares a quiet function instead.
- `QUIET FUNCTION: <one of: aftermath | setup-plant | irony-marination |
  tonal-reset | transition | pressure-valve>` — the explicit taxonomy of
  legitimate non-plot-advancing work. A scene may declare this INSTEAD of a
  value shift.
- `SETS UP: <what, paid off where>` / `PAYS OFF: <what, planted where>` —
  required for `setup-plant`, optional elsewhere.
- `UNIQUE JOB: <one sentence — the dramatic work no other scene does>`.

Also add: (a) an anti-redundancy rule — before writing scene N the model must
check the jobs already done and may not re-accomplish completed dramatic work;
re-establishing what the audience already knows is filler by definition;
(b) an anti-bloat rule — a scene carrying 3+ distinct dramatic jobs must be
split or shed; (c) explicitly NO page targets — do not add any.

The current blueprint already emits VALUE SHIFT / MICRO-CONFLICT prose
organically, so this formalizes an existing habit rather than fighting the
model. Keep the existing Function-line content (TRIANGLE OF KNOWLEDGE etc.) —
these markers are additions, not replacements.

⚠️ Do NOT change the Stage 6 JSON schema for this. The declarations live
inside the existing `dramaturgical_function` string as text markers. No new
required schema fields (see "traps" below for why), no data migration.

## Step 2 — Deterministic nominators (`utils/blueprint_audit.js`, new)

Pure functions, no model calls, fully unit-testable:

- `parseFunctionDeclarations(scene)` → `{ valueShift, quietFunction, setsUp,
  paysOff, uniqueJob }` parsed from the markers above; all-null for legacy
  scenes that predate the markers.
- `nominateRedundant(sequences)` → pairs of scenes whose
  `dramaturgical_function` texts are highly similar (normalized token overlap
  / Jaccard is fine — no embeddings, no dependencies). Emit
  `{ sceneA, sceneB, similarity, sharedTerms }`. Threshold conservative
  (start ~0.55 overlap after stopword removal); tune against the real
  I.M.A.G.I.N.E. blueprint so the nominee list lands in the ~5-15 range,
  not 40.
- `nominateNoShift(sequences)` → scenes declaring NEITHER a value shift NOR a
  quiet function. For legacy scenes without markers, fall back to detecting
  the organic "VALUE SHIFT" phrase; if absent entirely, nominate.
- `nominateOverloaded(sequences)` → scenes whose function text claims 3+
  distinct jobs (count named STC beats + reveal/betrayal/escape-class event
  verbs; keep the heuristic dumb and documented).
- `nominateAll(sequences)` → merged, deduped candidate list with evidence
  attached. **The model only ever sees this list.**

## Step 3 — Adjudication agent (`agents/agent_scene_audit.js` +
`skills/skill_scene_audit.md`, new)

For each candidate, two small model calls:

1. **Prosecutor**: receives the candidate scene(s) verbatim (both scenes for a
   REDUNDANT pair), the nominator's evidence, and the parsed declarations.
   Task: "confirm the charge with specific evidence, or acquit." Output via a
   **compact schema**: `{ verdict: 'confirm'|'acquit', evidence: string }`.
2. **Defense** (only if prosecutor confirms): receives the scene PLUS its full
   surrounding sequence and the scenes it claims to set up / pay off. Task:
   the removal test — "what breaks if this scene is cut? What does it set up,
   pay off, or process?" Output: `{ scene_survives: boolean,
   justification: string }`. **A flag is only recorded if the defense fails.**

Rubric requirements in the skill file: an empty report is a valid report; no
target counts; the six quiet functions are legitimate dramatic work and a
scene serving one is NOT filler; when in doubt, acquit (the writer is the
final cut — the correct failure mode errs toward respecting scenes).

Result shape saved to the project (see Step 4):
`{ scene_number, type: 'redundant'|'no_shift'|'overloaded',
   counterpart_scene (redundant only), evidence, failed_defense, severity,
   dismissed: false }`.

⚠️ Traps measured live this week — do not rediscover them:
- **Compact schemas only.** Handing the full casting schema to a one-field
  repair made Gemini emit 29,992 tokens of garbage for one character
  (`ed7424c`). The audit schemas above are <15 nodes each. There is a guard
  test pattern for this in `test/character_guardrails.test.js` — copy it.
- **Gemini 3 counts THINKING tokens against `maxOutputTokens`.** Use
  `thinkingConfig: { thinkingLevel: 'HIGH' }` + `maxOutputTokens: 16000`
  even though answers are tiny (4000 starved the answer; measured).
- **Batch and bound**: adjudicate candidates one at a time (they're small);
  per-candidate try/catch with one retry at a different temperature; a failed
  candidate is skipped, never fails the audit; cap total candidates at ~20
  and `log`/report anything dropped.
- **Agent positional args**: match existing agent call conventions exactly —
  two test bugs this week came from stuffing args into `modelConfig` that
  belonged in positional slots.

## Step 4 — Route + persistence

- `POST /api/generate-stage6-audit` (`routes/generation.js`, following the
  house route conventions — `requireAuth, aiLimiter`, typed errors,
  `finalizeGenerationEndpointArtifact` is NOT needed since the blueprint
  itself is untouched): loads the project, runs nominate → adjudicate, writes
  `data.stage6_scenes.audit = { generated_at, blueprint_hash, flags: [...] }`
  via `updateProjectJSON` (read-modify-write INSIDE the lock, per CLAUDE.md).
  `blueprint_hash` = hash of the scenes JSON so the UI can show "audit is
  stale" after blueprint edits.
- `PATCH /api/projects/:id/stage6-audit/dismiss` — body
  `{ scene_number, type, dismissed }`; flips the flag's `dismissed` bit.
  Writer dismissals are permanent data.
- Auto-trigger: after Stage 6 generation AND after Stage 6 revision complete,
  kick the audit **non-fatally** (failure logs a warning, never fails the
  generation — same posture as the Stage 3 completeness repair in
  `agents/agent_3_characters.js`).
- The audit NEVER mutates `sequences`/`scenes`. Advisory data only.

## Step 5 — UI (`public/app.js`, `public/index.html`)

- Small badge on each flagged scene card in the Stage 6 workspace (pattern:
  the Stage 3 completeness dots — report, don't act): `REDUNDANT (w/ Sc 33)`,
  `NO SHIFT`, `OVERLOADED`. Amber, subdued; dismissed flags render nothing.
- Clicking a badge opens a small panel (reuse `.modal-overlay` conventions or
  an inline expander) showing: the charge, the evidence, the failed defense,
  and a **Dismiss** button wired to the PATCH route. Use `confirmDialog()` if
  any confirmation is needed — `window.confirm` is banned (guard test
  enforces it).
- An "Audit Scenes" button in the Stage 6 header runs the audit on demand;
  show flag count when >0 ("3 flags"). If `blueprint_hash` no longer matches,
  show a stale indicator instead of stale badges.
- State-first: audit data flows through `currentProjectData`, render reads
  state, no DOM scraping. Helpers defined at top level, NOT inside
  `DOMContentLoaded` (June gear-icon bug class; guard test exists).

## Step 6 — Downstream: Coverage sees surviving flags

In the Stage 9 coverage generation path (⚠️ data key `stage8_coverage` — the
legacy naming trap in CLAUDE.md), inject a compact block into the coverage
prompt when non-dismissed flags exist:

```
BLUEPRINT-STAGE DRAMATURGICAL FLAGS (adjudicated, writer has not dismissed):
- Scene 41 REDUNDANT with Scene 33: <evidence, one line>
```

Instruct the coverage SOP (`skills/skill_stage9_coverage.md`) to weigh these
when building MACRO/MICRO to-do lists — Stage 10's rewrite planner already
consumes those, so the flags reach the rewrite with zero new plumbing.
Dismissed flags must NOT appear (test this).

## Step 7 — Assistant awareness (small)

Seed the Stage 6 `entryAnalysis` context (`agents/assistant.js`,
`STAGE_CONFIG[6]`) with a one-line audit summary when flags exist, so the
chat opens ready to discuss them. Do not add new tools; `apply_revision`
already covers acting on a flag conversationally.

## Step 8 — Tests

- Unit: every nominator against synthetic sequences (redundant pair found;
  quiet-function scene NOT nominated; legacy scene without markers handled;
  overload counting).
- Flow: adjudication with a mock `generateContentFn` — prosecutor acquits →
  no flag; prosecutor confirms + defense survives → no flag; confirms +
  defense fails → flag recorded. **The defense-rescues-connective-tissue case
  is the load-bearing test — an aftermath scene nominated as NO-SHIFT must be
  acquitted when its declarations say `QUIET FUNCTION: aftermath`.**
- Guards: audit schemas stay compact (<15 nodes); audit code contains no
  writes to `scenes`/`sequences`; dismissed flags excluded from the coverage
  injection; "empty report is a valid report" phrasing present in the skill.
- All against the SOP marker format: parse round-trip test.

## Gate after EVERY commit
```sh
node --test 'test/*.test.js'      # 206+ (glob form — bare test/ breaks on this Node)
npm run test:knowledge            # 135+
PORT=3467 node server.js & curl -s http://127.0.0.1:3467/health   # boot smoke
```
Plus a REAL browser pass for Steps 5+ (open a project with a blueprint, run
the audit, click a badge, dismiss a flag, verify persistence after reload,
watch the console). One logical change per commit. Local test fixtures in
`data/projects/*.json` must be restored (`git checkout -- data/projects/`)
before committing. When done: update CLAUDE.md (Recent Changes + the audit's
existence under "Project Data"), and append a completion record to this file.

## Out of scope / hard rules
- **No page budgets. No auto-cutting. The audit never modifies scenes.**
- No project-specific anything: no I.M.A.G.I.N.E. scene names, thresholds
  tuned by principle not by this one project's content (tuning against its
  *statistics* is fine).
- Do not touch: the Stage 4 beats derivation, Stage 3 guardrails/repair, the
  auth system, `stage4_beats`/`stage8_coverage`/`stage9_rewrites` key names.
- Do not add new npm dependencies (similarity = plain token overlap).
