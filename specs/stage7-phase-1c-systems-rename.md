# Phase 1c — Re-Approval Flow, Chat Persistence, Import Target, Toolbar Slots

*Part of Stage 7 Style implementation. Execute AFTER Phase 1b (frontend rename) is verified.*
*Parent spec: `specs/stage-7-style-handoff.md`*

---

## Goal

Update the newer systems that were built after the original handoff was written. These all have stage numbers baked in and will break or misbehave if not updated. This phase is the highest risk for missed references — be thorough.

## Prerequisite

Phase 1a (server) and Phase 1b (frontend nav) are complete and verified.

---

## Files to Change

All changes are in `public/app.js` and `public/index.html` unless otherwise noted.

### 1. Re-Approval Flow (added 2026-03-22)

**Stage 3 re-approval modal** (`public/index.html` + `public/app.js`):
- The modal currently offers "Send to Stage 9 Rewrite" → change to **"Send to Stage 10 Rewrite"**
- In `app.js`: the navigation target that fires when user picks this option currently navigates to stage 9 → update to **stage 10**
- The `characterChangeContext` diff object is stored on the project and read by `/api/brainstorm-rewrite` init — the server-side target was updated in Phase 1a, but verify the frontend stores the correct target stage number in the context object

**Universal regen modal** (`showGenericRegenModal()` in `app.js`):
- This modal is used by Stages 2, 4, 5, 6 when re-approving
- It offers "Re-generate [Next Stage]" — verify all next-stage references are correct:
  - Stage 2 → Stage 3 (unchanged)
  - Stage 4 → Stage 5 (unchanged)
  - Stage 5 → Stage 6 (unchanged)
  - Stage 6 → Stage 7 (was also 7, but now 7=Style, not Draft — **this is the tricky one**)
- **Critical:** When Stage 6 (Scenes) is re-approved, the "next stage" for regen purposes should be Stage 8 (Draft), NOT Stage 7 (Style). Style doesn't get regenerated from Scene changes — it's independent. Verify the regen target for Stage 6 re-approval points to Stage 8.

**Stale stage indicators** (`updateStageNav()` in `app.js`):
- Reads `_meta.stale` from each stage's data and shows amber dot in sidebar
- `switchStage()` shows dismissable banner for stale stages
- Verify the stage number mapping is correct — if the stale logic uses a lookup like "stage N's data is at key stageN_*", the mapping needs to account for the renumbering

### 2. Import Flow (added 2026-03-21)

**`window.importedProjectTarget`** (`app.js`):
- Currently set to `8` (sends imported scripts to Stage 8 Coverage) → update to **`9`** (Coverage is now Stage 9)
- Search for all references to `importedProjectTarget` and verify they land on the correct stage

**`openProject()` import handling:**
- Verify the flag check that skips to the target stage works with the new numbering

### 3. FountainEditor Toolbar Slots (added 2026-03-21)

**DOM IDs in `index.html`:**
- `#stage7-sticky-header` → rename to **`#stage8-sticky-header`** (this is Draft's sticky header)
- `#stage9-toolbar-slot` → rename to **`#stage10-toolbar-slot`** (this is Rewrite's toolbar slot)

**`app.js` references:**
- `stage7LoadEditor()` → rename function to **`stage8LoadEditor()`** (or whatever convention is used)
- The `FountainEditor` instantiation that passes `externalToolbarSlot` for Draft: update the DOM element reference to `#stage8-sticky-header`
- The `FountainEditor` instantiation for Rewrite: update the DOM element reference to `#stage10-toolbar-slot`

**CSS in `style.css`:**
- `#stage7-toolbar-slot:empty` → `#stage8-toolbar-slot:empty`
- `#stage9-toolbar-slot:empty` → `#stage10-toolbar-slot:empty`
- Any other CSS selectors referencing these IDs

### 4. Chat Persistence (added 2026-03-19)

**Frontend (`app.js`):**
- `const stageChatWindows = {}` — verify the keys used match new stage numbering
- All `initStageChat()` calls — verify stage numbers passed are correct
- `openProject()` restore logic: loads conversations from `projectData.data.conversations.stageN`
  - **Data keys don't change** (per "don't rename data keys" rule)
  - But the mapping of "which UI stage reads which conversation key" needs updating
  - Example: UI Stage 8 (Draft) should read from `conversations.stage7` (the old key), not `conversations.stage8`
  - UI Stage 9 (Coverage) reads from `conversations.stage8`
  - UI Stage 10 (Rewrite) reads from `conversations.stage9`
  - UI Stage 7 (Style) is new — it reads from `conversations.stage7_style` (new key) or a new namespace
- `restoreHistory()` calls — verify correct conversation data is loaded into correct chat windows

**Server (`server.js`) — verify Phase 1a covered this:**
- `/api/brainstorm` endpoint: saves to `projectData.data.conversations.stageN` — since data keys don't change, the server-side mapping of "which stage number maps to which data key" must be updated
- Prior-stage conversation injection: when building system prompts for later stages, verify the correct prior conversations are loaded

### 5. Approve Button State Logic (added 2026-03-19)

- The approve button disable/re-enable logic was fixed for Stages 2-6. Stage 7 (Style) will need its own approval logic (handled in Phase 2), but verify the existing stages still have correct numbering in their handlers.
- Stage 8 (was 7 Draft) approval flow — verify the approve handler references the correct stage number.

---

## Verification

After completing all changes:

1. **Re-approval flow:**
   - Open a project with completed Stage 3
   - Edit a character → re-approve → verify modal shows "Send to Stage 10 Rewrite" option
   - Click it → verify navigation lands on Stage 10 (Rewrite), not Stage 9
   - Re-approve Stage 6 → verify regen modal targets Stage 8 (Draft), not Stage 7 (Style)

2. **Import flow:**
   - Import a .fountain file → verify it lands on Stage 9 (Coverage), not Stage 8

3. **FountainEditor:**
   - Navigate to Stage 8 (Draft) → generate a scene → verify toolbar appears in sticky header
   - Navigate to Stage 10 (Rewrite) → verify toolbar appears in correct slot

4. **Chat persistence:**
   - Open an existing project (created before rename) → verify chat history loads into correct stages
   - Send a message in Stage 8 (Draft) chat → refresh → verify it persists
   - Check that Stage 7 (Style) chat is empty/independent

5. **No console errors** across all stage navigation

---

*After this phase is verified, the rename surgery is complete. Proceed to `stage7-phase-2-style-feature.md`.*
