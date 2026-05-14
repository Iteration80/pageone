# PageOne Private Tester Deployment

## Target

Deploy the existing Node/Express app as a private tester build on Railway, with persistent server storage and a shared access key.

## Railway Setup

1. Create a Railway project from the GitHub repository.
2. Use the default start command:

```sh
npm start
```

3. Add a Railway Volume for persistent app data.
4. Set `DATA_ROOT` to the mounted volume path.
5. Set environment variables:

```sh
APP_SECRET=<long random shared access key>
ACCESS_KEYS='[{"label":"tester-1","key":"long random tester key","role":"tester"},{"label":"admin","key":"long random admin key","role":"admin"}]'
# or ACCESS_KEYS_FILE=<path to JSON array/object with the same records>
AUTH_SESSION_SECRET=<optional separate signing secret; defaults to APP_SECRET>
AUTH_SESSION_TTL_MS=28800000
DATA_ROOT=<railway volume mount path>
GEMINI_API_KEY=<server-side Gemini key>
ANTHROPIC_API_KEY=<server-side Anthropic key, if used>
GEMINI_MODEL=gemini-3-flash-preview
NODE_VERSION=20
```

Optional ops settings:

```sh
LOG_FILE_PATH=<volume path>/logs/pageone.jsonl
LOG_DRAIN_URL=<external HTTPS log collector endpoint>
LOG_DRAIN_TOKEN=<optional bearer token for the log collector>
```

## Smoke Checks

- `GET /health` returns `{ "ok": true }`.
- `GET /api/projects` without a session token returns `401`.
- `POST /api/auth/session` with `{ "accessKey": "<APP_SECRET>" }` returns a short-lived bearer token.
- `GET /api/projects` with `Authorization: Bearer <session token>` returns projects.
- Create a project, restart/redeploy, and confirm the project still appears.
- Import a small `.fountain` script and export one PDF/DOCX before inviting a tester.

## Notes

- API keys are deployment-managed when `APP_SECRET` is set. The Settings modal still supports model selection, but key entry is hidden unless `ALLOW_RUNTIME_API_KEYS=true`.
- Existing local projects are not uploaded automatically. Copy only selected project JSON files into the deployed `DATA_ROOT/projects` directory when you are ready.
- Cloudflare can point a subdomain to the Railway app after the Railway URL passes smoke tests.

## Hardening Checks

- Production startup fails closed when `APP_SECRET`, persistent `DATA_ROOT`, provider keys, or model configuration are missing.
- The browser exchanges `APP_SECRET` once for a short-lived session token. Do not enable `ALLOW_DIRECT_APP_SECRET_AUTH=true` in production unless you need a temporary compatibility bridge for a trusted script.
- Prefer giving testers entries from `ACCESS_KEYS`/`ACCESS_KEYS_FILE` instead of the root `APP_SECRET`. `APP_SECRET` remains a root admin unlock key for emergency access and session signing fallback.
- Access key records support `label`, `key`, and `role`. Use `role: "admin"` only for people who should access settings, script import, project deletion, style deletion/editing, and exports.
- Runtime API key entry should stay disabled in production. Use deployment-managed keys unless intentionally setting `ALLOW_RUNTIME_API_KEYS_IN_PRODUCTION=true`.
- API limits can be tuned with `API_RATE_LIMIT_PER_MINUTE`, `API_WRITE_RATE_LIMIT_PER_MINUTE`, `API_UPLOAD_RATE_LIMIT_PER_10_MINUTES`, `AI_RATE_LIMIT_PER_MINUTE`, `STRICT_AI_RATE_LIMIT_PER_MINUTE`, and `MAX_CONCURRENT_AI_REQUESTS`.
- Daily AI ceilings can be tuned with `AI_DAILY_TOKEN_LIMIT`, `AI_DAILY_COST_LIMIT_USD`, and `AI_DAILY_REQUEST_LIMIT_PER_SESSION`. Defaults are `1500000` tokens, `$20` estimated cost per project per UTC day, and 150 AI requests per session per UTC day.
- If the app is served from multiple trusted origins, set `ALLOWED_ORIGINS` to a comma-separated allowlist.
- Keep at least one durable log path: Railway's managed log drain, `LOG_DRAIN_URL`, or `LOG_FILE_PATH` on a persistent volume copied during backups.
- The browser app no longer depends on runtime script CDNs. Server CSP keeps scripts self-only and blocks inline event-handler attributes.

Before a production deploy, run:

```sh
npm run preflight:private
```

If `SMOKE_BASE_URL` and `SMOKE_ACCESS_KEY` are set, the preflight also runs the deployed private smoke test. Without them, it runs the local security audit, full regression tests, and backup/restore drill.

## Access Key Rotation

For planned tester rotation:

1. Add a new `ACCESS_KEYS` or `ACCESS_KEYS_FILE` record with a fresh random key, stable `label`, and the correct `role`.
2. Redeploy and run `npm run smoke:private` with the new key.
3. Remove the old tester key and redeploy again. Existing signed sessions remain valid until `AUTH_SESSION_TTL_MS` expires.

For a leaked key or suspected active misuse, also rotate `AUTH_SESSION_SECRET` to invalidate all existing sessions immediately. If the root unlock key leaked, rotate both `APP_SECRET` and `AUTH_SESSION_SECRET`.

## Smoke Test

After deploy, run:

```sh
SMOKE_BASE_URL=<railway or custom domain> SMOKE_ACCESS_KEY=<admin access key or APP_SECRET> npm run smoke:private
```

The smoke test checks health, unauthenticated rejection, authenticated project listing, project create/read/delete, and a clean export error for incomplete project data.

## Backups

Before migrations, redeploys with storage changes, or broader tester invites, create a `DATA_ROOT` backup:

```sh
DATA_ROOT=<railway volume mount path> BACKUP_ROOT=<backup destination> npm run backup:data
```

For Railway production, copy the resulting backup off the app volume to durable external storage and do a periodic restore drill against a temporary environment.

Restore into a target `DATA_ROOT` with:

```sh
BACKUP_PATH=<backup directory> DATA_ROOT=<restore target> RESTORE_OVERWRITE=true npm run restore:data
```

Run the local backup/restore drill any time backup scripts change:

```sh
npm run drill:backup
```

Before migrations, bulk imports, storage moves, or wider tester invites, run `npm run backup:data`, copy the backup off the app volume, and confirm `npm run drill:backup` passes locally.
