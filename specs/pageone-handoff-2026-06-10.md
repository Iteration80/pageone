# PageOne Handoff - 2026-06-10

## Purpose

PageOne is a staged AI-assisted screenplay development app. It guides a project from initial pitch through outline, characters, beats, treatment, scenes, style, draft, coverage, and rewrite planning. Each stage has a dedicated agent in `agents/`, an SOP/prompt file in `skills/`, UI rendering in `public/app.js`, and persistence through JSON project records.

The core product goal is to let a writer iteratively build and revise a screenplay while preserving project context across stages. The app is not just a one-shot generator: it tracks approvals, user notes, stage revisions, stale downstream stages, conversations, style choices, imports, exports, cost usage, and rewrite priorities.

## Main Architecture

### Runtime

- `server.js` is the Express app. It serves the frontend, owns API routes, loads/saves project JSON, wires model settings into agents, tracks API usage, handles import/export, and coordinates stage generation.
- `public/app.js` is the main browser application. It owns project loading, stage navigation, rendering, approval flows, chat windows, regeneration requests, export requests, and a lot of client-side normalization.
- `public/index.html` and `public/style.css` define the main UI shell.
- `agents/ai-client.js` abstracts Gemini and Anthropic calls.
- `agents/agent_*.js` are stage-specific generation/revision agents.
- `skills/skill_*.md` are the stage SOPs. These are high-leverage files because they shape model behavior.
- `agents/export.js` builds DOCX exports and stage-specific output formatting.
- `utils/stageMetadata.js` handles stage ordering, generated/revised stamps, and stale downstream stage metadata.
- `test/` contains Node test files, with the prompt regression tests currently the most relevant suite for Stage 3 behavior.

### Project Data

Projects are stored as JSON files. By default, local project data lives under `data/projects/`, but deployments may use `DATA_ROOT`, which changes the active project storage root. This matters a lot when debugging "the webserver is not showing my code" problems.

Important data concepts:

- `stage1_pitch`, `stage2_outline`, etc. store stage outputs.
- `stage{N}.notes` or stage-specific notes are used by revision flows.
- `conversations.stageN` stores assistant chat history.
- `_meta` on stage data stores generated/revised/stale metadata.
- `apiUsage` stores model token usage/cost-tracking records.
- `stage7_style` stores the selected style slug.

## Stage Order

1. Pitch
2. Outline
3. Characters
4. Beats
5. Treatment
6. Scenes
7. Style
8. Draft
9. Coverage
10. Rewrite

## Recent Focus: Stage 3 Tiered Characters

The current active work has been to stop Stage 3 from overdesigning every character. The old behavior pushed every named or utility role through a full psychological profile: ghost/wound, lie, fear, desire, psychological need, moral need, voice tags, ticks, paradoxes, hidden MBTI/Enneagram-style deep profiles, and relationship maps.

That is useful for major arc-bearing characters, but it makes one-scene and scene-utility roles feel artificially engineered and over-constrains downstream drafting.

The intended behavior is now a three-tier character system.

### Tier 1: Full Psychological Profiles

Use for major or recurring arc-bearing characters with real internal change or sustained moral/psychological pressure.

For the I.M.A.G.I.N.E. project, the Tier 1 names are:

- Rebecca
- Dapple
- Dave
- Terry
- Elliot
- Furdlegurr
- Blounder
- Quist
- Scott
- Robotobob

Tier 1 may include:

- `psychological_core`
- `voice_and_behavior`
- `arc`
- `ticks` only when useful and visible
- `_deep_profile`
- relationship dynamics

### Tier 2: Functional Supporting Profiles

Use for recurring or supporting characters who affect story movement but do not need a full therapeutic arc.

For the I.M.A.G.I.N.E. project, the Tier 2 names are:

- Pono
- Moog
- Big Doll
- Pretz

Tier 2 should use:

- `functional_profile.narrative_function`
- `functional_profile.emotional_truth`
- `functional_profile.comic_or_tension_function`
- `functional_profile.pressure_behavior`
- `functional_profile.voice_flavor`

Tier 2 should not receive ghost/wound, lie, fear engine, psychological need, moral need, full arc machinery, ticks, paradoxes, MBTI/Enneagram logic, or relationship maps unless the writer explicitly promotes that character to a full arc-bearing role.

### Tier 3: Scene Utility / Cameo Profiles

Use for one-scene or near-one-scene characters whose job is to help the writer play the scene quickly.

For the I.M.A.G.I.N.E. project, the Tier 3 names are:

- Molly
- Dylan
- Dylan's parents
- Ms. Alvarado
- Carol
- Brenda
- Vance
- Gary
- Tyler

Tier 3 should use only:

- `cameo_profile.scene_purpose`
- `cameo_profile.casting_energy`
- `cameo_profile.playable_behavior`
- `cameo_profile.line_style_example`

