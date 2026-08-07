# PageOne — Stage 7 Draft & Stage 9 Rewrite: editor UX plan

**Date:** 2026-08-06
**Scope:** visible Stage 7 (Draft) and Stage 9 (Rewrite) — the two surfaces where the writer
actually writes. Benchmark: Final Draft 13, Arc Studio Pro, Fade In.
**Status:** **built and deployed 2026-08-07**, except items 6 (pagination) and 7 (per-change
accept/reject in Stage 9). See the implementation record at the bottom.

---

## How this was assessed

Read `public/fountain-editor.js` (597 lines), the Stage 7/9 blocks of `public/app.js`, and
`computeLineDiff`; then drove both stages live against MIRAGE BEND (5 drafted scenes, one
pending rewrite) at 1600×1000 and read the rendered result. Reference behaviour checked
against Final Draft's own documentation for Revision Mode, ScriptCompare and SmartType, and
against reviews of Arc Studio Pro and Fade In.

---

## What is already right — do not rebuild it

This matters, because the temptation with "make it more like Final Draft" is to start over.
The foundation is sound:

- **`fountain-editor.js` is a genuine WYSIWYG screenplay editor**, not a textarea. Six element
  types, each a `<div data-element>`, with **Tab cycling that is context-aware**
  (`scene-heading → action → character → dialogue`), **Enter auto-advance**
  (`character → dialogue`, `dialogue → action`), ⌘1–6 type shortcuts, and a type dropdown.
  That is the core of Final Draft's editing model, and it is already correct.
- Storage is **Fountain plain text**, parsed in and serialised out. Portable, diffable, no
  lock-in — better than a proprietary blob.
- The **LCS diff is a correct algorithm**, trimming lines before comparison so whitespace
  doesn't produce phantom changes.
- Per-scene autosave with **visible, blocking failure** (fixed 2026-08-06).
- Scene list with LOCKED / drafted badges.
- One editor component **shared by both stages** — every improvement below lands in both.

The gap is not the editor. It is (a) how much room it gets, (b) that it only ever shows one
scene, and (c) that the compare view shows *that* something changed without showing *what*.

---

## Findings

### A. The writing surface is the smallest panel on screen

Default Stage 7 layout gives the editor roughly 30% of the vertical space; the assistant
drawer takes ~45%. Collapsing the chat transforms it — suddenly it reads like a screenplay.
In Final Draft, Arc and Fade In the script **is** the window and everything else docks around
it.

**Fix:** assistant collapsed by default in Stage 7/9, with its state remembered per stage; or
better, make it a right-hand dock that shares the rail with the scene list instead of a bottom
drawer. Low effort, immediately noticeable.

### B. One scene at a time, with no continuous document ← the structural gap

Clicking a scene *replaces* the editor's contents. There is no view of the screenplay as one
document. Every reference app does the opposite: the script is continuous and the navigator is
a jump-index **into** it.

What that costs today:

- You cannot read across a scene boundary — exactly where pacing, transitions and act turns live.
- You cannot select, copy or move a run of scenes.
- Page count is meaningless, so pagination is impossible (see C).
- Find & Replace across the script is impossible (see F).

**Constraint to be honest about:** the data model is one text blob per scene
(`stage6_scenes[].scenes[].draft_text`). A continuous view means rendering all drafted scenes
into one editor and routing each edit back to its owning scene on save. Every element div would
carry `data-scene`, and the save path would re-split by that attribute. Tractable, but this is
the largest item here and it should be decided deliberately rather than drifted into.

### C. No pagination, no page numbers

Screenwriters think in pages — "we're twelve pages into act two", "that scene is 3⅛ pages".
The app stores `estimated_page_count` per scene and never shows it in the editor. There is no
page ruler, no page break, no running count. Depends on B.

### D. No SmartType — the cheapest high-value win

Final Draft's SmartType maintains lists of character names, locations, times of day and
transitions, and autocompletes as you type in the matching element. PageOne makes you retype
`EXT. OCOTILLO SPRINGS - GATED ENTRANCE - DAY` by hand.

