# PageOne Pipeline Audit — Outline / Beats / Treatment Redundancy (2026-07-12)

**Status update (2026-07-12):** Option A has been implemented with one naming adjustment:
the merged structure pass keeps the user-facing name **Outline**. The former Beats stage is
retired from the visible pipeline; `stage4_beats` remains only as a derived compatibility
artifact generated from Stage 2 Outline for downstream Treatment and Scene Blueprint reads.

Author: Claude (Fable 5). Evidence: code audit of routes/generation.js + agents 2–6 + skill
SOPs (file:line refs throughout), plus content analysis of the six I.M.A.G.I.N.E. stage
exports (2026-07-12). Question under audit: are Outline → Beats → Treatment three documents
doing one job, and should the pipeline be consolidated?

**Verdict up front: yes — Outline and Beats are one job split across two stages, and worse,
Stage 4 silently rewrites the story it is contractually locked to preserve. Treatment earns
its place and should stay. Recommended fix: merge Stages 2+4 into one "Structure" stage
(9-stage pipeline), plus length-discipline fixes. Separately, a P0 data-integrity incident
was found in the live Stage 3 artifact — handle that first.**

---

## 0. P0 FIRST — the live Stage 3 cast has been destroyed (unrelated to the pipeline question)

Today's characters export contains **one character** (Rebecca), where the 2026-07-04 export
had 30. Her profile is also thinned (2 of 7 psychological-core fields, 1 of 7 voice fields,
no deep profile/relationships) and her "The Lie" field contains **saved model self-talk**:
"…a dangerous distraction from survival सामुद्रिक . (Note: Removed spurious text…) Wait,
correcting to original… Actually, I will just copy exactly: …" — classic Gemini meta-narration
persisted into project data.

- The DOCX export code is NOT the culprit (read `agents/export.js:454-541` — no crash path;
  the doc ends because the saved array has one entry).
- The startup tier repair (`3d254d4`) is deterministic (override maps only, no model) — cleared.
- Most likely: a recent Stage 3 write (chat revision / regeneration) returned a near-empty,
  degraded cast and it was **saved as verified success**. Systemic hole enabling this:
  `characterRevisionAdapter` → `namedItemDiffAdapter` (`utils/revision_transaction.js:126-158`)
  returns `failures: []` unconditionally and counts every deletion as a *verified* operation —
  deleting 29 characters registers as 29 successes, receipt says "verified," the (honest)
  assistant truthfully reports the receipt.

**Actions:**
1. **Recover now (Carsten):** Version History on Stage 3 → restore the last full-cast snapshot
   (`recordArtifactMutation` snapshots every mutation, so the cast should be there). Do this
   before any further Stage 3 writes.
2. **Guardrail (Codex, P0):** revision verification must fail on unexplained mass shrink —
   e.g., for array artifacts (characters, scenes, beats), if the revision notes don't
   explicitly request deletions and the item count drops >30% (or per-item field mass drops
   sharply), set `verified: false` with a failure entry so `assertRevisionTransactionVerified`
   blocks the save and the assistant reports it. Add regression tests.
3. **Sanitizer (Codex, P1):** strip model meta-narration from saved string fields at parse
   time — patterns like "(Note: …)", "(Self-correction: …)", "Wait, correcting…", "Actually,
   I will just copy exactly:", and stray non-target-script tokens. General rule-based pass in
   `agents/json_parse.js` or a sibling; apply on generation AND revision paths; test it.

---

## 1. What each stage ACTUALLY receives (hydration map, code-verified)

Corrections to the working assumptions: Stage 4 **does** see the pitch; Stage 5 does **not**
see the outline.

| Stage | In the prompt (verified in template literals) | Notes |
|---|---|---|
| 2 Outline | pitch | + source packet, notes; current outline on revision |
| 3 Characters | pitch + outline | + tier guidance |
| 4 Beats | pitch + **outline** + characters | outline also inside the "OUTLINE LOCK" contract |
| 5 Treatment | pitch + characters + **stage4 beats** | **outline NOT passed** (`routes/generation.js:596`) |
| 6 Blueprint | pitch + characters + beats + treatment (per-sequence) | + continuity ledger, locations; **outline NOT passed** |
| 7 Style | stage6 scenes + characters | no outline, no beats |
| 8 Draft | synopsis (pitch) + characters + the single stage6 scene | no outline, no beats, no treatment |

**Key fact: after Stage 4, the outline is never read again. After Stage 6, the beat sheet is
never read again.** The artifact that carries structure into drafting is the Scene Blueprint.
Outline and Beats are scaffolding consumed and discarded — which is fine only if each adds
distinct value on the way.

