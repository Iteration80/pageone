# Stage 7 Style — Redesign Handoff

*PageOne | March 26, 2026*
*For Antigravity/Claude Code — supersedes Phase 2 + Phase 3 specs*

---

## What Changed and Why

The original Phase 2 spec built a hybrid system: chat + Quick Start form (sliders, pills, reference fields) + My Styles modal. After building and analyzing that design (see `RESEARCH/stage7-style-ux-brainstorm.md` and `stage7-style-ux-redesign.md`), the conclusion was clear: the form forces writers to decompose intuition into abstract UI controls that don't match how they think. Three parallel input paths with no hierarchy creates decision paralysis.

**The redesign does three things:**

1. **Kills the Quick Start form and My Styles modal.** Chat becomes the single interaction path in Stage 7.
2. **Moves heavy style creation to the Landing Page.** Styles become first-class entities alongside projects — not something you build mid-pipeline under time pressure.
3. **Establishes three tiers of style** — None (default LLM voice), Conversational (directive from Stage 7 chat), and Trained (full reference + directive from uploaded screenplay analysis). Each tier maps to a different level of investment and precision.

---

## Architecture: Three Style Tiers

The system supports three levels of style, each representing a different level of investment and precision. The user always has a choice — and "no style" is a first-class option, not an escape hatch.

### Tier 1: None (Default)

- `stage7_style = "none"`
- No style directive is injected into Stage 8 or Stage 10 prompts
- The LLM uses its default screenplay voice — competent, neutral, professional
- Humanizer is the only craft directive
- This is the default state. It's always available as a selection in Stage 7.
- **No files created.** Nothing stored in `data/styles/`.

### Tier 2: Conversational Style (Directive Only)

- Created in Stage 7 via chat with the Assistant
- The agent reads Stage 6 scenes, discusses the vibe with the user, and synthesizes a directive from training knowledge + the conversation
- Source material: the user's description ("Coen Brothers deadpan"), named references, the agent's training knowledge about those references, and the story context from Stage 6
- **Not** derived from uploaded screenplay text — this is the agent interpreting the user's intent, not analyzing a source document
- Produces a single artifact: a **compact directive** (400-600 words)

**Compact Draft Directive** (`data/styles/[slug]-directive.md`)
- 400-600 words
- Six sections: Scene Construction, Action Lines, Dialogue, Tone, Signature Moves, Avoid
- Imperative voice throughout ("Open scenes mid-moment" not "Scenes tend to open mid-moment")
- Used by: Stage 8 Draft (injected into system prompt), Stage 10 Rewrite (as the only style input)
- Good enough for most users. Quick to create. The agent does the analytical work.

### Tier 3: Trained Style (Reference + Directive)

- Created on the Landing Page by uploading actual screenplay text
- The agent analyzes the uploaded script(s) to extract concrete patterns — not from training knowledge, but from the text itself
- This is the deep option: the user uploads a Sorkin screenplay, the agent reads it, and builds a detailed fingerprint of how Sorkin actually writes (not how the internet describes his writing)
- Also works for cloning your own style: upload your own scripts, get a style reference that captures your voice
- Produces two artifacts: a **full reference** + a **compact directive** distilled from it

**Full Style Reference** (`data/styles/[slug]-reference.md`)
- 2000+ words
- Deep breakdown: scene construction patterns, action line fingerprint, dialogue rhythms, tonal signature, pacing DNA, visual vs. verbal balance, signature moves, anti-patterns
- Rich with examples pulled from the analyzed text
- This is the "bible" for a writer's style — comprehensive, analytical, grounded in evidence
- Used by: Stage 10 Rewrite (style-compliance pass), Landing Page style detail view
- NOT injected into Stage 8 draft prompts (too large)

**Compact Draft Directive** (same format as Tier 2, but distilled from the reference rather than from conversation)
- The directive is more precise when it's distilled from a real reference vs. synthesized from chat
- Same file format, same six sections, same 400-600 word target

### Upgrade Path

