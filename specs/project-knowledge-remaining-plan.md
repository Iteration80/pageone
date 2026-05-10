# Project Knowledge Remaining Plan

*Created: 2026-05-10*
*Status: Planning handoff after Project Knowledge Inspector smoke + regression hardening*

---

## Current Baseline

Recent completed work:

- `3a57c2d Enhance project knowledge inspector`
- `a9aeb1d Add project knowledge review regression`
- `9f03e16 Invalidate source ledgers on removal`

Verified behavior:

- Project Knowledge modal opens and renders Source Bible, Memory Snapshot, diagnostics, current-stage source status, used source packet, latest audit detail, source readiness ledger, source audit ledger, source plan ledger, and saved source metadata controls.
- Source metadata PATCH works through the UI.
- Manual memory review is covered by regression tests.
- Removing a source invalidates dependent cached plans/audits instead of leaving them looking fresh.
- `npm run test:knowledge` passes with 25 tests.

Known caveat:

- The strict Browser plugin hook was unavailable in the active session. The Phase 18 smoke was run with a real Chromium Playwright fallback. A strict Browser-plugin smoke should be rerun after restarting Antigravity or opening a fresh Codex session.

---

## Priority 1: Strict Browser-Plugin Acceptance

Goal: Produce a clean acceptance pass using the requested Browser plugin surface, not just Playwright fallback.

Tasks:

- Restart Antigravity or open a fresh Codex session so the Browser plugin execution hook is exposed.
- Start PageOne locally on `http://localhost:3000`.
- Open an existing project, or create a temporary project/source and clean it up afterward.
- Repeat the Project Knowledge modal smoke:
  - Modal opens and lays out cleanly.
  - Source Bible, Memory Snapshot, diagnostics, current-stage source status, used source packet, latest audit detail, readiness ledger, audit ledger, plan ledger, and saved source cards render.
  - Source type dropdown and tags input render.
  - Source metadata update persists.
  - Source deletion is tested only against a temporary source/project.

Acceptance checks:

- Browser plugin smoke result is recorded in the assistant summary.
- No console/page errors during the smoke.
- Temporary data created during the smoke is removed.
- Repo remains clean except untracked `.vscode/`.

---

## Priority 2: UI Surface for Invalidated Ledgers

Goal: Make the invalidation state from `removeKnowledgeSource()` visible and actionable in the Project Knowledge inspector.

Current backend behavior:

- Cached source plans with removed-source references get `invalidatedAt` and `invalidatedReason`.
- Source audits with removed-source references get `invalidatedAt` and `invalidatedReason`.
- Readiness returns `needs_audit` with `isAuditInvalidated`.
- Diagnostics emits `source_plan_invalidated` and `source_audit_invalidated`.

Tasks:

- In the source plan ledger, show invalidated state with date/reason.
- In the source audit ledger, show invalidated state with date/reason.
- In the current-stage summary, distinguish "no audit yet" from "audit needs refresh because source material changed."
- Add a clear "Run Check Source" or equivalent path from invalidated audit/readiness surfaces where the existing UI already supports source checks.

Acceptance checks:

- A project with an invalidated plan/audit displays the invalidation message without breaking layout.
- The readiness badge reads as needing attention, not as fresh/ready.
- Existing non-invalidated plans/audits look unchanged.
- `npm run test:knowledge` remains green.

---

## Priority 3: Full Source Lifecycle Browser Smoke

Goal: Test the real user loop across generation, audit, fix/accept, approval, and Project Knowledge inspection.

Recommended temporary fixture:

- Create a small project with a tiny text source.
- Generate or seed a stage output that references the source.
- Record or run a source plan.
- Run source audit.
- Exercise one resolution path:
  - Apply source audit fixes, or
  - Accept source divergence.
- Approve or re-approve the stage so memory curation/handoff updates are visible.

Acceptance checks:

- Source plan is recorded and visible.
- Source audit is recorded and visible.
- Resolution decision appears in Recent Decisions or Accepted Divergences.
- Readiness state updates as expected.
- Memory Snapshot reflects the new handoff/decision after compaction.
- Temporary project/source is removed if created for the smoke.

