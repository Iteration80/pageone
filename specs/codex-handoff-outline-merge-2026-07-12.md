# Codex Handoff — Fold Beats (Stage 4) into Outline (Stage 2) — 2026-07-12

Decision by Carsten (2026-07-12), based on `specs/pageone-pipeline-audit-2026-07-12.md`
(read it first — it has the evidence and the full rationale): **Option A — merge Stages
2+4 into a single stage, which KEEPS the name "Outline."** Resulting user-facing pipeline
(9 stages): Pitch → Outline → Characters → Treatment → Scene Blueprint → Style → Draft →
Coverage → Rewrite.

Already shipped separately (commit `827838a`, do not redo): Stage 3 cast-preservation
pass, deletion/mass-shrink verification guard, model self-talk sanitizer, SOP de-hardcode.

## Architecture: extend stage2, DERIVE stage4 — do not port the outline machinery

The hardened Stage 2 machinery from June (stage_revision_kernel, protected_beats +
shield UI, outline_sanitizer, surgical revision + SSE recovery) all operates on the
`stage2_outline` shape (`acts → sequences → beats[{beat_label, description}]`). Keep all
of it. The merge is:

1. **Extend the Stage 2 beat schema** (additive, tolerant): each beat gains
   `beat_name` (canonical Save-the-Cat function, e.g. "Catalyst", "Midpoint"),
   `emotional_arc`, `pacing_notes`, optional `genre_variation_notes`. Plus a top-level
   `stc_genre_category` on the outline. Existing `beat_label` + `description` stay.
   Verify kernel/sanitizer/shield code is field-tolerant (they key on
   `beat_label`/`description` — confirm added fields survive their round-trips).
2. **Rewrite `skills/skill_stage2_outline.md`**: absorb the Save-the-Cat mandate from
   `skills/skill_stage4_beats.md` (exactly 8 sequences 2/4/2; distribute the 15 STC
   beats; per-beat emotional turn + pacing). ADD LENGTH DISCIPLINE — this is a core
   goal, not a nicety: beat `description` capped at ~80 words; explicitly ban staged
   setpieces/dialogue/shot-by-shot prose at outline level (the audit found the outline
   writing full scenes, which is what made the pipeline feel like three copies of one
   doc). Then delete `skill_stage4_beats.md`.
3. **Deterministic derivation, no model call**: add
   `utils/outline_to_beats.js :: outlineToHybridBeatSheet(stage2_outline)` mapping
   acts→flat 8 sequences, `beat_label`→beat title, `beat_name`→STC function,
   `description`→`detailed_action`, carrying `emotional_arc`/`pacing_notes`/
   `genre_variation_notes` and `stc_genre_category`. On every Stage 2 save / approval /
   chat revision, the finalize path writes the derived result to **`stage4_beats`
   (unchanged key)** with `stampGenerated` + snapshot. **Stages 5 and 6 read only
   `stage4_beats` + characters — they need ZERO changes.** For legacy outlines without
   STC fields, pass `beat_label` through as `beat_name` (no forced migration; STC names
   arrive as outlines get revised).
4. **Retire Stage 4 as a stage**: remove the Beats generation route + `agents/
   agent_4_beats.js` + the Beats workspace/nav/chat surface + its `STAGE_CONFIG` entry
   in `agents/assistant.js` + its approval-regen prompt wiring (careful: `d44ba09`
   just touched approval regen prompts). Grep broadly: `generate-stage4-beats`,
   `stage4`, `Beats` in routes/, public/, agents/assistant.js, utils/stageMetadata.js.
5. **⚠️ DO NOT RENAME DATA KEYS.** `stage4_beats`, `stage5_treatment`, `stage6_scenes`,
   `stage8_coverage`, `stage9_rewrites`, `conversations.*` all keep their names —
   renumber DISPLAY labels only (nav shows 1–9; internal ids stay 1,2,3,5,6,7,8,9,10).
   This repo's worst historical bug class is renumber-induced key drift; extend the
   CLAUDE.md "legacy data-key naming trap" section to document the new mapping.
6. **Treatment SOP** (`skill_stage5_treatment.md`): add the expansion mandate — every
   beat → 2–3 paragraphs of NEW material (staging, sensory texture, interiority,
   dialogue seeds); explicitly forbid restating the beat sheet at similar length. The
   audit's target ramp: outline ~3–4k words → treatment ~9–12k → blueprint 18k+.
7. **Staleness cascade** (`utils/stageMetadata.js`): outline save now directly stamps
   the derived `stage4_beats` as generated and marks `stage5_treatment`+ downstream
   stale, same as an approved Beats regeneration used to.
8. **Tests**: unit tests for `outlineToHybridBeatSheet` (shape, legacy pass-through,
   field carry-over); update/retire the stage-4 sections of `test/prompt_regression.test.js`
   (keep the Dapple fixtures where they now exercise the merged Stage 2 contract);
   keep the full matrix green.

## Gate after EVERY commit
```sh
node --test 'test/*.test.js'      # 185+ (glob form — bare test/ breaks on Node 24)
npm run test:knowledge            # 140+
PORT=3467 node server.js & curl -s http://127.0.0.1:3467/health   # boot smoke
```
Plus a REAL browser pass after the UI renumber and after wiring the derived write:
open a project → edit outline → approve → confirm Treatment sees the derived beat
sheet → check console for errors. One logical change per commit. When done: update the
status headers in `specs/pageone-pipeline-audit-2026-07-12.md` and CLAUDE.md
(stage list, Recent Changes), and note completion + commit hashes in this file.

## Out of scope
Do not touch the Stage 3 guardrails (`827838a`), the auth system, or the assistant
tool contract beyond removing Stage 4's entry. Do not run data migrations on
deployed projects.

## Completion record — 2026-07-12

Implemented Option A under the retained user-facing name **Outline**.

- Implementation commit: `06d2fd07f9cf6d839aa8dac3636163ea7c5bd652` (`06d2fd0`)
- Stage 2 Outline now owns the STC fields and SOP mandate.
- `stage4_beats` is derived deterministically from `stage2_outline` after Stage 2 generation/revision/project saves.
- The visible Beats stage, generation route, agent, skill file, nav/workspace/chat UI, assistant config, and Stage 4 revision adapter were removed.
- Visible pipeline is now 1-9 while internal ids/data keys remain backward-compatible.

Verification:

- `node --test 'test/*.test.js'` — pass (`183` tests)
- `npm run test:knowledge` — pass (`135` tests)
- `PORT=3467 node server.js` + `curl -s http://127.0.0.1:3467/health` — pass (`{"ok":true,...}`)
- `node --check public/app.js` — pass
- Browser pass — blocked in this Codex session because the in-app browser backend list was empty (`[]`).