A Tier 2 style can be upgraded to Tier 3 at any time: the user goes to the Landing Page, opens the style, uploads screenplay text, and the agent builds the reference + refines the directive. The old conversational directive gets replaced by the distilled one.

### YAML Front Matter

```yaml
---
name: "Aaron Sorkin"
slug: "aaron-sorkin"
created: "2026-03-26"
tier: "trained"  # "conversational" | "trained"
source: "screenplay-analysis"  # "conversation" | "screenplay-analysis"
screenplays_analyzed: ["The Social Network", "A Few Good Men"]  # only for trained styles
tonal_summary: "Rapid-fire, intellectual, walk-and-talk, idealism under pressure"
word_count: 2340  # reference word count (or 480 for directive)
artifact_type: "reference" | "directive"
paired_with: "aaron-sorkin-directive"  # only on reference files
---
```

### File Storage

```
data/styles/
  aaron-sorkin-reference.md         # Tier 3: Full 2000+ word analysis (from uploaded scripts)
  aaron-sorkin-directive.md         # Tier 3: Distilled from reference
  coen-brothers-directive.md        # Tier 2: From Stage 7 conversation (no reference)
  my-custom-voice-reference.md      # Tier 3: User's own style, cloned from their scripts
  my-custom-voice-directive.md      # Tier 3: Distilled from above
```

---

## Landing Page: Style as a First-Class Entity

### Current State

Styles are created inside Stage 7, mid-project. This means the user can't build a style library without starting a project, and style creation happens under the pressure of a linear pipeline.

### New Design

The Landing Page (where users see their projects) gets a **Styles** section. Styles sit alongside projects as top-level entities.

**Landing Page layout:**
```
┌─────────────────────────────────────────┐
│  PageOne                                │
├─────────────────────────────────────────┤
│                                         │
│  MY PROJECTS                            │
│  [Project Card] [Project Card] [+ New]  │
│                                         │
│  MY STYLES                              │
│  [Style Card] [Style Card] [+ New]      │
│                                         │
└─────────────────────────────────────────┘
```

**Style Card (Landing Page):**
- Writer/style name
- Tonal summary (one-liner from front matter)
- Tier badge: "Trained" (has reference from screenplay analysis) or "Conversational" (directive from chat)
- Number of projects using this style
- Click → opens style detail view

**"+ New Style" flow:**
1. User clicks "+ New Style"
2. Chat opens (same agent as Stage 7, but outside any project context)
3. Agent: "Who do you want to write like? Name a writer, describe a vibe, or upload a screenplay and I'll analyze it."
4. User provides input → agent builds the style artifacts
5. If screenplay(s) uploaded: Tier 3 — both reference + directive are generated from the text. This is how you clone a specific writer's voice (including your own).
6. If chat description only: Tier 2 — directive from conversation + training knowledge. Can be upgraded to Tier 3 later by uploading scripts.
7. Style card appears in the library

**Important:** The app does not provide screenplays. Users upload scripts they have — their own work (to clone their voice) or scripts they've obtained (gray area, but the app isn't the source). File upload supports `.fountain`, `.pdf`, `.txt`.

**Style Detail View:**
- Full reference displayed (if it exists) — readable, not raw markdown
- Directive shown in a collapsible section
- "Preview" button: pick any project's Scene 1, draft it in this style
- "Edit" button: reopen chat to refine
- "Delete" button (with confirmation)
- List of projects using this style

### Why This Matters

Styles become reusable assets. A writer builds their "Aaron Sorkin" style once, uses it across five projects. They build a custom style for a specific genre. The library grows over time. This is the stickiness play — styles are a personal toolkit that keeps users in PageOne.

---

## Stage 7: Simplified Selection + Confirmation

### Current State (Old Phase 2 Spec)

Stage 7 is a full creation workspace: chat panel, Quick Start form with sliders/pills, My Styles modal, file upload zone. It's where styles are born and selected.

### New Design

Stage 7 becomes a **selection and confirmation stage** — lightweight, fast, consistent with how other stages feel (Assistant-driven, not form-driven).

**On Stage Entry (scenes exist from Stage 6):**