Notes:

- Avoid depending on live AI for this smoke unless explicitly desired. Prefer seeded safe test data when the goal is UI/API integrity.
- If live AI is used, record which provider/model settings were active.

---

## Priority 4: Manual Memory Review UX

Goal: Make memory review feel like a complete editor, not just a renderer for existing handoffs.

Current limitation:

- The modal only renders handoff textareas for existing `stage_handoffs` keys.
- If a stage has output but no handoff, the user cannot fill it from the Project Knowledge modal unless a row already exists.

Tasks:

- Render editable handoff slots for all relevant pipeline stages, or at least stages with approved/output data.
- Label empty slots clearly.
- Preserve the existing save behavior that sanitizes stage keys.
- Consider showing stale handoff status inline when a handoff is older than the latest approved version.

Acceptance checks:

- A project with no handoffs still shows empty handoff editors.
- Saving an empty slot does not create junk memory.
- Saving a filled slot persists as `manual_memory_review`.
- Invalid keys are still ignored server-side.
- Existing `test/knowledge_review.test.js` continues to pass.

---

## Priority 5: Route-Level Regression Coverage

Goal: Cover Project Knowledge routes without requiring local port binding in normal sandbox/CI runs.

Problem discovered:

- A direct HTTP route test with `app.listen(0)` fails under the default sandbox because binding local ports requires elevated permissions.

Options:

- Add a lightweight request harness that invokes Express handlers without opening a port.
- Add `supertest` if dependency churn is acceptable.
- Keep route tests as elevated/manual only and focus automated coverage on exported helpers.

Recommended path:

- Prefer exported-helper tests for core contracts.
- Add route tests only if a no-listen harness is simple and does not add brittle framework coupling.

Acceptance checks:

- `npm run test:knowledge` runs without network binding or escalation.
- Route coverage, if added, verifies status codes and response payload shape for:
  - `GET /api/projects/:id/knowledge`
  - `POST /api/projects/:id/knowledge/sources`
  - `PATCH /api/projects/:id/knowledge/sources/:sourceId`
  - `DELETE /api/projects/:id/knowledge/sources/:sourceId`
  - `PUT /api/projects/:id/knowledge/review`

---

## Priority 6: Documentation and Operator Notes

Goal: Make the source-memory system understandable without reading all of `server.js`.

Tasks:

- Document source types and default tags:
  - `source_material`
  - `source_reference`
  - `style_reference`
  - `script_reference`
  - `development_notes`
- Document readiness states:
  - `no_sources`
  - `needs_audit`
  - `ready`
  - `issues`
  - `stale`
  - `fixed_since_audit`
  - `resolved`
- Document ledger lifecycle:
  - source upload
  - source plan recording
  - source audit recording
  - fix/accepted divergence decision
  - source removal invalidation
  - memory review/compaction
- Add a short changelog note for the Project Knowledge architecture once the remaining acceptance smoke passes.

Acceptance checks:

- A future agent can understand the system from docs plus tests.
- Docs explain when to run source audit vs. when to rely on readiness.
- Docs mention `.vscode/` remains untracked and should not be committed.

---

## Suggested Implementation Order

1. Rerun strict Browser-plugin smoke after restart.
2. Surface invalidated plans/audits in the modal UI.
3. Add manual handoff slots for stages without existing memory.
4. Run a full source lifecycle browser smoke.
5. Decide whether route-level tests are worth adding.
6. Write final architecture/operator docs.

This order keeps the next work close to verified behavior: first confirm the app in-browser, then make the newest backend invalidation state visible, then improve editing ergonomics, then broaden coverage/docs.

---

## Do Not Change Without A Specific Reason

- Do not rename persisted project data keys.
- Do not make source deletion reversible unless the product decision is explicit.
- Do not run live AI-dependent tests in the default automated suite.
- Do not commit `.vscode/`.
- Do not loosen source-canon precedence in the memory contract.
