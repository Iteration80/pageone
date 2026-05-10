# PageOne — Changelog Archive

*Entries moved here from CLAUDE.md when they're older than ~2 weeks or superseded. Kept for reference.*

---

### 2026-05-10 - Source upload picker widened beyond PDF
Stage 1 direct source upload and trained style uploads now advertise `.pdf`, `.txt`, `.md`, `.fountain`, `.fdx`, and `.docx`, and direct generation uploads extract non-PDF text before prompting.

### 2026-05-10 - Assistant memory lifecycle verified
Added Project Knowledge operator notes covering upload-to-memory lifecycle, source readiness states, source types/tags, and when writers should open Project Knowledge.

Assistant memory smoke, cross-stage workflow, lifecycle Playwright fallback smoke, and deterministic lifecycle regression are passing.

### 2026-03-18 — Gemini model name made configurable
All 19 hardcoded `'gemini-3.1-pro-preview'` strings across `agents/*.js` replaced with `process.env.GEMINI_MODEL`.

**Superseded by:** 2026-03-19 per-stage model selection (see CLAUDE.md).
