# PageOne — Changelog Archive

*Entries moved here from CLAUDE.md when they're older than ~2 weeks or superseded. Kept for reference.*

---

### 2026-03-18 — Gemini model name made configurable
All 19 hardcoded `'gemini-3.1-pro-preview'` strings across `agents/*.js` replaced with `process.env.GEMINI_MODEL`.

**Superseded by:** 2026-03-19 per-stage model selection (see CLAUDE.md).