**Every input needed is already client-side.** Measured on MIRAGE BEND: **9 character names**
from `stage3_characters`, **39 distinct locations** and the times of day parsed straight out of
existing scene headings. No new data, no model calls, no server work.

Side benefit: it would stop malformed headings at the source. Parsing the current project's
headings for "time of day" returns `DAY, CONTINUOUS, NIGHT, … EXT, INT, TOWN SQUARE, RIDGE,
DRY BASIN` — several scenes have malformed sluglines (e.g. `… PLANT - EXT - DAY`) that a
constrained autocomplete would have prevented.

### E. No undo/redo

`grep` finds no undo stack. The browser's native contenteditable undo covers typing *within* a
block, but Tab-retyping, Enter-splitting and type changes manipulate the DOM directly and will
either bypass or corrupt that stack. In a tool people write in for hours, unreliable undo is a
trust problem, not a convenience one.

**Fix:** a small command stack snapshotting the scene's Fountain text on structural operations,
bound to ⌘Z / ⌘⇧Z. Independent of everything else here.

### F. No Find & Replace

Absent. Largely blocked on B.

### G. Stage 9 compare — the specific concern, and it is fixable

The feature is a good idea and the algorithm underneath it is sound. The presentation is what
undercuts it. Observed live on the pending Scene 1 rewrite:

1. **The diff is line-granular, so small edits flag whole paragraphs.** The left pane shows a
   full red block and the right a full green block for a change that was really *"Asphalt cuts
   through…"* → *"A narrow strip of asphalt cuts through…"* plus *"creosote"* → *"bleached
   creosote"*. Two small edits; the writer has to eye-diff four lines to find them. **This is
   the single highest-value fix in Stage 9** — and it is incremental, not a rewrite: run a
   second word-level LCS over paired changed lines and mark the spans.
2. **The two panes scroll independently.** Alignment is lost on the first scroll of any real
   scene.
3. **No change navigation.** No "next / previous change". Across 70 scenes this alone makes the
   view impractical.
4. **Acceptance is all-or-nothing per scene.** You take the entire rewritten scene or hand-edit
   it. Final Draft and Arc let you accept or reject individual revisions.
5. **The left pane is inert.** It is labelled PREVIOUS STATE and offers no action — you cannot
   restore one block from it.
6. **No script-level summary.** The scene list shows a single dot. There is no "7 scenes
   changed · 23 edits", and no per-scene change count.

### H. The revision information is computed and then thrown away

This is the biggest missed opportunity, and it is *adjacent to work already done*.

Industry practice: a **starred draft** marks every revised line with an asterisk in the right
margin so a producer, director or 1st AD can see what changed without rereading; a **clean
draft** is the same script with the marks stripped, for wider circulation. Final Draft's whole
Revision Mode exists to produce these.

PageOne already knows exactly which blocks changed between the approved draft and the rewrite —
that is what `computeLineDiff` produces — **and then discards it at export.** Both PDF and DOCX
come out clean and unmarked.

Wiring the existing diff into the exporter would let Stage 9 emit a starred draft, which is the
artifact the industry actually asks for after a rewrite pass. Cheap, given the diff exists.

### I. The assistant and the script don't point at each other

In Stage 7 the assistant says "the saved draft for Scene 1 has been updated" and there is no
click-through to that scene, no highlight of what it touched. More importantly there is **no way
to select a paragraph and act on it** — "tighten this", "make this colder".

Final Draft cannot do this. Arc cannot do this. **This is the thing PageOne can do that they
can't**, and it is currently unbuilt while the app chases parity elsewhere. Selection-scoped
editing — select → instruct → inline diff → accept/reject — is the natural product
differentiator and reuses every piece proposed in G.

---

## Recommendation, in priority order

Effort is rough and relative, not estimated in hours.

### Tier 1 — small, high daily value, independent of any architectural decision