Tier 3 must not receive:

- Ghost & Wound
- The Lie
- Fear
- Psychological Need
- Moral Need
- full arcs
- ticks
- paradoxes
- hidden deep profiles
- MBTI/Enneagram logic
- relationship maps

## What Has Been Changed For Tiering

The tiering work appears in several places:

- `agents/agent_3_characters.js`
  - Adds `profile_tier`.
  - Adds Tier 1/2/3 project-name lists.
  - Normalizes known project names into the intended tiers.
  - Strips `psychological_core`, `voice_and_behavior`, `arc`, and `_deep_profile` from non-Tier 1 characters.
  - Keeps Tier 2 fields under `functional_profile`.
  - Keeps Tier 3 fields under `cameo_profile`.
  - Updates the Stage 3 schema and prompt text to instruct tiered output.

- `public/app.js`
  - Mirrors character normalization on the frontend so rendered cards and scraped DOM data do not resurrect full psychological fields for minor characters.
  - Should render Tier 2 and Tier 3 with lighter sections rather than empty full-profile sections.

- `agents/export.js`
  - DOCX export should show tier labels and should use tier-appropriate sections.
  - Current exports should include labels like `Tier 1 - Full Profile`, `Tier 2 - Functional Supporting`, or `Tier 3 - Scene Utility / Cameo`.

- Downstream agent/skill files
  - Drafting, beats, treatment, coverage, and rewrite prompts have been adjusted so minor character guidance is not treated as binding psychological machinery.

- `test/prompt_regression.test.js`
  - Regression coverage was added/updated to assert that cameo/minor characters are not given full psychological profiles by default.

## Local Verification Already Done

The tier system was tested locally in two ways.

### Direct Agent Test With Fake Project

A fake "Moon Market" project was created in a local script/test harness. The mocked model intentionally returned overdesigned Tier 2/Tier 3 characters. The Stage 3 agent's normalization corrected the result:

- Tier 1 characters retained full profiles.
- Tier 2 characters retained only `functional_profile`.
- Tier 3 characters retained only `cameo_profile`.
- Non-Tier 1 characters had `psychological_core`, `voice_and_behavior`, `arc`, and `_deep_profile` removed or emptied.

### Live Server Route Test

The local webserver path was also tested with a temporary project:

- Started `node server.js`.
- Created a temp project under `data/projects`.
- Called `POST /api/generate-characters`.
- Called `GET /api/export/docx/:projectId?stage=characters`.
- Exported a DOCX and inspected its text.

The generated fake cast had clean tiers:

- Asha Vale: Tier 1
- Vesper: Tier 1
- Dockmaster Remy: Tier 2, with no full psychological sections
- Ticket Clerk: Tier 3, cameo-only
- Molly: Tier 3, cameo-only

The exported DOCX also showed the correct tier labels and tier-specific sections.

## Tests Recently Run

These commands passed during the tiering/debugging work:

```sh
node --check agents/agent_3_characters.js
node --check public/app.js
node --check agents/export.js
node --check server.js
node --test test/prompt_regression.test.js
npm run test:knowledge
```

For this handoff file itself, no tests are required beyond checking the Markdown.

## Main Problem We Have Been Facing

The user regenerated I.M.A.G.I.N.E. characters on a webserver and still received old-style full psychological profiles for minor characters. The attached DOCX did not show the three-tier export format.

The important diagnosis: that DOCX was almost certainly not generated by the current local code.

Why:

- The current `agents/export.js` path emits tier labels for character exports.
- The attached DOCX lacked those tier labels.
- Browser cache alone cannot explain that, because DOCX export is server-side.
- Local live-route testing against the current server produced correct tiers and correct DOCX sections.

Most likely causes:

- The deployed/webserver Node process was stale and had not been restarted after code changes.
- The browser was pointed at a different server/port/check-out than the workspace being edited.
- The deployment was built from git HEAD while the tiering changes were only local/uncommitted at that time.
- The server was using a different `DATA_ROOT` and therefore a different project store than the local workspace.
- Existing saved project data still contained old full profiles and needed migration or regeneration through the updated server.

There was also a clue that local `data/projects-manifest.json` did not appear to contain the I.M.A.G.I.N.E. project the user was viewing, which suggests a project-store mismatch.

## Outstanding Items

### 1. Prove The Webserver Is Running Current Code

Add an obvious build/version fingerprint to the app and/or API.

Suggested implementation:

- Expand `GET /health` to include commit, deployment id, and maybe a short app build timestamp.
- Surface that same value somewhere in the UI footer or Settings modal.
- Include the build fingerprint in DOCX export metadata or a hidden/export footer while debugging.

This will make stale-server and wrong-checkout problems immediately visible.

### 2. Confirm Active Data Root

When debugging project mismatch, log or expose:

- `DATA_ROOT`
- project directory path
- project id
- deployment commit
- whether `APP_SECRET` is active