1. The Assistant reads Stage 6 scenes and opens with a proactive suggestion:

   > "Your story reads like a tense domestic thriller with dark undercurrents — lots of quiet conflict in confined spaces. Based on that, here are three writers whose style would fit:
   >
   > **1. Denis Villeneuve** — Controlled tension, sparse dialogue, visual weight in every scene. Your kitchen confrontation in Scene 3 would land hard in this register.
   >
   > **2. Sam Mendes** — Suburban pressure cooker, characters saying one thing and meaning another. Your Robert/Margaret dynamic has that energy.
   >
   > **3. Kelly Reichardt** — Unhurried, observational, trusts the audience. If you want the silences to do the work.
   >
   > Pick one and I'll set the style, or tell me something different."

2. **If the user has saved styles**, those appear as inline cards above the chat:
   ```
   ┌──────────────┐  ┌──────────────┐
   │ Aaron Sorkin  │  │ Custom Noir  │
   │ Rapid-fire,   │  │ Slow-burn,   │
   │ intellectual  │  │ atmospheric  │
   │ [Use This]    │  │ [Use This]   │
   └──────────────┘  └──────────────┘

   Or describe something new below ↓
   ```

3. **If no scenes exist** (edge case — user jumped ahead): Agent opens with "What should this screenplay feel like? Name a writer, describe a vibe, or pick from your saved styles above."

**The Interaction (four paths, one chat interface):**

- **Pick a suggestion** → Agent generates a Tier 2 (conversational) directive on the spot from training knowledge → style card appears → "Preview Scene" → approve
- **Pick a saved style** → card appears → approve (fastest path, works for both Tier 2 and Tier 3 styles)
- **Describe something custom** → Agent builds a Tier 2 directive via chat → card appears → preview → approve
- **"No style"** → User selects "Continue without a style" → Tier 1 (None). Stage 8 uses default LLM voice. Always available.
- **Want a Trained style?** → "Create from screenplay" link → redirects to Landing Page style creator where they can upload scripts (Tier 3 workflow)

**What's Removed from Stage 7:**

| Element | Status |
|---------|--------|
| Quick Start form (sliders, pills, references) | **Removed** |
| Quick Start button in header | **Removed** |
| My Styles modal | **Removed** (replaced by inline cards) |
| My Styles button in header | **Removed** |
| File upload zone in Stage 7 | **Removed** (upload lives on Landing Page style creator) |

**What Stays:**

| Element | Status |
|---------|--------|
| Chat panel | Primary interaction path |
| Style card display | Shows after selection or generation |
| Preview Scene button | On style card — critical for the suggest → preview → adjust loop |
| Approve button | On style card + header |
| Regenerate button | On style card |
| "No style" option | Always available. Tier 1 — the LLM drafts in its default voice. Not hidden as a skip link; it's a legitimate choice presented alongside the suggestions. |

### The 3-Writer Suggestion System

This is the centerpiece UX of the redesigned Stage 7. The agent reads Stage 6 scenes and suggests three specific writers — not generic dimensions, not sliders, but actual people whose voice would fit the story.

**Key behaviors:**

- Suggestions include writers the user doesn't have styles for yet. The agent uses training knowledge to describe the style. If the user picks one, the agent generates a directive on the spot.
- Suggestions include brief, story-specific reasoning ("Your kitchen confrontation in Scene 3 would land hard in this register") — not generic descriptions.
- If the user has saved styles that fit, the agent can include one as a suggestion: "You already have an Aaron Sorkin style that could work here."
- The agent suggests a range (e.g., one intense, one restrained, one wild-card) to give the user meaningful contrast.

**Implementation:**

The agent's system prompt for the opening suggestion needs:
- All Stage 6 scene summaries
- List of saved styles (names + tonal summaries)
- Instruction: "Suggest exactly 3 writers whose style would suit this story. Include one the user already has a style for (if any fit). For each, give the name, a 1-sentence style description, and 1 sentence connecting it to something specific in their scenes."

---

## Stage 8 (Draft): Consuming the Directive

No change to the fundamental mechanism from the old Phase 3 spec. The Draft agent receives the **compact directive** (not the full reference) in its system prompt.