| # | Change | Why first |
|---|---|---|
| 1 | Assistant collapsed by default in Stage 7/9; remember per stage | One-line default change; the script instantly gets the screen |
| 2 | **SmartType** for characters / locations / times / transitions | All data already client-side; removes the most repetitive typing in the app; prevents malformed sluglines |
| 3 | **Undo/redo** stack over structural edits | Trust; independent of everything else |
| 4 | **Word-level diff** inside changed lines, **synced scrolling**, **next/prev change** navigation | Makes the compare feature actually usable; builds on the LCS already written |

### Tier 2 — the structural decision

| # | Change | Note |
|---|---|---|
| 5 | **Continuous script view** with the scene list as a navigator into it | The big one. Unlocks 6, F, and cross-scene reading. Needs `data-scene` on elements and a re-split on save |
| 6 | Live **pagination + page numbers** | Depends on 5 |

### Tier 3 — differentiators and industry-shaped output

| # | Change | Note |
|---|---|---|
| 7 | **Per-change accept / reject** in Stage 9, plus restore-from-left | Depends on 4 |
| 8 | **Starred-draft export** with revision marks (and a clean-draft toggle) | The diff already exists; this is mostly exporter work |
| 9 | **Selection-scoped AI editing** in Stage 7 and 9 | The thing Final Draft can't do |

### Tier 4 — parity items worth listing, not worth doing yet