Be careful not to expose secrets.

### 3. Add A Route-Level Integration Test

The direct agent tests are useful, but the user-facing failure happened through the webserver/export path. Add a test that mocks the AI call and verifies:

- `POST /api/generate-characters` returns tiered characters.
- Tier 3 characters do not include full psych fields.
- DOCX export text uses Tier 3 cameo sections and not full Psychological Core sections.

### 4. Add An Existing-Project Migration/Repair Path

Old saved projects can still contain full psychological profiles for minor characters. The current normalization helps when data flows through Stage 3, frontend render, or export, but a deliberate repair action would be clearer.

Possible options:

- Add a one-off script to normalize `stage3_characters` in saved projects.
- Add an admin/dev-only API endpoint to normalize a project.
- Add a frontend "Repair Stage 3 tiers" action in dev mode.

### 5. Centralize Tier Constants

The tier lists and tier-normalization logic are duplicated across backend/frontend/export paths. That is fragile.

Better long-term shape:

- Put shared tier constants and helpers in a CommonJS utility, such as `utils/characterTiers.js`.
- Use that from `agents/agent_3_characters.js`, `server.js`, and `agents/export.js`.
- For frontend use, either expose a serialized config from the server or generate a small public config file.

### 6. Make Project-Specific Tiering Configurable

The I.M.A.G.I.N.E. tier lists are hardcoded right now because they were needed to correct a specific project quickly. That is not ideal for future projects.

Longer-term options:

- Store tier overrides in project data.
- Let Stage 3 generate tiers dynamically, then allow the user to edit tier assignments.
- Keep known-project tier maps in a config file keyed by project title/id.
- Add "character tiering notes" to the Stage 3 prompt as project-specific context.

### 7. Verify Frontend Rendering Visually

The server and DOCX paths were tested, but the browser UI should still be visually checked:

- Create a fake project.
- Generate characters.
- Confirm Tier 2 cards do not show empty Psychological Core sections.
- Confirm Tier 3 cards show only Scene Purpose, Casting Energy, Playable Behavior, and Line Style.
- Confirm scraping/saving the rendered cards does not reintroduce old full-profile fields.

### 8. Deployment/Restart Discipline

Before asking the user to retest on a webserver:

- Commit the tiering changes.
- Deploy from the commit that contains them.
- Restart the Node process.
- Confirm `/health` or an equivalent fingerprint matches the expected commit.
- Regenerate or repair the existing project data.
- Export a fresh DOCX and verify tier labels are present.

## Local Dev Notes

### Start App

```sh
npm start
```

or:

```sh
node server.js
```

The app requires Node 20 or newer.

### Useful Test Commands

```sh
node --test test/prompt_regression.test.js
npm run test:knowledge
```

### Environment Variables

Common variables:

- `GEMINI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GEMINI_MODEL`
- `APP_SECRET`
- `DATA_ROOT`
- `ALLOW_RUNTIME_API_KEYS`

Deployment notes live in `DEPLOYMENT.md`.

### Auth

If `APP_SECRET` is set, API requests must include the shared key. Without it, localhost runs unauthenticated.

## Important Files For The Next Developer

- `CLAUDE.md`: project instructions and historical changelog.
- `DEPLOYMENT.md`: Railway/private tester deployment notes.
- `server.js`: API, persistence, generation routes, export routes.
- `agents/agent_3_characters.js`: current Stage 3 tiering logic and schema.
- `skills/skill_stage3_characters.md`: Stage 3 SOP. Keep this aligned with schema changes.
- `public/app.js`: frontend rendering, stage state, and client-side normalization.
- `agents/export.js`: DOCX/PDF export formatting.
- `utils/stageMetadata.js`: stage order and stale-stage metadata.
- `test/prompt_regression.test.js`: prompt/behavior regression coverage.
- `data/projects/`: local project JSON, normally gitignored.
- `data/settings.json`: local settings/API keys, gitignored.

## Suggested Next Steps

1. Add a build/version fingerprint and expose it in `/health`, UI, and optionally DOCX exports while debugging.
2. Confirm the webserver target is the same checkout and same `DATA_ROOT` the user expects.
3. Commit and deploy the current tiering code.
4. Restart the server process.
5. Regenerate or repair the I.M.A.G.I.N.E. Stage 3 data.
6. Export characters again and confirm tier labels appear.
7. Add route-level integration tests for generation plus DOCX export.
8. Centralize character-tier helpers so the backend, frontend, and exporter cannot drift.

## Working Theory For The Current User-Visible Bug

The tier system is working locally in the current code path. The continued failure on the user's webserver is probably an environment/version/data mismatch, not the Stage 3 agent alone.

The fastest way to prove or disprove that theory is to add a build fingerprint, restart/deploy, and compare the fingerprint shown by the webserver against the commit containing the tiering changes.
