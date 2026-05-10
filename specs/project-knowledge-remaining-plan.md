# Assistant Memory Remaining Plan

*Created: 2026-05-10*
*Updated: 2026-05-10*
*Status: Reframed around the original goal: make the stage chat assistants remember user uploads and prior-stage decisions so the writer has to micromanage less.*

---

## North Star

The feature is not "a Project Knowledge modal." The feature is an assistant that feels less forgetful.

The Project Knowledge inspector is a control panel for debugging and correcting memory. It should support the workflow, but the primary success condition is this:

> A writer uploads source material or gives important direction once, and later stage assistants use it naturally without making the writer repeat themselves.

The remaining work should therefore be judged by assistant behavior first, inspector completeness second.

---

## Current Baseline

Recent completed work:

- `27fa789 Add persistent project knowledge memory`
- `41cd9c2 Add project knowledge source intake`
- `65ca88b Add source generation packet contract`
- `b796018 Add agent memory source contracts`
- `3a57c2d Enhance project knowledge inspector`
- `a9aeb1d Add project knowledge review regression`
- `9f03e16 Invalidate source ledgers on removal`

What is already in place:

- Chat attachments can be persisted into project knowledge through `persistChatAttachmentToKnowledge()`.
- Stage generation/revision paths receive source-aware context through `buildKnowledgeContextBlock()` and `buildSourceGenerationPacket()`.
- Agents have a memory/source contract that tells them how to rank user notes, accepted divergences, stage handoffs, source bible/references, and current stage output.
- Source plans record what memory/source packet a generation used.
- Source audits/readiness guard against drift.
- Approved stages can create compact handoffs and memory snapshots.
- The Project Knowledge modal can inspect source bible, memory snapshot, diagnostics, ledgers, source metadata, and manual memory review.
- `npm run test:knowledge` passes with 25 tests.

Known caveat:

- The strict Browser plugin hook was unavailable in the active session. The Phase 18 smoke was run with a real Chromium Playwright fallback. A strict Browser-plugin smoke should be rerun after restarting Antigravity or opening a fresh Codex session.

---

## Priority 1: Assistant Memory Efficacy Smoke

Goal: Prove the assistant actually remembers uploads and prior-stage decisions in normal chat/generation behavior.

Core question:

- Can the writer stop repeating uploaded source canon and prior-stage decisions?

Recommended smoke:

- Create a temporary project.
- Upload a tiny source file in an early stage chat, for example: "Mara finds the blue key in the flooded arcade."
- Ask the same or later assistant a question that requires the uploaded fact, without restating the fact.
- Approve or seed a stage handoff with a compact decision.
- Move to a later stage and ask/generate something that depends on both the uploaded source and the handoff.
- Reopen the project and confirm the assistant still has the memory.
- Clean up temporary data.

Acceptance checks:

- The assistant uses uploaded source material without the user restating it.
- The assistant uses prior-stage handoff/memory in a later stage.
- The assistant distinguishes source canon from adaptation decisions or accepted divergences.
- The assistant does not hallucinate unsupported source facts when the memory packet is thin.
- The behavior survives project reload.
- The Project Knowledge modal can explain what memory/source data was available, but the user does not need to open it to make the assistant work.

Notes:

- Prefer a small deterministic fixture. Avoid live AI dependence where possible, but one real chat smoke is valuable because the goal is felt assistant behavior.
- Capture examples of good and bad assistant responses. They are more useful than raw ledger screenshots.

---

## Priority 2: Cross-Stage Memory Workflow

Goal: Verify the whole stage pipeline passes useful memory forward with minimal user intervention.

Tasks:

- Confirm Stage 1-6 approvals create useful handoffs or can refresh handoffs.
- Confirm Stage 7 style chat sees project/source context without treating style references as source canon.
- Confirm Stage 8 draft uses source material, compact memory, style, and continuity together.
- Confirm Stage 10 rewrite uses source material, accepted divergences, coverage priorities, and scene-specific context together.
- Confirm stage chat history remains persistent but does not replace the compact memory contract.

Acceptance checks:

- A later stage assistant can answer "what do we already know about X?" from project memory.
- A later stage generation carries forward prior-stage choices without the user restating them.
- If source canon conflicts with current draft material, the assistant names the conflict and follows the accepted divergence rules.
- Memory does not become a giant transcript dump; compact handoffs/snapshots stay preferred over raw chat history.
- `npm run test:knowledge` and prompt regression tests remain green.

---

## Priority 3: Less-Micromanagement Chat UX

Goal: Make memory visible at the moment of use, so the writer trusts the assistant without opening the inspector.

Tasks:

- When a chat upload is saved to project knowledge, show a concise system note that it is now reusable across stages.
- When generation uses source/project memory, show a small "using project memory" note or card with the top source/handoff names.
- Add a chat-accessible "what do you remember?" path per stage.
- Add a chat-accessible "forget/update that" path only if the source can be safely mapped to existing memory controls.
- Avoid making the writer manually run source plans/audits for routine work unless readiness says attention is needed.

Acceptance checks:

