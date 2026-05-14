# Project Knowledge Operator Notes

*Created: 2026-05-10*
*Audience: future PageOne agents and operators*

## Product Promise

Project Knowledge exists so the stage assistants feel less forgetful. The writer should be able to upload source material or make an important creative decision once, then have later assistants use that memory without repeated reminders.

The Project Knowledge modal is a trust and repair surface. It should explain what the assistant can remember, where that memory came from, and when the memory needs a fresh source check. It is not supposed to be the main workflow.

## Memory Priority

When assistant context contains multiple memory sources, apply them in this order:

1. Current user request, unless it silently contradicts source canon.
2. Accepted divergences, as approved departures from source canon within their stated scope.
3. Approved stage handoffs, as downstream story state from prior stages.
4. Source bible, source references, and relevant source excerpts, as canon/reference material.
5. Current stage output, as editable work product.

If source canon conflicts with draft/stage material and no accepted divergence covers it, name the conflict and prefer the source-aware path. Do not invent a new canon fact to smooth over the conflict.

Style references are tone, rhythm, point of view, texture, and cinematic handling only. They are not source canon for plot, character facts, chronology, settings, or continuity.

## Lifecycle

1. Chat upload

   A writer can attach source through stage chat. Supported chat formats are `.pdf`, `.txt`, `.md`, `.fountain`, `.docx`, and `.fdx`. The upload is extracted to text, saved into project knowledge, and marked with stage/upload tags.

   The chat should show a short system note such as "Saved to project knowledge for reuse across stages." This is the first trust signal.

2. Source registry and source bible

   Saved uploads live in `knowledge.source_registry`. Each source keeps metadata, summary text, tags, type, storage mode, and references to stages that used it.

   The source bible is the compact source-facing summary. It includes source summaries and curated notes. It should stay compact and source-aware; it is not a raw transcript dump.

3. Compact memory snapshot

   `knowledge.memory_snapshot` is the compact assistant memory surface. It summarizes source bible context, stage handoffs, continuity items, accepted divergences, recent decisions, and source readiness.

   Assistants should prefer this snapshot before raw chat history. Raw stage chat can provide context, but it must not replace curated handoffs and snapshots as the cross-stage memory contract.

4. Stage handoff

   Approved stages should create or refresh `knowledge.stage_handoffs.stageN`. A handoff is the compact story state that later stages can trust.

   Missing handoffs are allowed but should be visible. The Project Knowledge inspector shows editable handoff slots for stages with output but no handoff. Stale handoffs are shown when a handoff is older than the latest approved version.

5. Source generation packet

   Generation and revision paths build a source-aware packet with:

   - memory/source contract
   - compact memory snapshot
   - relevant source documents
   - source bible summary
   - accepted divergences
   - continuity watchlist
   - stage-specific source profile and directives
   - source readiness warnings

   The chat/generation UI should show short "Using project memory" provenance with the top sources and handoffs. Keep this small so it builds confidence without clutter.

6. Source plan usage

   When generation uses source/project memory, source plan usage is recorded in `knowledge.stage_source_plans.stageN`. This ledger answers: "What source/memory packet guided that output?"

   Source plans can become stale when stage output changes, and invalidated when a referenced source is removed.

7. Source audit and readiness

   Source audits compare current stage output against saved project source material and accepted divergences. Results live in `knowledge.stage_source_audits.stageN`.

   Readiness is the stage-level trust state. It tells the app whether source memory is fresh enough, missing, stale, invalidated, resolved, or still carrying open findings.

8. Accepted divergence or source fix

   If audit findings are intentional, save an accepted divergence. This records the departure and lets later assistants follow it without reopening the same conflict.

   If findings are not intentional, apply source fixes and recheck. A fix decision should not be treated as fully confirmed until readiness is fresh again.

9. Source removal invalidation

   Removing a source invalidates dependent plans and audits. The inspector should show the invalidation reason and offer "Run Check Source" where the stage has output and saved sources.

## How Writers Know Memory Worked