**System prompt structure:**
```
[Standard PageOne preamble]

STYLE DIRECTIVES
The following directives describe the writing style for this project.
Treat them as primary craft instructions when making decisions about
dialogue rhythm, action detail, tonal register, pacing, and voice.

[directive file content — 400-600 words]

[Character profiles — from Stage 3]
[Scene outline — from Stage 6]
[Humanizer skill file]

[Task instruction]
```

**Precedence (unchanged):**
1. Scene outline — what happens
2. Style directive — how it's written
3. Character profiles — who they are
4. Humanizer — secondary safeguards

**Tier 1 (None):** Style section omitted entirely. Humanizer becomes primary craft directive. The LLM writes in its default screenplay voice. Identical to pre-feature behavior. This is the default — it's what happens when a user skips Stage 7 or explicitly chooses "No style."

**Tier 2 (Conversational) and Tier 3 (Trained):** Both inject the directive in the same way. From Stage 8's perspective, there is no difference between a conversational directive and a trained directive — they're the same format, same size, same injection point. The difference is in how they were created (conversation vs. screenplay analysis) and how precise they are.

---

## Stage 10 (Rewrite): Full Reference + Style Compliance

This is the big change from the old Phase 3 spec. Stage 10 now does a **style-compliance pass** using the full reference file.

### How It Works

The Coverage agent (Stage 9) evaluates the draft analytically — structure, drama, pacing, character consistency. It does NOT use the style file. This is unchanged.

The Rewrite agent (Stage 10) now has two style inputs:

1. **Directive** (same as Stage 8) — maintains voice during rewrites
2. **Full Reference** (new) — used for a dedicated style-compliance check

**Rewrite flow:**
1. Rewrite planner reads Coverage notes + directive + reference
2. Planner generates rewrite instructions per scene
3. For each scene, the rewrite agent:
   a. Applies Coverage-driven fixes (primary goal)
   b. Checks scene against the full reference for style drift
   c. Flags and corrects any deviations: "Scene 4 uses passive constructions in action lines — [Writer X] always uses active, kinetic verbs. Rewriting."
4. Output: rewritten scene that fixes Coverage issues AND tightens style compliance

**System prompt for Rewrite agent:**
```
STYLE REFERENCE (for compliance checking)
The following is the full style reference for this project's writer voice.
Use it to verify style compliance — check that the rewritten scene matches
the patterns, rhythms, and anti-patterns described here.

[full reference content — 2000+ words]

STYLE DIRECTIVES (for craft execution)
[directive content — 400-600 words]

[Rewrite plan / Coverage notes]
[Current scene draft]
[Character profiles]

Your task: Rewrite the scene per the coverage notes. After rewriting,
verify the result against the Style Reference above. Fix any style drift.
```

**Behavior by tier:**