- The assistant gives enough memory provenance to build confidence.
- The provenance is short and does not clutter the chat.
- A user can tell whether an uploaded file was saved for future stages.
- A user can tell when the assistant is using prior-stage memory.
- The assistant asks fewer "remind me" questions in obvious cross-stage situations.

---

## Priority 4: Inspector Support For Memory Trust

Goal: Keep the inspector useful as a debugging/control surface, not as the main workflow.

Already implemented:

- Source bible, memory snapshot, diagnostics, source readiness ledger, source audit ledger, source plan ledger, source metadata editing, and manual review basics.
- Source deletion invalidates dependent plans/audits.

Tasks:

- Surface invalidated plan/audit state in the source plan ledger and source audit ledger.
- In current-stage summary, distinguish "no audit yet" from "audit needs refresh because source material changed."
- Add clear "Run Check Source" or equivalent action from invalidated/readiness surfaces where existing UI supports it.
- Add editable handoff slots for stages with output but no existing handoff.
- Show stale handoff status inline when a handoff is older than the latest approved version.

Acceptance checks:

- A project with invalidated plans/audits shows why memory needs attention.
- A project with missing handoffs gives the user a direct place to fill them in.
- Existing non-invalidated ledgers still look normal.
- Saving empty handoff slots does not create junk memory.
- `npm run test:knowledge` remains green.

---

## Priority 5: Full Source Lifecycle Browser Smoke

Goal: Test the user-facing loop from upload to remembered downstream use.

Recommended lifecycle:

- Upload source in chat.
- Generate or seed a stage output that depends on the source.
- Record source plan usage.
- Run source audit.
- Apply source audit fixes or accept a divergence.
- Approve/re-approve stage so memory curation/handoff updates are visible.
- Ask a later-stage assistant to use the prior memory without re-uploading.

Acceptance checks:

- Source plan is recorded and visible.
- Source audit is recorded and visible.
- Resolution decision appears in Recent Decisions or Accepted Divergences.
- Readiness state updates as expected.
- Memory Snapshot reflects the new handoff/decision after compaction.
- Later-stage assistant behavior confirms the memory is useful, not merely stored.
- Temporary project/source is removed if created for the smoke.

Browser note:

- Rerun strict Browser-plugin smoke after Antigravity restart if formal acceptance requires the Browser plugin specifically.
- Playwright fallback remains acceptable for local regression confidence, but should be labeled as fallback.

---

## Priority 6: Regression Coverage Strategy

Goal: Protect memory behavior without making normal tests brittle or dependent on live AI/network binding.

Current test shape:

- Helper-level tests cover source persistence, source plans, readiness, audits, memory review, deletion invalidation, memory contracts, and prompt injection.
- Direct route tests with `app.listen(0)` require escalated permissions in the current sandbox, so they are not suitable for default `npm run test:knowledge`.

Recommended path:

- Keep core memory contracts covered through exported-helper tests.
- Add prompt regression tests for any newly supported assistant memory behavior.
- Add route tests only if a no-listen harness is simple and stable, or if adding `supertest` is accepted.
- Avoid live AI in automated tests.

Acceptance checks:

- `npm run test:knowledge` runs without network binding or escalation.
- Tests verify the memory packet reaches every assistant path that claims to use it.
- Tests distinguish source canon, accepted divergence, current user note, and stage output precedence.

---

## Priority 7: Documentation and Operator Notes

Goal: Explain the memory system from the assistant-behavior point of view.

Tasks:

- Document the memory lifecycle:
  - user upload in chat
  - source registry/source bible
  - compact memory snapshot
  - stage handoff
  - source generation packet
  - source plan usage
  - source audit/readiness
  - accepted divergence or source-fix decision
  - source removal invalidation
- Document how a writer should know the assistant remembered something.
- Document when the writer should open Project Knowledge.
- Document source types and default tags.
- Document readiness states.
- Add a short changelog note once the assistant-memory smoke passes.

Acceptance checks:

- A future agent can understand why the system exists, not just how the ledgers are shaped.
- Docs explain when to trust memory and when to refresh/check it.
- Docs mention `.vscode/` remains untracked and should not be committed.

---

## Suggested Implementation Order

1. Run an assistant memory efficacy smoke with a temporary project/source.
2. Add chat UX that makes saved/used memory visible at the moment of use.
3. Verify cross-stage memory handoff from early stages into Stage 8 and Stage 10.
4. Surface invalidated plan/audit state in the Project Knowledge inspector.
5. Add missing/stale handoff editing ergonomics.
6. Run a full source lifecycle browser smoke.
7. Decide whether route-level tests are worth adding.
8. Write final architecture/operator docs.

This order keeps the next work aligned with the product goal: first make the assistant feel smarter, then make the inspector better at explaining and correcting that memory.

---

## Do Not Change Without A Specific Reason

- Do not rename persisted project data keys.
- Do not make source deletion reversible unless the product decision is explicit.
- Do not run live AI-dependent tests in the default automated suite.
- Do not commit `.vscode/`.
- Do not loosen source-canon precedence in the memory contract.
- Do not make the inspector the required path for routine memory use.