The writer should see memory working without opening Project Knowledge:

- After upload, chat says the source was saved for reuse across stages.
- During chat or generation, a compact "Using project memory" note names top sources and handoffs.
- "What do you remember?" or "What do we already know about X?" gets an answer from compact project memory.
- Later stages carry forward prior-stage choices without the writer restating them.
- If a source conflict appears, the assistant names the conflict and follows accepted divergence rules.

If the assistant asks the writer to repeat obvious source facts or prior-stage decisions, treat that as a memory regression.

## When To Open Project Knowledge

Open Project Knowledge when:

- The assistant seems to be forgetting uploaded source material.
- A later stage appears to contradict source canon or a prior handoff.
- Readiness says "No source audit yet", "Audit stale", "Audit needs refresh", or "Issues found".
- A source was deleted or updated and old plans/audits may no longer be trustworthy.
- A stage has approved output but no handoff, or a handoff is stale.
- The writer wants to edit source metadata, source notes, continuity watchlist, or manual handoffs.

Do not require writers to open Project Knowledge for routine memory use. It is a debugging and repair console.

## Source Types And Default Tags

| Type | Default Tag | Use |
| --- | --- | --- |
| `source_material` | none | General upload when the app cannot infer a stronger type. |
| `source_reference` | `source_reference` | Canon/reference material such as source text, bible, graphic novel notes, plot documents, or factual constraints. |
| `style_reference` | `style` | Tonal or voice references. These guide style only and must not become plot canon. |
| `script_reference` | `script` | Screenplay/draft/script material, including `.fountain` and `.fdx` when detected as script-like. |
| `development_notes` | `notes` | Writer notes, adaptation notes, coverage notes, and other project-development material. |

Additional tags can include origin and stage markers such as `chat_upload`, `stage_upload`, `project_upload`, and `stage2`. File-specific tags include `pdf`, `docx`, `markdown`, and `screenplay`.

## Readiness States

| Status | Meaning | Operator Action |
| --- | --- | --- |
| `no_sources` | No saved sources are available. | Assistant can proceed, but should not claim source-backed certainty. |
| `needs_audit` | Saved sources exist, but this stage has no usable audit, or the audit was invalidated. | Run Check Source before treating the stage as source-trusted. |
| `stale` | Stage output changed after the last audit. | Run Check Source again before approval or downstream reliance. |
| `issues` | The latest audit has unresolved findings. | Apply fixes or save an accepted divergence. |
| `resolved` | Audit findings were addressed or accepted after the audit. | Proceed, but recheck if the stage output changes again. |
| `fixed_since_audit` | Source fixes were applied after the last audit. | Recheck to confirm alignment. |
| `ready` | Fresh audit with no open findings. | Trust the stage as source-ready. |

Invalidated plans/audits are not the same as ordinary staleness. They mean referenced source material changed or was removed. The inspector should show the reason and ask for a fresh check.

## Regression Expectations

Default regression coverage should remain deterministic:

- No live AI calls in `npm run test:knowledge`.
- No browser dependency in `npm run test:knowledge`.
- No route tests that require `app.listen(0)` unless a no-listen harness or dependency such as `supertest` is intentionally added.
- Browser smokes can still be used for user-facing confidence, but they should be labeled as Playwright fallback when strict Browser plugin control is unavailable.

As of 2026-05-10, the source lifecycle is covered in two ways:

- Playwright fallback smoke verified the user-facing loop from chat upload through source plan, source audit, accepted divergence, memory curation, inspector visibility, and later-stage recall.
- `test/knowledge.test.js` includes a deterministic helper-level lifecycle regression that covers the same memory contract without browser, live AI, or server binding.

## Operational Notes

- Leave untracked `.vscode/` alone. Do not commit `.vscode/`.
- Do not rename persisted project data keys without an explicit migration plan.
- Keep memory compact. Prefer handoffs, snapshots, source plans, and audits over raw transcript expansion.
- Treat Project Knowledge as a confidence surface for the writer, not as an extra chore the writer must perform before assistants can remember.
