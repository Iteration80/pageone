# PageOne — Project Instructions for Claude Code

## Project Overview
PageOne is a 9-stage AI screenplay development pipeline. Each stage is driven by a skill file (SOP) in `skills/` that instructs the Gemini AI agent on how to produce output. The quality of the entire pipeline depends on the quality of these skill files. Improving them is the highest-leverage activity in this project.

## Skill Files (the core assets)
All stage SOPs live in `skills/`:
- `skills/skill_stage2_outline.md` — Broad outline / beat structure
- `skills/skill_stage3_characters.md` — Character casting and profiling
- `skills/skill_stage4_beats.md` — 15-beat sequence sheet
- `skills/skill_stage5_treatment.md` — Scene-by-scene treatment
- `skills/skill_stage6_scenes.md` — Full scene writing
- `skills/skill_stage7_draft.md` — Full screenplay draft
- `skills/skill_stage8_coverage.md` — Quality coverage report
- `skills/skill_stage9_planner.md` — Rewrite planning
- `skills/skill_stage9_rewrite.md` — Surgical scene rewriting
- `skills/skill_coverage_consolidator.md` — Coverage synthesis
- `skills/skill_humanizer.md` — AI-artifact removal

## Project Data (observation signals)
User feedback and quality signals are stored in `data/projects/*.json`. Relevant fields:
- `stage{N}.notes` — User feedback text submitted when regenerating a stage output
- `stage8_coverage.evaluation_grid` — Structured quality ratings (concept / structure / characterization / pacing / dialogue)
- `stage8_coverage.analytical_comments` — Detailed qualitative notes on the output
- `stage8_coverage.blueprint` — Macro/micro to-do lists that identify recurring weaknesses

---

## Meta-Skill: Task Observer

At the start of any task-oriented session — any interaction where you will use tools and produce deliverables — activate the Task Observer protocol below.

When working on any PageOne skill file, also check `data/skill_observations/log.md` for OPEN observations tagged to that skill. Apply their insights to the current work, even if the skill file itself hasn't been updated yet.

---

### Task Observer Protocol
*Adapted from "One Skill to Rule Them All" by Eoghan Henn (rebelytics.com), CC BY 4.0*

**Purpose:** Systematically capture skill improvement signals during real work sessions so that PageOne's skill files evolve based on actual usage rather than guesswork.

#### What to Observe
1. **Corrections** — When a stage output is wrong and the user submits notes for regeneration, that's a signal of a gap or ambiguous rule in the skill file.
2. **Gaps** — When something is fixed manually that the skill should handle automatically.
3. **Patterns** — When the same type of error recurs across sessions or projects.

#### How to Log (silently, without interrupting the user's flow)
Append to `data/skill_observations/log.md` using this format:

```
### Observation [N]: [Short title]
**Status:** OPEN
**Date:** [YYYY-MM-DD]
**Skill:** skills/skill_stage[N]_[name].md
**Signal:** [What happened — user correction, gap noticed, pattern observed]
**Issue:** [The specific rule or gap that caused or failed to prevent this]
**Suggested improvement:** [A concrete change to make to the skill file]
**Principle:** [The generalizable lesson this illustrates]
```

Use monotonically increasing observation numbers. Check the log for the highest existing number before appending to avoid collisions.

#### When to Surface Observations
At the end of any session where observations were logged, add a brief note: "I've logged [N] observation(s) to `data/skill_observations/log.md`."

Do not interrupt the user during work to surface observations. Log silently; report at session end.

#### Review Trigger
When the user runs `/review-skills`, follow the protocol defined in `skills/skill_meta_review.md`.
