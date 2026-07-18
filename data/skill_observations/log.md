# PageOne Skill Observation Log

Observations captured during Claude Code sessions. Each entry identifies a potential improvement to a PageOne stage skill file.

**Status key:** OPEN = not yet actioned | ACTIONED = skill updated | DECLINED = not pursuing

---

### Observation 1: Stage 2 Meta Note Leaked As Beat
**Status:** ACTIONED
**Date:** 2026-07-10
**Skill:** skills/skill_stage2_outline.md
**Signal:** A regenerated Stage 2 outline displayed a final beat labeled "Tone" with process guidance such as removing AI-style jargon, which is not story content and should not appear in the user-facing outline.
**Suggested improvement:** Added an explicit Stage 2 SOP rule that the JSON outline must contain only story beats inside act sequences; tone/style/revision/process notes must not be emitted as beats or sequence content.

---

### Observation 2: Necessity-contract markers drift in format across sequences
**Status:** OPEN
**Date:** 2026-07-16
**Skill:** skills/skill_stage6_scenes.md
**Signal:** In a full 82-scene I.M.A.G.I.N.E. blueprint regeneration, Sequence 1 (scenes 1–11) wrote the necessity-contract declarations as ALL-CAPS inline markers ("VALUE SHIFT:", "TRIANGLE OF KNOWLEDGE:", "MICRO-CONFLICT:"), while Sequences 2–8 expressed the same content as prose-case labels ("Value Shift:", "Triangle of Knowledge:", "Layered Conflict —"). Because the blueprint is generated sequence-by-sequence (8 sequential model calls), the marker format drifted after the first call. The dramaturgical audit's nominators are case-insensitive with a phrase-level backstop, so this did NOT cause false filler flags — but it's a document-consistency signal and the audit's more precise `QUIET FUNCTION:` detection (line-start, exact-vocabulary) only reliably fires on the first-sequence format.
**Suggested improvement:** Add an explicit, worked example of the required marker format to skill_stage6_scenes.md and state that EVERY scene in EVERY sequence must use the exact same marker syntax (line-start `VALUE SHIFT:` / `QUIET FUNCTION:` / `SETS UP:` / `PAYS OFF:` / `UNIQUE JOB:`), so the format can't drift across the sequential calls. Consider re-injecting the format rule into each per-sequence generation prompt, not just the top-level SOP.

---

### Observation 3: Revision brief written as bracketed instructions leaks in as fabricated beats
**Status:** OPEN
**Date:** 2026-07-17
**Skill:** skills/skill_stage2_outline.md (+ skills/skill_assistant_core.md)
**Signal:** On the "Dearly Beloved" outline, the writer's revision brief was structured as bracketed instruction blocks — `[Sequence 2] Update his backstory: disgraced Robin Hood...`, `[Elena's Stakes & The Gallery] Establish the "Scream" portraits...`, `[Preserve] The "Meeting in the Middle" arc...`. `buildRevisionChecklist` parses bracketed `[Label] body` blocks as content-to-ensure-present; when the model didn't apply them, `appendMissingChecklistBeats` appended all three verbatim as story beats, AND the actual changes (cold-open flashforward, Logan's on-page backstory, a Building Inspector beat) were never applied — yet the assistant reported full success. This is the 5th phrasing of the beat-fabrication class; the positive-class filter didn't cover content-imperative directives ("Update/Establish/Preserve the X") or markdown-emphasis (`**`) fragments. Filter fix shipped (`aeb59fd`), but two deeper gaps remain unaddressed: (a) the revision silently skipped the requested edits, (b) the assistant claimed success anyway.
**Suggested improvement:** (1) The SOP/assistant should treat a brief phrased as imperative edits as instructions to EXECUTE, and when a requested edit cannot be verified as applied, REPORT that honestly rather than claiming success — the honest-failure principle already enforced for `apply_revision` tool results should extend to "requested change not found in the result." (2) Consider teaching the assistant to disambiguate bracketed brief blocks: `[Label]` = a target section to modify, not literal content to insert. (3) A worked example in the SOP of a good revision brief vs. an instruction-shaped one.
**Update 2026-07-17 (later):** Root cause found and fixed in code (`d486b92`): the checklist gate deciding whether a prose brief is enforceable was a hardcoded I.M.A.G.I.N.E. keyword list, so enforcement never armed for other projects — the model could skip the edit and still report success. Now: general content-request gate, instruction-shaped items enforceable-but-not-appendable, honest STAGE2_CHECKLIST_UNMET on failure. The SOP-side improvements above remain worthwhile but the structural gap is closed.

---

### Observation 4: Stage 2 Arc/Pacing annotations read abstract and pretentious
**Status:** OPEN
**Date:** 2026-07-17
**Skill:** skills/skill_stage2_outline.md
**Signal:** Carsten, reviewing the Dearly Beloved outline export: "I'm not sure the 'Arc' descriptions are good. They read heavily 'abstract' and pretentious. Not convinced of their usefulness yet." Samples from the export: "Curiosity laced with unease — a paradise that feels like a held breath"; "Twin uncertainty — his hunger versus her guilt — circling one door"; "Grief and love braided together — an ally's gift that costs him everything." These are perfumed metaphor, not working notes. The annotations (emotional_arc/pacing_notes/genre_variation_notes) exist to carry the merged Beats-stage function into `stage4_beats` for downstream Treatment pacing — their VALUE is functional, but their VOICE is literary-poster copy.
**Suggested improvement:** Rewrite the SOP's annotation contract to demand working notes, not prose-poetry: emotional_arc = "NAME goes from CONCRETE STATE to CONCRETE STATE" (named character, playable states, no metaphor); pacing_notes = a rhythm instruction a director could execute ("fast comic beats, hard stop on the reveal"), max ~12 words; genre_variation_notes only when it says something a craftsperson can use. Explicitly ban em-dash aphorisms and "X laced with Y" constructions. Optionally also de-emphasize annotations in the UI/DOCX (smaller/collapsed) since they're machinery for downstream stages, not reader-facing prose.