- **Tier 1 (None):** No style inputs. Rewrite focuses purely on Coverage fixes. Same as pre-feature behavior.
- **Tier 2 (Conversational):** Directive only, same as Stage 8. No compliance pass (there's no reference to check against). The directive keeps the rewrite tonally consistent, but there's no deep verification. User can upgrade to Tier 3 via the Landing Page if they want the compliance pass.
- **Tier 3 (Trained):** Full reference + directive. The compliance pass fires. This is the premium path — Coverage fixes + style-drift correction in one pass.

---

## Context Window Concern

The tier system is specifically designed to manage context. Tier 2 and Tier 3 both inject the same-sized directive (400-600 words) into Stage 8. The full reference only appears in Stage 10 for Tier 3 styles. But the sweet spot for directive size vs. draft quality needs testing.

**Variables:**
- Directive at 400 words vs. 600 words — is there a quality difference in drafted scenes?
- Full reference at 2000 words in Stage 10 — does it fit alongside the scene, coverage notes, and character profiles?
- Cost impact of the style-compliance pass in Stage 10 (extra tokens per scene)

**The safety net:** Stage 10 Rewrite IS the safety net. If the directive is too compressed and Stage 8 drafts drift slightly, Stage 10 catches it with the full reference. This means we can err on the side of keeping directives compact.

---

## What This Supersedes

| Old Spec | Status | Notes |
|----------|--------|-------|
| `specs/stage7-phase-2-style-feature.md` | **Superseded** | Quick Start form, sliders, pills, My Styles modal — all removed. Chat-only. Three-tier architecture (None / Conversational / Trained) replaces single file. |
| `specs/stage7-phase-3-thread-style.md` | **Partially superseded** | Stage 8 consumption is the same mechanism (directive in prompt). Stage 10 changes significantly (full reference + compliance pass). |
| Phase 1a/b/c (rename surgery) | **Still valid** | Nothing changes here. |

---

## Files to Create/Modify

### New Files
- `data/styles/` directory structure (reference + directive pairs)
- Landing Page style creation UI components
- Style agent prompt for 3-writer suggestions (Stage 7 opening)
- Style-compliance prompt for Stage 10 Rewrite

### Modified Files
- `public/index.html` — Remove Quick Start modal, My Styles modal, sliders, pills. Add inline style cards to Stage 7. Add "My Styles" section to Landing Page.
- `public/app.js` — Remove `stage7GenerateFromForm()`, Quick Start listeners, My Styles modal logic. Add inline saved-styles rendering, 3-writer suggestion flow, Landing Page style CRUD. Update Stage 7 init to be selection-focused.
- `public/style.css` — Remove slider/pill styles. Add inline card styles, Landing Page style section.
- `agents/agent_7_style.js` — Update to support three tiers: generate directive from conversation (Tier 2), generate reference + directive from uploaded screenplay (Tier 3), or set to None (Tier 1). Add 3-writer suggestion capability.
- `skills/skill_stage7_style.md` — Update to describe three tiers, output formats, and quality criteria for directive vs. reference.
- `agents/agent_10_rewrite.js` — Add full reference loading + style-compliance check.
- `skills/skill_stage10_rewrite.md` — Add style-compliance instructions.
- `server.js` — Update `/api/generate-stage7-style` for tier-aware output (Tier 2 = directive only, Tier 3 = reference + directive). Add Landing Page style endpoints (CRUD + file upload). Update rewrite endpoints to load full reference when available (Tier 3 only).

### Deleted Code
- Quick Start modal HTML (~50 lines)
- Slider + pill JS logic (~30 lines)
- My Styles modal HTML + JS (~20 lines)
- `stage7GenerateFromForm()` and related form-to-prompt translation

---

## Implementation Order

1. **Three-tier file structure + storage** — Implement the `data/styles/` directory, YAML front matter schema, and the logic for storing directive-only (Tier 2) and reference+directive pairs (Tier 3). "None" requires no storage. This is the foundation.
2. **Stage 7 simplification** — Rip out form/modal, wire up inline cards + chat-only flow. Implement the 3-writer suggestion system. Support all four paths: pick suggestion (Tier 2), pick saved style, describe custom (Tier 2), or "No style" (Tier 1).
3. **Landing Page styles section** — New UI for style library. Style creation outside project context. File upload for Tier 3 (screenplay analysis). Can be built in parallel with #2.
4. **Stage 8 directive injection** — Wire up the directive (from Tier 2 or Tier 3) into the Draft agent's system prompt. Tier 1 = no injection. Should be straightforward — same mechanism as old Phase 3 spec.
5. **Stage 10 compliance pass** — Add full reference to Rewrite agent for Tier 3 styles. Tier 2 gets directive only. Tier 1 gets nothing. Build the compliance-check prompt.
6. **Testing** — Full pipeline at each tier:
   - Tier 1: Skip style → draft → verify default voice
   - Tier 2: Chat-created style → draft → verify style influence → rewrite → verify consistency
   - Tier 3: Landing Page style from uploaded script → select in Stage 7 → draft → coverage → compliance rewrite → verify style precision

---

*This spec is the source of truth for the Style redesign. The UX analysis (`stage7-style-ux-redesign.md`) and brainstorm (`RESEARCH/stage7-style-ux-brainstorm.md`) are background reading.*