## 2. What each stage is FOR (SOP roles + schemas)

- **Stage 2 SOP:** "8-Sequence Broad Outline," 2/4/2 across acts, dramaturgical functions per
  sequence. Schema: acts → sequences → `beats[{beat_label, description}]`. **The outline
  already contains beats.**
- **Stage 4 SOP:** "15-Beat Sheet based on Blake Snyder's Save the Cat, seamlessly mapped onto
  the 8-Sequence Outline… Stage 4 expands the provided outline; it does not rewrite it"
  (OUTLINE LOCK, mirrored in `agent_4:291`). Schema: 8 sequences → `beats[{beat_name,
  genre_variation_notes, emotional_arc, pacing_notes, detailed_action}]`.
- **Stage 5 SOP:** "Transform the provided character profiles and beat sheets into a…
  Sequence Narrative Expansion… must perfectly mirror [the beat sheet's] structure. For every
  single beat write at least 2–3 robust paragraphs." Schema: 5 prose fields (tlc, act_1, 2a,
  2b, act_3), generated in a 4-call chain.
- **Stage 6 SOP:** per-sequence 8–12 scenes; "Beat Sheet (Primary Structure)… Narrative
  Expansion (Primary Content)"; expansion not rewrite. 8-call loop + locations + continuity.

**Schema delta 2 vs 4:** identical skeleton (sequences → beats). Stage 4 adds exactly four
beat-level fields: named STC function, emotional_arc, pacing_notes, genre_variation_notes.
That is the entire *designed* value of Stage 4 — metadata annotation.

## 3. What the I.M.A.G.I.N.E. outputs show (evidence)

Word counts: pitch 336 → **outline 7,332** → **beats 4,614** → **treatment 8,574** → blueprint
18,691. The intended complexity ramp inverts at Stage 4 (−37%) and barely recovers at Stage 5
(+17% over the outline).

**a) Same skeleton three times.** All three docs use the same 8 sequences; 7 of 8 titles are
byte-identical across outline, beats, and treatment ("The Invisible World", "Ghosts in the
Toy Box", "The Manifesto and the Mother's Name", …).

**b) The outline over-writes.** Sequence C of the outline is not an outline — it's a fully
staged setpiece (the Big Doll brawl written shot-by-shot, complete jokes, prop details, a
button of dialogue). The Stage 2 SOP's "broad outline" contract is not being enforced by any
length discipline, so Stage 2 produces a mini-treatment. This is the root of the
"treading water" feel: by the time Treatment runs, most of its job was already done at Stage 2.

**c) Stage 4's OUTLINE LOCK fails silently — it re-paces the story.** Under identical
sequence titles, the beats doc *moved the events*: the kidnapping/door-slam sits in the
outline's Act I (Seq A/B region) but in Beats' Sequence 3 (where Save the Cat's "Break into
Two" wants it); the Big Doll ambush moved from outline Seq C to beats Seq 4. Treatment
follows Beats (Big Doll in Seq 4; Quist briefing in Seq 3). **Net effect: the human-edited,
approved outline's pacing was discarded without any surfaced diff, because Stage 5 never sees
the outline and no verifier compares outline content to beats content.** Whether STC pacing is
*better* is beside the point — a locked stage silently overriding an approved artifact is a
contract violation and makes the outline stage's approval theater.

**d) Treatment DOES add real value** — the Seq-3 sample shows genuine novel-style prose,
interiority, staging texture, and dialogue seeds that the beat sheet lacks; and the Blueprint's
rich per-scene Function fields (value shifts, triangle-of-knowledge, continuity locks) visibly
draw on treatment prose + beat metadata together. The 27-page Blueprint is the pipeline
working as intended — fed by exactly two upstream artifacts doing different jobs.

## 4. Verdict

- **Outline + Beats are one job.** Same skeleton, one regenerates the other with 4 extra
  fields, the "lock" between them doesn't hold, and nothing downstream ever needs both.
- **Treatment stays.** It is the only continuous-prose pass over the whole story, the
  Blueprint's designated "Primary Content" source, and the Blueprint generates per-sequence in
  a loop — without a global prose layer it would invent connective tissue 8 times
  independently. Going Outline+Characters → Blueprint directly would degrade Blueprint quality
  and push inconsistency risk downstream. (It also would NOT save much: treatment is 1 of 15+
  model calls in a full run.)
