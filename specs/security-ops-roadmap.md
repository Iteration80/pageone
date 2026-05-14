# PageOne Security and Ops Roadmap

Created: 2026-05-13

## Scope

This roadmap is for the current PageOne private tester deployment: a Node/Express app on Railway, static frontend, file-backed project storage, server-side AI provider keys, and a shared access key via `APP_SECRET`.

The X.com list is directionally useful, but several items target a different product shape than PageOne has today. PageOne currently has no SQL database, Stripe webhooks, password reset flow, email system, image hosting pipeline, per-user accounts, or admin role model. The work that matters now is private-tester hardening: fail-closed deployment, broader rate limiting, request validation, session/secret lifecycle, backups, and production observability.

## Current Posture

Already present:

- Shared-secret API protection is available when `APP_SECRET` is set.
- The frontend exchanges the shared access key for a short-lived signed session token stored in `sessionStorage`, not `localStorage`.
- AI-heavy routes use `express-rate-limit`; trained style generation has a stricter limiter, and AI routes enforce per-session daily request ceilings plus project-scoped daily token/cost ceilings.
- `/health` exists for platform monitoring.
- Uploads use `multer.memoryStorage()` with a 25 MB file-size cap and extension/MIME filtering.
- Project IDs and style slugs have explicit validation; file writes are atomic and queued per project.
- Security headers are set, including `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, and a CSP.
- Deployment docs tell Railway private testers to set `APP_SECRET`, `DATA_ROOT`, and server-side provider keys.
- Production startup now fails closed when critical env vars, persistent storage, or model/provider config are missing.
- `/api` has baseline write/upload limits, AI routes have concurrency caps, and auth failures are rate-limited.
- Requests now get structured logs with request IDs; key project/settings/source/export actions emit audit events.
- Private smoke and backup scripts are available via `npm run smoke:private` and `npm run backup:data`.
- Restore and backup-drill scripts are available via `npm run restore:data` and `npm run drill:backup`.
- Project listing now uses `projects-manifest.json` with paginated `/api/projects` responses instead of reading every project JSON file.
- High-risk request bodies now pass explicit runtime validation for AI stage generation, brainstorm/rewrite chat, source-audit flows, style routes, script import, knowledge edits, project updates, and settings writes.
- Auth now uses `/api/auth/session` to issue expiring signed bearer sessions from root or per-tester access keys; direct `APP_SECRET` API reuse is disabled unless `ALLOW_DIRECT_APP_SECRET_AUTH=true`.
- `ACCESS_KEYS`/`ACCESS_KEYS_FILE` can label tester/admin sessions, and admin-only routes now protect settings, script import, project deletion, style edit/delete, and exports.
- Structured logs can be mirrored to `LOG_FILE_PATH` and/or a best-effort HTTPS `LOG_DRAIN_URL`.
- Runtime frontend script CDNs have been removed; Stage 6 drag/drop is local, and CSP now keeps `script-src` self-only with inline event-handler attributes blocked.
- `npm run audit:security` checks CSP, frontend CDN/script-handler regressions, core admin gates, and required ops scripts.
- `npm run preflight:private` runs the security audit, regression tests, backup/restore drill, and optional deployed smoke test when smoke env vars are present.

Main gaps:

- Sessions are stateless, so individual active-session revocation requires rotating `AUTH_SESSION_SECRET` or shortening `AUTH_SESSION_TTL_MS`.
- Access labels now appear in audit logs, and key rotation is documented; production still needs an owner and calendar for periodic rotation.
- Runtime API key storage remains possible outside the production/shared-secret path.
- Runtime validation is broader now, but still hand-rolled rather than centralized through Zod/Ajv with inferred types and reusable tests.
- Logging is structured and can be mirrored, but a production Railway log drain/external sink still needs to be configured.
- Backup/restore scripts and a local drill exist, but scheduled off-platform retention is still manual.
- The UI is a single large vanilla JS app; a top-level runtime fallback exists, but localized recovery around each major workspace is still limited.
- CSP still allows inline styles because the app uses many static and dynamic `style` attributes; removing `style-src 'unsafe-inline'` is a future refactor.
- The app is JavaScript-only; no TypeScript or runtime schema boundary currently protects cross-file contracts.

Deferred production-access follow-up:

- Tackle another day: set the real Railway env vars/access keys, configure a Railway log drain or external log sink, schedule off-platform `DATA_ROOT` backups, and run `SMOKE_BASE_URL=<deployed-url> SMOKE_ACCESS_KEY=<admin-key> npm run preflight:private` against production.

## X.com List Triage

| Item | Applies to PageOne? | Status | Recommendation |
| --- | --- | --- | --- |
| 1. No rate limiting on API routes | Yes | Improved | Baseline `/api`, write/upload, auth-failure, AI route, AI concurrency, daily session AI request, and daily project AI token/cost ceilings are in place. |
| 2. Auth tokens in localStorage | Partly | Improved | Access key is exchanged for an expiring signed session in `sessionStorage`; add per-tester keys/labels before wider beta. |
| 3. No input sanitisation | Yes | Improved | No SQL layer. Broad route validation now exists for high-risk bodies; migrate it into central schemas next. |
| 4. Hardcoded API keys in frontend | Yes | Mostly OK | Keys are deployment-managed when `APP_SECRET` is set. Fail closed in production if runtime keys are enabled unintentionally. |
| 5. Stripe webhook signatures | No | N/A | Revisit only if payments are added. |
| 6. No DB indexes | No current DB | N/A now | If storage moves to Postgres/SQLite, design indexes before migration. For current files, add a project manifest. |
| 7. No UI error boundaries | Yes | Improved | Global `error`/`unhandledrejection` fallback exists; add localized recovery states around major workspace renders. |
| 8. Sessions never expire | Yes | Improved | Server-issued signed sessions expire; key rotation is documented. |
| 9. No pagination | Yes | Improved | `/api/projects` is paginated and backed by a lightweight manifest. |
| 10. Password reset links never expire | No | N/A | Revisit if per-user accounts are introduced. |
| 11. No env validation at startup | Yes | Improved | Startup validation with production fail-fast rules is in place. |
| 12. Images uploaded to server | No | N/A now | Current uploads are docs/scripts. If images are added, use object storage/CDN rather than the app server. |
| 13. No CORS policy | Partly | Improved | Express does not send permissive CORS headers, and API requests now reject unexpected origins unless allowlisted. |
| 14. Emails sent synchronously | No | N/A | Revisit if email is added; use async queue/provider webhooks. |
| 15. No DB connection pooling | No DB | N/A | Revisit during DB migration. |
| 16. Admin routes without roles | Partly | Improved | Access keys can issue tester/admin sessions; settings, import, project deletion, style edit/delete, and exports require admin. |
| 17. No health endpoint | Yes | OK | `/health` exists. Consider adding deeper readiness checks later. |
| 18. No production logging | Yes | Improved | Structured request/error/audit logs exist and can mirror to file/HTTP. Configure the production sink next. |
| 19. No backup strategy | Yes | Improved | Backup, restore, and local drill scripts exist. Add scheduled off-platform retention next. |
| 20. No TypeScript | Yes | Gap | Not the first fire, but start an incremental TS/runtime-schema path. |

## Roadmap

### Phase 0: Production Fail-Closed Baseline

Target: before inviting the next tester.

- Add `validateEnv()` at startup.
- In production, require `APP_SECRET`, `DATA_ROOT`, at least one AI provider key, and a non-default model.
- Enforce minimum `APP_SECRET` length and reject obvious placeholders.
- Fail startup if `DATA_ROOT` is not writable.
- Fail startup if `ALLOW_RUNTIME_API_KEYS=true` in production unless an explicit override is set.
- Change `npm test` to run the existing test suite instead of failing by design.
- Add a private-tester smoke script that checks `/health`, unauthenticated `/api/projects` 401, authenticated `/api/projects` 200, create project, and export readiness.

### Phase 1: Abuse and Cost Controls

Target: 1-2 engineering days.

- Done: add a baseline limiter for all `/api/*` routes.
- Done: add a stricter unauthenticated/auth-failure limiter before `requireAuth`.
- Done: add upload-specific limits for script/source/style upload endpoints.
- Done: add a global concurrent-AI-job cap so one tester cannot saturate the server.
- Done: add per-session daily AI request ceilings and per-project daily AI usage ceilings using the existing `apiUsage` tracking.
- Done: return clear 429 responses with retry guidance.

### Phase 2: Observability and Backups

Target: 1-2 engineering days.

- Done: add structured request logging: request ID, method, route, status, duration, response size, IP hash.
- Done: add sanitized error logging with route context and project ID when present.
- Done: add audit events for project create/delete, settings changes, source uploads/deletes, exports, and session events.
- Done: add optional log mirroring to `LOG_FILE_PATH` and `LOG_DRAIN_URL`.
- Configure Railway log drain or equivalent external retention.
- Done: document and automate backup, restore, and local restore drill paths for `DATA_ROOT`.
- Add scheduled archive, off-platform storage, and retention policy.
- Done: add a pre-migration/pre-deploy backup checklist.
- Done: add an executable private beta preflight command.

### Phase 3: Request Validation and Data Scaling

Target: private beta hardening.

- Convert the current hand-rolled validators into a runtime schema validator such as Zod or Ajv.
- Add route-level validation tests for invalid payloads and oversized bodies.
- Continue hardening the project manifest with repair/admin tooling if manual data imports become common.
- Bound large arrays in project data where practical: usage records, version history, source registry summaries, and chat histories.

### Phase 4: Auth Lifecycle

Target: before more than a handful of testers.

- Done: replace direct shared-secret reuse with an unlock flow that issues a short-lived signed session.
- Done: add visible logout and expiring browser session storage.
- Done: add shared-secret and per-tester key rotation docs.
- Done: add optional per-tester labels or access keys for audit attribution.
- Consider refresh/renewal if tester sessions need to last longer than `AUTH_SESSION_TTL_MS`.
- Before public beta, move to real per-user auth and roles; protect settings, delete, import/export, and future admin tools separately.

### Phase 5: Frontend Resilience and XSS Hardening

Target: alongside private beta.

- Add global UI fallback for uncaught runtime errors and promise rejections.
- Wrap major workspace renderers in localized try/catch recovery states.
- Continue replacing dynamic `innerHTML` with DOM construction or audited escaping helpers.
- Done: remove runtime frontend script CDNs and replace Stage 6 SortableJS usage with local drag/drop.
- Done: remove inline event-handler attributes and tighten CSP to self-only scripts.
- Tighten CSP further by removing style `unsafe-inline` once inline styles are refactored or nonce/hash-based.

### Phase 6: Future SaaS Track

Trigger: when PageOne becomes multi-user or paid.

- Move from file storage to a database with indexed project/user/query fields.
- Add connection pooling and migration/rollback strategy.
- Move large uploads/assets to object storage with CDN.
- Add roles and permissions.
- Add async job queue for long-running AI/export work.
- Add payment webhook signature verification if Stripe is introduced.
- Start incremental TypeScript migration: `// @ts-check`, JSDoc types, schema-inferred types, then convert shared server modules.

## Recommended Order

1. Phase 0 first: this prevents accidental insecure production boot.
2. Phase 1 next: this limits both cost and abuse even if the shared key leaks.
3. Phase 2 before meaningful tester data accumulates.
4. Phase 3 and Phase 5 can run in parallel.
5. Phase 4 is the bridge from private shared-key testing to any broader beta.