Dual dialogue · scene numbers (production needs them) · editable title page · character-name
highlighting · a Fade In-style "dialogue tuner" (one character's lines in a list) · revision
*sets* with colours.

---

## DECIDED 2026-08-06 — continuous view: **"continuous read, scoped edit"**, built third

Carsten's call, taken on the recommendation below.

**The shape.** Render the whole drafted script continuously and paginated. Clicking into a
scene makes **that scene** editable in place, with the surrounding scenes still rendered around
it as context. Saving stays per-scene, and the editable region always has exactly one owner.

**Why not full continuous-editable (the Final Draft shape).** One editor over all scenes, split
back into per-scene records on save, is the obvious version — and the re-split is the whole
risk. `contenteditable` creates new divs at boundaries, paste crosses them, and deleting a
scene heading merges two scenes into one owner. When that goes wrong it does not throw:
**text silently migrates between scenes, or into a scene that then overwrites the good copy.**

That is exactly the failure family this project has already paid for four times — `_meta`
assigned in memory and dropped on save; the blueprint that could never go stale; manual edits
written to `draft_text` while every reader preferred `humanized_draft_text`; the style restore
that wrote 4KB of markdown into a slug field. All silent, all returned 200, three survived a
green suite. A mechanism whose failure mode is *"your words quietly moved to another scene"* is
the wrong risk for this app to take.

It also fights the system: per-scene is load-bearing well beyond storage —
`rewrite-single-scene`, per-scene diffs, scene locking, crash-safe incremental persistence
during batch drafting, and coverage to-dos that cite scene numbers.

**Why not stay scene-at-a-time.** You lose the thing screenplays are made of: reading across a
scene boundary, which is where pacing, transitions and act turns live. Page count stays
meaningless, so no pagination and no page numbers — and screenwriters think in pages. Find
across the script is impossible. It reads like a CMS for scenes.

**What the chosen form costs.** Exactly one thing: a single selection spanning two scenes.
Cut-and-paste between scenes still works explicitly. And that boundary is arguably correct
rather than a compromise — **Stage 5 decides what the scenes are; Stage 7 is where you write
them.** Restructuring has a home upstream.

**Guard to build with it:** a test that renders N scenes, edits one, saves, and asserts every
*other* scene is byte-identical — same shape as the `draft_text` pairing guard, aimed at the
specific failure that matters.

**Falsification trigger — the thing that would prove this wrong.** If, after a week of real
drafting, Carsten repeatedly reaches for a selection spanning two scenes, or wants to drag a
paragraph from one scene into the next, then the scoped-edit boundary costs more than it
protects and full continuous-editable is worth the risk. Knowable from a week of use rather
than predicted now.

**Sequencing:** Tier 1 first (independent of this decision and cheaper), then the Stage 9
word-level diff, then this. Order of record: **Tier 1 → 4 → 9 → 8 → 5**. Items 4, 9 and 8
compound — they reuse the same diff-and-accept machinery — and item 9 is the one a competitor
cannot copy quickly.

---

## Implementation record — 2026-08-07

Built in the order of record (Tier 1 → 4 → 9 → 8 → 5). Every item verified against the running
app before its commit, and every commit verified on prod via `/health` plus a grep of the
**served** asset — not the local file.

| # | Item | Commit | Notes |
|---|---|---|---|
| 1 | Assistant collapsed by default in Stage 7/9 | `8e845ce` | `DEFAULT_COLLAPSED_STAGES = [8, 10]` (internal ids) |
| 2 | SmartType (characters / locations / times / transitions) | `8e845ce` | Consulted before Tab and Enter, so it never fights element cycling |
| 3 | Undo/redo over **structural** edits | `8e845ce` | Snapshots the element list, not just text — element-type changes are undoable |
| 4 | Word-level diff, synced scroll, next/prev change nav | `e967814` | `public/script-diff.js` + 12 tests |
| 7 | Per-change accept/reject in Stage 9 + restore-from-left | — | **Not built.** Partly overtaken: item 9 ships accept/reject for *selection* edits in Stage 7, but Stage 9's whole-scene rewrite is still all-or-nothing |
| 9 | Selection-scoped AI editing | `8eb9940` | Editor selection API + `POST /api/revise-selection`; returns a fragment, `changed` computed server-side |
| 8 | Starred-draft export with revision marks | `101f009` | Reuses `computeLineDiff`; `?marks=0` gives the clean draft |
| 5 | **Continuous read, scoped edit** | `0d9146a` | This document's decision. `test/continuous_view.test.js` |
| 6 | Pagination + page numbers | — | **Not built.** Depends on 5. See below. |

**The one thing item 4 cost, worth recording.** The Stage 9 diff took four attempts. A forward
walk over a prefix-LCS table marked every line changed (a unit test caught it); position-based
pairing broke on a 13-vs-9 rewrite; the real cause was **blank lines being diffed as content**,
which let the LCS match any blank to any blank and pair paragraph 6 against paragraph 2. Each
fix made the screenshot look better while the pairing was still wrong. What finally exposed it
was printing both annotated sequences from the real saved data — not looking at the rendering.

**Item 5's guard held.** Verified live on a 70-scene project: editing one scene left all 69
others byte-identical on disk. The test project was restored to its pre-test snapshot
afterwards.

**Item 6 (pagination) when it is picked up:** on-screen page numbers must be computed with the
**same math the exporter uses**, not an independent estimate. Two page counts that disagree are
worse than one page count that is missing — the writer would have no way to know which one the
reader will see.

**The falsification trigger above is now live.** It needs a week of Carsten's real drafting to
answer, and it is the only open question in this plan.

---

## Sources

- [Final Draft — Revision Mode (KB)](https://kb.finaldraft.com/hc/en-us/articles/27813588722708-How-do-I-use-Revision-Mode)
- [Final Draft — What is SmartType (KB)](https://kb.finaldraft.com/hc/en-us/articles/27750003388948-What-is-SmartType-and-how-do-I-use-it)
- [Final Draft — How can I compare two drafts (KB)](https://kb.finaldraft.com/hc/en-us/articles/15575232901780-How-can-I-compare-two-drafts-of-my-script)
- [Final Draft — Starred Draft vs Clean Draft](https://www.finaldraft.com/blog/starred-draft-vs-clean-draft-the-best-way-to-present-a-revised-script)
- [Final Draft — The Big Picture: navigating every element of your script](https://www.finaldraft.com/blog/the-big-picture-how-to-navigate-every-element-of-your-script)
- [Arc Studio Pro — hands-on review (FilmDaft)](https://filmdaft.com/review-arc-studio-screenwriting-software-test/)
- [Final Draft vs Arc Studio Pro (Bloop Animation)](https://www.bloopanimation.com/final-draft-vs-arc-studio-pro/)
- [Fade In — features](https://www.fadeinpro.com/page.pl?content=features)