- The length inversion is a *symptom*: outline over-writes (does treatment's job), beats
  compresses (it's a sheet), treatment re-expands. Fix the roles, and the ramp becomes
  monotonic.

## 5. Recommendation

**Option A (recommended): merge Stages 2 and 4 into one "Structure" stage → 9-stage pipeline.**

> 1 Pitch → 2 **Structure** → 3 Characters → 4 Treatment → 5 Scene Blueprint → 6 Style →
> 7 Draft → 8 Coverage → 9 Rewrite

- Stage 2 "Structure" produces, from the pitch: 8 sequences (2/4/2) with STC-mapped beats —
  each beat = `beat_name` (STC function) + `emotional_arc` + `pacing_notes` + a **capped**
  description (≤ ~80 words; sheet discipline, no staged setpieces). Target ~3–4k words.
- Complexity ramp becomes monotonic: 0.3k → ~3.5k → (characters) → 9–12k treatment (with an
  explicit expansion mandate: every beat → 2–3 paragraphs of NEW texture — sensory, staging,
  dialogue seeds — never summary) → 18k+ blueprint.
- One canonical structure document: the writer's edits can't be silently overridden because
  there is no second structure artifact to diverge into. STC functions arrive before casting,
  which is also better context for Stage 3.
- **Cheap migration trick:** Stages 5/6 already read ONLY `stage4_beats.hybrid_beat_sheet` +
  characters. Have the merged Structure stage write its output to the `stage4_beats` key
  (and a derived legacy `stage2_outline` for old-project compatibility) — then Stages 5 and 6
  need **zero changes**. The work is UI (one workspace instead of two, renumber nav),
  routes/staleness chain, and SOP rewrites. ⚠️ Renumbering has bitten this repo before
  (the stage8_coverage/stage9_rewrites legacy-key trap) — do NOT rename existing data keys;
  follow the CLAUDE.md warning.
- Existing projects: leave `stage2_outline` as read-only history; new structure edits flow
  through the merged stage.

**Option B (lower disruption): keep 10 stages, make Stage 4 an annotation-only pass.**
Stage 4 may only ATTACH `beat_name`/`emotional_arc`/`pacing_notes` to the outline's existing
beats — enforced by a hard verifier (sequence/beat content hash must be unchanged; any move
of content across sequences fails the transaction). Pros: no renumbering. Cons: preserves a
stage whose whole output is 4 metadata fields, keeps two structure documents, and still needs
the same outline length-discipline fix. Choose B only if renumbering risk is deemed too high
right now.

**Do regardless of A/B:**
1. Outline/Structure SOP length discipline (beat description cap; ban staged setpieces).
2. Treatment SOP expansion mandate (new texture, not restatement; target 2.5–3× structure length).
3. **De-hardcode `skills/skill_stage3_characters.md` line 9** — it names the I.M.A.G.I.N.E.
   cast ("use full profiles for Rebecca, Dapple, Dave…") in a general SOP. Replace with
   tier-criteria language + a reference to the project's `tier_overrides` (which the agent
   already injects). This is a live bug: every OTHER project's Stage 3 prompt currently
   contains instructions about Rebecca and Dapple.
4. The P0/P1 items from §0 (mass-shrink guard, meta-narration sanitizer, cast recovery).

## 6. Roadmap

| Phase | What | Who | Size |
|---|---|---|---|
| **P0 (now)** | Recover Stage 3 cast via Version History; identify the damaging write (version-history metadata / server logs) | Carsten (+me) | minutes |
| **1 — Guardrails** | Mass-shrink verification guard for array artifacts + tests; meta-narration field sanitizer + tests; de-hardcode skill_stage3 line 9 | Codex | ~1 day |
| **2 — Decision** | Carsten picks Option A (merge, recommended) vs B (annotation-lock) | Carsten | — |
| **3 — Consolidation** | Implement chosen option: merged Structure stage writing to `stage4_beats` key (A) or hash-locked annotation pass (B); outline length discipline; treatment expansion mandate; UI/nav/staleness updates; CLAUDE.md + SOP truth pass | Codex (spec by Claude) | 2–3 days (A) / ~1 day (B) |
| **4 — Validation** | Regenerate I.M.A.G.I.N.E. (post-cast-recovery) through Structure → Treatment → Blueprint; check monotonic length ramp + no silent re-pacing; continue R6 shakedown | Carsten | 1 session |

## Appendix: project-specific code sweep (asked explicitly)

- `skills/skill_stage3_characters.md:9` — **hardcoded I.M.A.G.I.N.E. cast list in a general
  SOP. Fix (Phase 1).**
- `test/prompt_regression.test.js` — Dapple/Rebecca beat names as test *fixtures* (input
  data, not engine assertions). Acceptable; cosmetic to genericize someday.
- `scripts/seed-stage3-tier-overrides.js` — intentional one-off migration seed. Acceptable.
- Engine code (agents/, routes/, utils/, server.js): clean — no project-specific strings found.
